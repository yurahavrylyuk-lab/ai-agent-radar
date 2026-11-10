# RSS diagnostic persistence — design and sequential TDD plan

2026-11-10. **HUMAN-APPROVED / IMPLEMENTED LOCALLY / BUILDER-TESTED / AWAITING INDEPENDENT ANALYST REVIEW.** Baseline: `7b47919e9527dc7a52d4c50b161f39dd067ec7ad`. The implementation is not merged, published, deployed, or naturally validated. No production read/write, provider call, migration, push, or deployment occurred.

## Evidence and persistence gap

The human reports a successful first natural validation of Idempotent Email Delivery, including cycle `b5317978-7495-4a36-8478-63b0dceade74` on November 10: degraded RSS, healthy Brave, one successful exactly-accounted Gemini request, one accepted/reconciled email. All 19 retained cycles since October 23 show degraded RSS. Earlier body_limit observations do not establish today's failure reason. These are supplied production facts, not live findings from this architecture task. Local PROJECT_STATE/DAILY_SUMMARY still describe earlier release gates; their stale entries are not evidence that the reported validation failed. Do not rewrite historical records or invent fresh production verification.

Actual source flow:

1. `src/services/rssDiscovery.ts:collectRss` updates counts and appends `{feedId, reason, httpStatus?, elapsedMs}` to metrics.outcomes in each feed's finally block. Status is optional and currently included only for reason=http. A transport exception may therefore have reason=http with no status; this feature must not reinterpret it as an observed HTTP response.
2. `src/services/monitor.ts:runBatchMonitoringCycleInternal` assigns `result.rss = rss.metrics`, preserves observations, and derives aggregate RSS health from status and success/failure counts.
3. `src/worker.ts:summarizeRss` projects bounded allowlisted outcomes into createScheduledCycleSummary; this summary is logged. It is not the object persisted by D1MonitoringTelemetry.
4. `src/services/monitor.ts:cycleSnapshot` copies batch.discoverySourceHealth.rss into rssHealth, but never copies result.rss. This is the precise durable-data loss boundary, before sources_complete.
5. `CycleSnapshotV1` has no RSS diagnostic field. validateCycleSnapshot rejects unknown top-level keys. D1MonitoringTelemetry.checkpoint serializes that snapshot into monitoring_cycles.snapshot_json; readCycle parses it through the same strict validator. Existing JSON contains health, not feed outcomes.
6. A later checkpoint replaces snapshot_json, so adding data only to sources_complete is insufficient. It must survive timing callbacks, gemini_complete, email_attempting and final completion, including status-only error completion.

No feature can reconstruct November 10 per-feed reasons that were never retained. Missing diagnostics on historical rows means unavailable, never healthy or zero failures.

## Choice and alternatives

**A — recommend an optional versioned rssDiagnostics object in CycleSnapshotV1.** Existing monitoring_cycles row supplies cycle_id and scheduled_at. No separate association, table or extra database write is needed. Current migration0008 checks JSON validity/8192 bytes, not JSON field names; compatibility work belongs in TypeScript validators/producers/readers.

**B — separate diagnostics table:** independently-sized rows and possible independent retention, but requires a reviewed migration, association, additional persistence operations and partial-write policy. Existing bounded JSON can carry the requested data; none of those costs is justified here.

**C — log-only:** already approximately implemented. Logs can aid live investigation but do not satisfy diagnosis from retained D1 cycles after logs disappear. More logging is not the solution. Use one bounded warning only to expose diagnostic projection omission, not as the ordinary historical store.

No migration or schema_version bump. Add optional rssDiagnostics to version1 with its own version1 contract. Preserve strict unknown-key rejection elsewhere. Older rows remain accepted without materializing fake RSS outcomes. Older application readers will reject the new field: backward-readable data is not forward-compatible old reader behavior.

## Exact proposed contract

Define these types beside the existing cycle telemetry contracts in `src/services/monitoringTelemetry.ts`; do not change RSS collection types or the registry.

```ts
type RssDiagnosticFeedId =
  | 'openai_news' | 'github_changelog' | 'cloudflare_ai' | 'chrome_developers';
type RssDiagnosticReason =
  | 'disabled' | 'configuration' | 'http' | 'redirect' | 'timeout'
  | 'body_limit' | 'encoding' | 'parse' | 'structure' | 'ok';
type RssDiagnosticsV1 = {
  version: 1;
  status: 'recorded';
  collectionStatus: 'disabled' | 'configuration' | 'collected';
  health: 'healthy' | 'degraded' | 'unavailable';
  configuredFeeds: number;
  attemptedFeeds: number;
  succeededFeeds: number;
  failedFeeds: number;
  outcomes: Array<{
    feedId: RssDiagnosticFeedId;
    reason: RssDiagnosticReason;
    httpStatus?: number;
    elapsedMs: number;
  }>;
} | {
  version: 1;
  status: 'unavailable';
  reason: 'invalid_metrics' | 'snapshot_budget';
};
// Add to CycleSnapshotV1:
// rssDiagnostics?: RssDiagnosticsV1;
```

Absent field means no diagnostic evidence: historical record, collection not reached, or no space even for the bounded omission marker. It does not establish why. `unavailable` marks a known producer-side omission; it never represents a persisted-data integrity violation. Initial cycle creation remains unchanged and has no RSS field. Recovery-only invocations that never collect RSS must not borrow another cycle's outcomes.

Rules:

- Exact keys for each union branch and outcome; optional httpStatus may be absent, never undefined/null in persisted JSON. No arbitrary payload fields.
- Counts are safe integers0–5; attempted<=configured, succeeded+failed=attempted, outcomes.length=attempted. Feed IDs unique and emitted in current approved registry order. Known current IDs only on the producer. Keep the v1 parser's historical ID allowlist stable if future registry versions retire feeds; expansion requires review rather than breaking historical rows.
- For collected metrics, attempted=configured; succeeded equals outcomes with reason=ok; all other collected outcomes count as failed. Current collected outcomes use ok/http/redirect/timeout/body_limit/encoding/parse/structure. disabled/configuration describe collection with no attempts/outcomes. Do not invent a feed failure for configuration errors that happen before attempts.
- For collected metrics health is unavailable when succeeded=0, degraded when succeeded>0 and failed>0, otherwise healthy. Disabled/configuration is unavailable, matching current aggregation. Match root rssHealth whenever non-null; retained error-finalization diagnostics may coexist with root rssHealth=null because the error result has no batch.
- Producer projects elapsedMs by flooring and capping finite nonnegative values at5000; this is a diagnostic saturation bound, not a claim the timeout always completes exactly on time. Negative/nonfinite/wrong-type values make diagnostics unavailable. Persisted validator accepts integers0–5000 only, no coercion/clamping during reads.
- Optional httpStatus is an integer100–599, permitted only with reason=http under the current collector contract. Missing status stays missing. A malformed present status makes diagnostics unavailable; do not fabricate a status.
- Unknown/duplicate/malformed IDs, invalid reasons, impossible counts or inconsistent health invalidate the diagnostic object as a whole. Do not silently drop a failed feed and retain misleading success counters.
- Configuration-path metrics may contain an out-of-range configured count; represent invalid_metrics rather than coercing that count or changing the acquisition result.

## Size, privacy and serialization

Cap canonical UTF-8 JSON for rssDiagnostics at1024 bytes, including all fixed keys. A conservative five-outcome envelope using the longest current ID/reason, HTTP599 and elapsed5000 is628 bytes (size envelope only, not a valid duplicate-ID fixture). Current four-feed valid records are smaller. Retain the total snapshot cap8192 and D1 constraint unchanged.

Use explicit primitive projection into a fresh plain object; never JSON.stringify/spread untrusted RSS metrics wholesale. No article text, snippets, titles, URLs, response bodies, credentials, headers, exception messages or stack traces. No new cycle identifier inside the field; monitoring_cycles.cycle_id is authoritative.

Proposed helper signatures:

- `projectRssDiagnostics(metrics: unknown, health: RssDiscoverySourceHealth | null): RssDiagnosticsV1 | undefined`: undefined only when no metrics exist; returns invalid_metrics for malformed diagnostic inputs. Never mutates result.rss or observations.
- `validateRssDiagnostics(value: unknown): RssDiagnosticsV1`: strict persisted-contract validation, throws bounded error.
- `attachRssDiagnostics(base: CycleSnapshotV1, diagnostics: RssDiagnosticsV1 | undefined): { snapshot: CycleSnapshotV1; omission: 'invalid_metrics' | 'snapshot_budget' | null }`: validate the unchanged core snapshot first. Attach valid diagnostics only if the complete canonical result fits8192; otherwise try the tiny snapshot_budget marker, otherwise keep the valid core and emit a bounded warning. Never remove accounting/delivery/latency/Threads fields or raise limits to make room.

The attach helper's input base excludes rssDiagnostics. An invalid existing core must still throw. Limit catch handling to the explicitly identified producer diagnostic-validation error. JSON serialization/core validation/persistence errors must not be relabeled as harmless RSS errors. Strict persisted parsing rejects malformed RSS fields as integrity violations; it must not silently strip corrupt stored evidence.

Require a maximum-valid combined snapshot fixture with latency, analyzerFailover, Threads and deliveryLedger. Existing independently bounded fields are Threads<=1536, analyzerFailover<=1024 and deliveryLedger<=1024; other core fields are bounded primitives/arrays. Builder must prove actual canonical maximum fixture size with the RSS field and exact8192 boundary behavior. Do not assume individually fitting fields imply total fit. The explicit budget guard is mandatory regardless of fixture headroom.

## Checkpoint and failure safety

Current sources_complete failure catches clear prepared analysis and stop provider admission. Preserve this behavior for real core-schema, D1-write, affected-row or read integrity failures. Do not add a fallback database write, retry loop, swallowed D1 error or new analysis admission path.

Diagnostic-only sanitation happens before calling the persistence checkpoint. If it cannot produce a valid bounded field, persist the valid core plus omission marker where possible; continue with the already-valid RSS candidates and unchanged pipeline. Emit at most one redacted warning per cycle containing only cycleId and invalid_metrics/snapshot_budget. Add an optional bounded warning callback at the monitor/Worker boundary for this purpose; warning sink failure cannot affect monitoring. Do not include the offending input. This is deliberate optional-field omission, not permission to ignore persistence failure.

Normal checkpoints derive the field from result.rss. In the Worker retain the latest projected RSS diagnostic object for this invocation. Carry it forward when a later error/status-only result lacks RSS data, using the same attach/size gate; timing callbacks already spread latestSnapshot and must preserve it. Never replace a recorded object with fabricated zero outcomes merely because a later finalizer has no batch. If final core growth makes it impossible to retain diagnostics, persist snapshot_budget where possible and report the warning; explicitly acknowledge that single-row replacement then loses that detailed evidence. Normal maximum-shape tests must demonstrate this is not the routine path. No historical backfill, new D1 read or merge query.

Keep the retention cache invocation-local and cycle-bound. All stages including sources_complete, repeated source timing updates, gemini_complete, email_attempting, successful completion and catch completion must be tested. Already-existing best-effort final checkpoint handling is unchanged; this task does not redesign telemetry durability or content continuity. D1MonitoringTelemetry's current strict write/read path should work unchanged once its serializer/parser imports recognize the optional field.

## Expected implementation scope

Runtime modifications: `src/services/monitoringTelemetry.ts` (contract/projection/strict parsing/byte gate), `src/services/monitor.ts` (snapshot attachment and optional omission warning callback), `src/worker.ts` (cycle-local retention, bounded warning, final/catch carry-forward). No new runtime service required. `src/types/index.ts` and `src/services/d1MonitoringTelemetry.ts` are inspected integration surfaces, not planned edits unless a concrete type exposure requires a narrowly reviewed adjustment.

Tests: modify `test/monitoringTelemetry.test.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`, `test/rssDiscovery.test.ts` only for relevant fixture coverage; extend existing `test/workerd/geminiTelemetry.worker.ts` and `test/workerd/geminiTelemetry.test.mjs` with provider-free RSS persistence cases. Reuse its existing isolated D1 config. Do not modify production Wrangler configuration, migrations, registry, collector behavior, ledger or quotas.

Shared contention: monitoringTelemetry.ts, monitor.ts and worker.ts are also likely touch points for General Bounded Failure-Cause Diagnostics and Telemetry-Degraded Content Continuity. Coordinate exact baselines and re-review overlapping hunks; this design adds only RSS evidence. Brave Request Timeout + Bounded Response remains the next previously recorded roadmap feature; this diagnostic proposal does not reorder it or activate a second implementation cycle. Workerd changes are scoped tests, not a CI project.

## Sequential RED → GREEN implementation plan

No tasks are authorized to execute until human review. Use the existing installed test tools, no downloads or real feed/provider requests.

### Task 1 — Contract, privacy and byte gate

Files: monitoringTelemetry.ts and test/monitoringTelemetry.test.ts.

RED: old snapshot round-trip; healthy/partial/multiple failures; optional HTTP status; malformed/unknown/duplicate feed ID, reason and counters; elapsed negative/NaN/infinite/fractional/oversized; arbitrary sensitive extra fields; invalid persisted field; valid maximum combined snapshot and total byte overflow. Assert exact projected fields and immutable inputs.

Command: `./node_modules/.bin/tsx --test test/monitoringTelemetry.test.ts`. Expected RED: no optional-field contract/helpers; strict parser rejects valid extension.

GREEN: add the three specified helpers and optional exact-key inclusion; sanitize only outbound diagnostics, keep strict read/core validation. Freeze v1 historical allowlists. Assert old serialized rows remain unchanged, wrong versions rejected,1024/8192 byte caps preserved, core errors still throw. Verify with the same command and `npm run build`. Proposed commit: `feat: define bounded RSS diagnostic snapshot contract`.

### Task 2 — Collection-to-source-checkpoint projection

Files: monitor.ts, test/batchMonitoring.test.ts, relevant assertions in test/rssDiscovery.test.ts; consume Task1 helpers.

RED: mock feeds produce healthy, one failure, multiple failures, HTTP, timeout, body_limit, parse, encoding, structure and redirect outcomes; existing collector fixtures must assert original reasons without changing acquisition. Spy sources_complete to require the failing approved feed ID/reason and unchanged counts/health. Invalid optional metrics must preserve valid observations/prepared candidates and the existing analyzer invocation count. Missing metrics produces absent diagnostics, not zero-success claims.

Commands: `./node_modules/.bin/tsx --test test/rssDiscovery.test.ts test/batchMonitoring.test.ts`.

GREEN: attach diagnostics during cycleSnapshot construction; thread bounded omission warnings through an optional callback without changing candidate selection or source health. No extra HTTP or database operation. Tests pin four configured feeds, max5 items/feed, current1MiB body limit,5s timeout/no retry/no redirect behavior, and all existing quotas. Verify same commands. Proposed commit: `feat: include RSS outcomes in cycle checkpoints`.

### Task 3 — Carry-forward and failure-sensitive checkpoints

Files: worker.ts, test/workerConfiguration.test.ts, test/batchMonitoring.test.ts; helper wiring in monitor.ts only where needed.

RED: timing checkpoint and final completion retain source RSS evidence; status-only catch completion retains same-cycle diagnostics; recovery-only next invocation cannot inherit them. Malformed optional metrics and size fallback preserve normal selection. Genuine D1 checkpoint failure and invalid core still block analysis as before. A warning callback that throws cannot alter delivery. Unknown raw messages must never enter warnings.

Command: `./node_modules/.bin/tsx --test test/workerConfiguration.test.ts test/batchMonitoring.test.ts test/monitoringTelemetry.test.ts`.

GREEN: hold latest diagnostics within runScheduledMonitoring, carry into final/catch snapshots via size gate, deduplicate bounded warning per cycle. Keep latestSnapshot/accounting and all email error paths otherwise intact. Verify same command plus `./node_modules/.bin/tsx --test test/dailyDigestReliability.test.ts test/emailDeliveryWorker.test.ts` after confirming current filenames. Pin daily identity, one Resend request/invocation, dispatch slots, accepted reconciliation and Gemini/Luna admission unchanged. Proposed commit: `fix: retain RSS diagnostics through final cycle checkpoints`.

### Task 4 — Durable local D1 proof without logs

Files: existing test/workerd/geminiTelemetry.worker.ts and test/workerd/geminiTelemetry.test.mjs. No production endpoint added.

RED: seed cycle with one failed approved feed, execute real D1MonitoringTelemetry sources_complete and subsequent completion, terminate/restart Workerd using the same isolated persistence, discard captured logs, then readCycle and directly inspect snapshot_json. Assert exact cycle ID, counts, health, failing feed/reason and optional status. Read an old row without diagnostics successfully. Tamper a local test row with structurally invalid diagnostics and require strict read failure. Cover failed source checkpoint without opening analyzer/email bypass.

Command: `node test/workerd/geminiTelemetry.test.mjs` using its existing local config/temporary persistence; synthetic telemetry only, no live provider calls. Expected RED: per-feed field absent from persisted record or lost on completion.

GREEN: add test-only routes/fixtures around actual adapter; use real local D1 operations rather than a memory-only claim. No migration changes; existing0008 schema suffices. Prove source and final stages preserve evidence and old history remains readable. Repeat harness after restart. Proposed commit: `test: prove durable RSS diagnostic readback in D1`.

### Task 5 — Full verification and review handoff

Run focused tests above, `npm test`, `npm run build`, `npm run worker:typecheck`, the existing RSS Workerd test and email-delivery Workerd harness, inspecting package scripts first. No live diagnostic request or monitoring invocation. Verify source diff contains only approved telemetry/test changes and no new migration/config/collector/ledger modifications. Record actual counts/results, not predictions. No unrelated cleanup, CI change or automatic publication.

Before implementation commits, obey current branch/approval rules. Stage only scoped files/hunks. Final Builder documentation records implemented/offline-tested/awaiting Analyst; Analyst reviews exact commit, then Architect disposition, human release approval and natural validation. No deploy or migration is implied by design approval.

## Independent Analyst acceptance criteria

All eighteen requested test categories must be demonstrated: healthy; single/multiple failed feeds; HTTP/timeout/body-limit/parser/encoding; absent status; unknown IDs/reasons; invalid/excess elapsed; byte bounds; legacy snapshots; serialize/parse compatibility; real D1 restart/readback; optional diagnostic failure versus actual checkpoint failure; email/accounting invariants; unchanged request/retry/quotas.

Require actual durable per-feed lookup after logs are unavailable, including final replacement and error-finalization paths. Reject invented statuses, silent corrupt-record sanitization, raw content leakage, relaxed core validators, dropped valid candidates, changes to email ledger/accounting or increased source requests. Verify feed health reflects successful collection, not candidate volume; ok with zero valid articles is not a feed failure. Verify fields remain absent for historical cycles, never retrospectively populated from earlier body_limit reports.

## Operator query, risks and rollback

Proposed read-only query for a future independently authorized investigation (not executed here):

```sql
SELECT cycle_id, scheduled_at, phase,
       json_extract(snapshot_json, '$.rssHealth') AS rss_health,
       json_extract(snapshot_json, '$.rssDiagnostics') AS rss_diagnostics
FROM monitoring_cycles
WHERE cycle_id = ?;
```

Interpret missing field as unavailable, recorded outcomes as bounded observations and unavailable marker as a diagnostic projection/size failure. Reasons retain existing collector semantics and are not proof of ultimate upstream cause.

Risks: optional-field mistakes could trigger existing fail-closed checkpoints; strict read compatibility can break older deployed tooling; later replacement can erase data without carry-forward; feed-registry drift can invalidate old records; cap saturation loses exact elapsed duration. Tests and stable versioned contracts address these without runtime redesign.

Rollback must retain a parser that accepts rssDiagnostics. Stopping new emission is safe with a compatible reader; reverting wholesale to the current strict old parser is not automatically safe for new rows. Do not delete retained fields, rewrite historical JSON or restore the whole DB to make an old reader work. No migration/down migration is needed. Persisted corruption remains a surfaced integrity error. Release requires human approval after independent review; natural validation may confirm future outcomes but cannot repair missing historical evidence.

**AI_RADAR_RSS_DIAGNOSTIC_DESIGN_READY — stop for human design review and explicit implementation authorization.**
