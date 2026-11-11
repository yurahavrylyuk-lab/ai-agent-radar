# RSS Structural Subreason Observability — design and sequential TDD plan

Date: 2026-11-11. Status: DESIGN ONLY — awaiting human design review and separate implementation authorization. No Builder work is authorized by this document.

## Evidence and bounded objective

Inspected checkout HEAD: `d9573439542421b65d1a6d807c97f724c3b7252e`. Human-supplied deployed version: `01b2ba93-0290-495d-8f22-4f6b83b686e2`. No production inspection was performed for this design.

The supplied independent Analyst result is `AI_RADAR_RSS_STRUCTURE_CAUSE_PARTIALLY_IDENTIFIED`. Natural cycle `25b2965c-ed8d-4d79-a2e2-a09a79fb696f` reported `structure` for openai_news (47 ms) and cloudflare_ai (13 ms), with GitHub and Chrome succeeding. Supplied snapshot/envelope sizes were 2,219/415 bytes. RSS persistence, Brave, Gemini accounting, and email passed natural validation according to the supplied evidence.

The synthetic irrelevant `content:encoded` experiment demonstrates a potential false negative at 8,193 bytes versus 8,192. It does not establish either feed's production cause. A subreason identifies the rejecting predicate, not the offending element, feed content, or ultimate upstream cause. No historical subreason can be reconstructed from existing `structure` alone.

Repository governance includes historical review/plan records predating this supplied release evidence; these are not fresh Analyst findings for this task. No separate current investigation artifact was located in the inspected docs. Preserve that distinction and the supplied evidence rather than silently revising historical records. This design does not activate a new implementation cycle or overwrite the historical active-plan/review files.

## Decision and exact branch mapping

Add a closed structural subreason enum with these eleven values. Locations refer to `src/services/rssDiscovery.ts` at the inspected HEAD:

- `invalid_clock`: line 109, invalid/non-Date `now`.
- `element_limit`: line 120, element count exceeds 10,000.
- `depth_limit`: line 120, stack depth would exceed 32. When both predicates hold, choose element_limit first, matching current expression order.
- `attribute_limit`: line 124, an attribute value exceeds 8,192 UTF-8 bytes.
- `multiple_roots`: line 130, an open tag would create a second root.
- `text_limit`: line 139, cumulative node text exceeds 8,192 UTF-8 bytes. Text and CDATA deliberately share this predicate/code, including irrelevant elements.
- `doctype`: line 150, unsafeDeclaration is set and the earlier parseFailure check is false.
- `missing_root`: line 150, no root after parsing, after parseFailure and unsafeDeclaration checks.
- `unclosed_elements`: line 150, residual stack after parsing, after the preceding checks.
- `channel_cardinality`: line 156, RSS has other than one direct, unnamespaced channel.
- `unsupported_root`: line 162, root local-name/namespace is neither supported RSS nor supported Atom. Name and namespace share the existing rejection predicate.

Preserve existing exception precedence exactly. At the post-parse guard, parseFailure still yields parse without a subreason; otherwise evaluate the structural predicates in existing order. An earlier typed exception from a parser callback still propagates as it does today, even if an error callback previously set parseFailure. Do not alter control flow to force a desired diagnostic category.

Some defensive guards (especially missing root and residual stack) may be masked by saxes parse errors on real XML. Test actual parser behavior first; do not relabel malformed XML or relax saxes to make defensive branches reachable.

The internal structure error at line 200 for invalid/oversized Content-Length is NOT a parser structural outcome: the existing body-reader catch maps it to body_limit. Preserve that mapping and omit structural subreason. It does not need another enum value.

If no known branch supplies a precise code, retain reason=structure without subreason. Do not invent `other`, infer from exception strings, or substitute a likely cause.

## Typed propagation and scope

Define a readonly closed literal list and derived `RssStructuralSubreason` type in `src/types/index.ts`, shared by producer and telemetry validation. This is a small diagnostic contract, not a parser framework.

Extend `RssDocumentError` with readonly optional `subreason`. Constructor overloads permit parse without a subreason and structure with an optional typed subreason. Keep the existing fixed error message; no content interpolation. Existing unattributed internal body-reader errors remain representable.

Add optional `subreason?: RssStructuralSubreason` to the RSS outcome type. Runtime checks remain mandatory despite TypeScript: only reason=structure may have an own subreason property, and its value must be an exact allowlisted string. No trimming, coercion, arbitrary enum fallback, or explicit undefined/null.

Flow: parseRssFeed → typed RssDocumentError → collectRss per-feed outcome → RssCycleMetrics → unchanged monitoring result → explicit RSS diagnostic projection → optional RSS envelope in CycleSnapshotV1 → existing monitoring_cycles.snapshot_json.

In collectRss, initialize subreason independently for each feed, copy only from a known typed structural error at the parser boundary, and include it only if the final outcome remains structure. Outer timeout override must remove it. Body_limit, parse, HTTP, timeout, configuration, disabled and successful outcomes have none. Unknown exceptions remain governed by current classification. Feed isolation, item isolation and one request per feed are unchanged.

Update the Worker scheduled-log summary's explicit safe projection to preserve only validated structural codes. Logs are supplementary; durable snapshot readback is the acceptance evidence. Never serialize errors, raw outcomes by spread, or arbitrary properties.

Expected runtime changes, after authorization only:

- `src/types/index.ts`: closed enum/type and optional outcome field.
- `src/services/rssDiscovery.ts`: typed codes at existing guards and bounded propagation.
- `src/services/monitoringTelemetry.ts`: optional field projection and strict validation.
- `src/worker.ts`: bounded scheduled-log summary field, if needed by its existing explicit projection.

Inspect but do not change `src/services/monitor.ts`, the D1 adapter, `src/config/rssSources.ts`, or migration files unless a concrete scope amendment is approved. Existing flow already transports the RSS object and complete snapshot. No dependencies or generic diagnostic framework.

## Persistence, compatibility and integrity

Choose an optional field under existing RSS diagnostic version 1. A new version would duplicate the envelope/parser without needing different semantics. CycleSnapshotV1 remains unchanged except the nested typed outcome. Current storage is bounded JSON, not separate per-outcome columns; no D1 schema migration is needed.

New readers accept snapshots without RSS diagnostics, historical v1 recorded outcomes without subreason (including structure), and existing unavailable markers. Never backfill history. Old strict readers cannot read newly extended records: code rollback must retain the extended reader or use a compatible release. Historical backward readability is not forward readability by old binaries.

Update both producer and persisted exact-key validation. Allowed outcome keys are the existing required keys plus applicable httpStatus and applicable subreason. httpStatus remains restricted to HTTP outcomes; subreason is restricted to structure. Preserve feed allowlist/order/uniqueness, reason allowlist, counters, elapsed bounds, recorded/unavailable branch keys, nested health derivation and root/nested health agreement.

An invalid optional producer envelope, including unknown codes or forbidden fields, becomes the existing unavailable/invalid_metrics marker. An over-budget envelope follows existing snapshot_budget behavior. Do not silently drop one corrupt field and claim recorded diagnostics. Persisted invalid data must continue to fail strict parsing; never apply producer sanitization to stored corruption. Core snapshot validation and real D1 checkpoint failures retain their current behavior and must not be swallowed as optional-data omission.

Maintain UTF-8 JSON byte accounting: diagnostic envelope ≤1,024 bytes and full snapshot ≤8,192 bytes. The longest enum value is channel_cardinality; its extra serialized property costs 34 bytes per outcome, at most 170 bytes for five outcomes. Measure actual serialization in tests rather than relying on this estimate for admission. No cap increase. Test both maximum valid diagnostics and core headroom, as well as budget overflow fallback. The supplied 415/2,219-byte production measurements are historical evidence, not a blanket guarantee for all future snapshots.

Privacy: only fixed enum codes accompany already approved bounded feed IDs/reasons/counters/timing. No XML, field names from XML, article content, URLs, headers, exception messages, stack traces, or provider data. Neither classification nor persistence depends on external lookup.

## Checkpoint carry-forward

Keep the existing RSS attach helper and Worker's latestSnapshot carry-forward. Preserve the entire validated RSS envelope, including subreason, across later checkpoints that omit fresh diagnostics, including final email/terminal snapshots. Explicit new valid diagnostics retain existing precedence. Each attachment rechecks the total snapshot budget and existing root/nested consistency. Do not add extra D1 reads or another cache.

Preserve existing one-shot omission warnings, including final carry-forward/budget omission; no warning per field or per checkpoint. Genuine persistence failures remain distinguishable and retain their safety behavior.

## Sequential RED → GREEN implementation plan

Native Builder execution only after separate approval; one independent final Analyst review. Each task begins with focused failing assertions against the pre-change behavior, records the actual failure, then makes the smallest change and reruns the focused suite. Do not add assertions already passing and call them RED. Existing regression cases may stay green throughout.

1. **Typed parser codes.** Extend `test/rssDiscovery.test.ts` before touching types/parser. Use synthetic valid RSS/Atom around each reachable rejecting predicate: invalid clock; supported/unsupported root and namespace; zero/two channels; DOCTYPE; depth 32/33; element count 10,000/10,001; attributes at 8,192/8,193 UTF-8 bytes; text and CDATA at both limits, including irrelevant content:encoded and multibyte content. Assert same old reason/acceptance plus new exact code. Cover cumulative text across chunks and combined-limit precedence. Malformed XML must keep its actual baseline classification. For defensive branches masked by saxes errors, document reachability and use narrow test-only event-stream mocking if necessary; do not add production injection APIs or invent an XML fixture that cannot hit the guard. Add the enum/error contract and label existing branches only.

2. **Collector and summary propagation.** Extend collector tests and `test/workerConfiguration.test.ts`: per-feed typed propagation, subsequent healthy feed still collected, invalid individual article isolated, unclassified structure omits code, parse/body-limit/HTTP/abort outcomes never get a code, timeout override clears a previously observed code, one fetch per feed/no retries. Canary exception messages/content never enter metrics/log summaries. Then add minimal collector and summary projection changes.

3. **Strict telemetry contract.** Extend `test/monitoringTelemetry.test.ts`: all enum values round-trip, old v1/no-RSS/unavailable fixtures remain accepted; reject unknown/nonstring/null/undefined code, extra keys and code on every non-structure reason. Test root/nested health conflicts, exact-key semantics, invalid optional producer omission versus persisted corruption rejection, maximum valid UTF-8 sizes, 1,024/8,192 boundaries and existing core headroom. Add explicit projection and validation, not permissive object spreading. Unknown future enum values require a separately reviewed reader update.

4. **Cycle and real isolated D1 persistence.** Extend `test/batchMonitoring.test.ts`, relevant `test/workerConfiguration.test.ts`, and existing `test/workerd/geminiTelemetry.worker.ts` / `test/workerd/geminiTelemetry.test.mjs`. Synthetic typed failure must survive collection, intermediate checkpoints, final snapshot, real local Workerd/D1 write, process restart and strict readback without relying on captured logs. Include historical snapshots, corrupt stored subreason, optional omission warning once, final budget omission, and genuine checkpoint failure behavior. Verify no extra provider requests, no quota/accounting changes, unchanged candidate selection, and email terminal checkpoint carry-forward. Use existing seams; unexpected runtime plumbing changes require explicit amendment.

5. **Final offline verification and handoff.** Inspect scripts/harnesses before execution. Run focused tests, full `npm test`, `npm run build`, and existing Worker typecheck using installed tools only; account for generated type output and exclude unrelated changes. Run the existing isolated Workerd telemetry harness (`node test/workerd/geminiTelemetry.test.mjs`) and relevant RSS/email Workerd regression harnesses after confirming their local-only setup. Include `test/dailyDigestReliability.test.ts`, `test/emailDeliveryWorker.test.ts`, and `test/workerd/emailDelivery.test.mjs` regression coverage. No live monitor/provider scripts, downloads, or production bindings. Record actual command results, exact changed files, meaningful RED evidence, any unreachable-branch findings, and diff/whitespace inspection. No tests were run as part of this design-only task.

## Analyst, release and natural validation gates

Independent Analyst must review the exact Builder commit and demonstrate:

- Every existing structural source branch is mapped or explicitly retains its body_limit classification; no reason/precedence or parser-acceptance drift.
- Enum is closed at all boundaries, no content/message leakage, and no inappropriate subreason survives overrides.
- Historical v1 readability, strict corruption rejection, unchanged health consistency, bounded JSON and producer omission are proven.
- Real isolated Workerd restart/readback, final carry-forward, warning-once and genuine persistence-failure tests pass.
- Provider counts/accounting, candidate/digest selection and email/idempotency behavior remain unchanged; only authorized files changed.

Gates: human design approval and implementation authorization → bounded Builder work → independent Analyst review → Architect disposition → separate human publication/merge approval → separate deployment approval. Record production version and exact release commit at deployment; this document grants neither approval. Record compatible rollback version because old strict readers may reject extended records.

After approved deployment, use the next naturally scheduled cycle; do not schedule or manually trigger monitoring. With separately approved read-only production evidence access, read the final monitoring snapshot and verify cycle/release identity, RSS feed ID, reason=structure, allowlisted persisted subreason, root/nested health, byte caps, and final checkpoint preservation. Check existing provider/accounting/email evidence for regressions without dispatching anything extra. Subreason success does not require RSS health to become healthy.

If no structural failure occurs, report overall cycle verification separately and mark natural structural-subtype validation INCONCLUSIVE / awaiting a natural occurrence. Do not fabricate a production failure, replay a cycle, or reconstruct historical missing fields. Synthetic offline evidence remains useful but does not substitute for this natural-path observation.

## Preserved constraints and residual risks

No changes to registry/URLs, 8,192-byte fields, 1 MiB body, 5-second timeout, depth 32, 10,000 elements, sequential fetching, redirect/retry policy, Brave bounds, Gemini/Luna accounting, email ledger/idempotency, Cron, secrets, Threads/X status or schema. No irrelevant-element acceptance correction, Brave Request Bounds or autopilot work.

Residual limitations: code identifies the first encountered rejecting predicate, not feed-specific root cause or field contents; multiple simultaneous violations obey existing precedence; defensive parser guards may be unreachable under saxes; historical subreasons remain unknown; old readers lack forward compatibility; natural recurrence timing is unknown. These are explicit constraints, not unresolved design decisions. Human review and implementation authorization remain pending.

## Design artifact verification

Only this design/TDD document is added. Protected historical untracked specification: `docs/superpowers/specs/2026-10-12-batch-gemini-daily-radar-design.md`, SHA-256 `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`. Final checkout preservation is checked separately in the Architect handoff. No runtime/test edits, Git mutation, live feed/provider call, production query, migration or deployment is part of this task.
