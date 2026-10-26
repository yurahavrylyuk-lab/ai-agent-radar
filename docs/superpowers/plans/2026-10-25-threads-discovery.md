# Threads Discovery Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for later native Builder execution, task by task, when authorized. No subagents or worktrees for this planning task. Checkbox steps below are future work, not completed implementation. One independent final Analyst review follows Builder verification.

**Goal:** Add optional, bounded official Threads public keyword discovery to the existing shared discovery/analyzer/digest flow.

**Architecture:** A focused collector returns application-owned BatchObservations and bounded metrics. Brave, RSS and Threads combine before shared URL/alias/history dedupe, then deterministic three-source selection produces one PreparedBatch for the unchanged Gemini/Luna coordinator and one-email finalizer.

**Tech Stack:** Existing Node 24 / TypeScript / node:test + tsx; native Cloudflare Worker fetch, URL, TextEncoder/TextDecoder, AbortController; existing local Workerd tooling. No new package or SDK.

**Spec:** `docs/superpowers/specs/2026-10-25-threads-discovery-design.md`, human-approved at `989f2eb462e912905bb9eba58dd13c986fe00c59`, based on governance main `aed8263256fd38689ac1febea39f76689df4d035`. The spec's original pending-approval text is historical; this plan records the subsequent human approval without rewriting the approved artifact.

## Global Constraints

- Planning checkpoint stays on `codex/threads-discovery-design`; only this plan and minimal backlog.md/plan.md changes are committed. No implementation branch is created now. Future execution branch authorization remains separate; do not implement on main.
- Production remains recorded source `bd2a3220611e5992b226e6cf7c0f9ec0b92c18ac`, Worker `6a1dcef4-e5cc-414a-aa89-6bf194fa5b60`, deployment `f0dbb968-a9b0-4719-9614-035571b1e917`; failover DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION. Cron `0 8 * * *`; 0009 applied; 0004 intentionally unapplied. Natural validation is separate, pending, and does not block offline work.
- Fixed queries in order: `ai_agents` → `AI agents`, `claude_code` → `Claude Code`, `codex` → `Codex`. Three requests, five examined positions/query, fifteen observations maximum. Invalid positions consume their slot.
- Fixed `GET https://graph.threads.com/v1.0/keyword_search`; `search_type=RECENT`, `search_mode=KEYWORD`, `limit=5`, `fields=id,text,permalink,timestamp`. Freeze collection-time Unix until; since=until−259200 seconds; inclusive 72-hour validation. No paging, retries, redirects, secondary fetches or backfill.
- Request deadline 3,000 ms including headers/body; collector budget 9,000 ms. Success body <=131,072 decoded bytes; non-success error body <=8,192 bytes. Use `redirect: "manual"` and reject 3xx (existing Workerd evidence shows `redirect: "error"` is unsupported). No timing/cost ceiling increases.
- Raw pool cap remains 50 candidates. **There is no aggregate 32-KiB raw-pool cap; do not add one.** Submitted count <=24, PreparedBatch prompt <=12,288 UTF-8 bytes.
- Preserve one logical analyze invocation, existing Gemini V2 attempts/accounting, exact Luna gate, replay/notification history, source integrity, current Batch relevance/labels, at most four stories and one email attempt. No Threads prompt, analyzer, digest or email path.
- Secret `THREADS_ACCESS_TOKEN`; flags `THREADS_DISCOVERY_ENABLED`, `THREADS_PUBLIC_SEARCH_APPROVED` default false; actual UTC expiry `THREADS_TOKEN_EXPIRES_AT`. Only explicit string `"true"` enables flags. Invalid/missing enabled-source configuration isolates Threads, not the cycle. No token in vars, source, D1 or telemetry; no refresh machinery.
- No migration, D1 schema change, X dependency, 0004 change, public-search approval automation, semantic event dedupe, engagement/replies/posting, account monitoring, idempotent delivery, Compact Analyzer Contract, renderer/failover/quota redesign or cleanup.
- All implementation verification is offline with fixture fetches, including local Workerd. No live provider/feed calls, credential configuration, production D1 access, manual monitoring, push/PR/merge/deployment is implied by this plan.
- Every runtime task: RED → minimal GREEN → focused verification → scoped commit. Full suite exactly once in Task 5 unless failures require rerun; do not run it per task. No installs/downloads. Inspect scripts before execution.
- Protected untracked `docs/superpowers/specs/2026-10-12-batch-gemini-daily-radar-design.md` stays untouched/excluded, SHA-256 `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`.

## Review Focus

1. Apparent configuration is not proof of public search: approval false gives zero requests; an HTTP 200 restricted-looking/empty response with approval true must never establish verified public access. Operator revocation disables collection; undetectable restriction stays an explicit release limitation (Tasks 1, 4, 5).
2. Slow/erroring Threads cannot abort healthy Brave/RSS or extend existing analyzer deadlines; body stalls and total-budget exhaustion need actual cancellation evidence (Tasks 1, 3, 5).
3. Saturated Threads must not starve Brave/RSS; its shared hostname must not accidentally impose a hard two-post cap (Task 2).
4. Identical canonical URLs and aliases from three sources must merge once and consult every history alias; different story URLs must not be guessed equivalent (Tasks 2, 3).
5. Missing/malformed/expired credentials fail closed for Threads, preserve other sources and truthful outage/telemetry, and never leak through errors or summaries (Tasks 1, 3, 4).

## File map and task order

Keep approved naming `threadsSources.ts`, matching existing `rssSources.ts`, rather than introduce a second registry name. Preserve the recovered five-task decomposition: candidate preparation and selection share Task 2 so Threads admission and ownership land together; monitor integration follows in Task 3, with Worker/telemetry isolated in Task 4. This refines the suggested boundaries without adding tasks or restarting the plan.

| Files | Responsibility / tasks |
| --- | --- |
| NEW `src/config/threadsSources.ts` | Fixed registry, endpoint and limits (1) |
| NEW `src/services/threadsDiscovery.ts` | Config gate, bounded fetch, parser/normalization and collection metrics (1) |
| `src/types/index.ts` | Explicit provenance, collector/result/source-health/pipeline metric contracts (1–3) |
| `src/services/batchCandidates.ts` | Provenance validation, shared alias/history handling, raw-pool interleaving and Threads dedupe counts (1 minimal narrowing, 2 behavior) |
| `src/services/batchCandidateSelection.ts` | Ownership, query queues, fairness and borrowing (2) |
| `src/services/monitor.ts` | Append collector before dedupe, attribution, source availability, existing finalizer (3) |
| `src/services/monitoringTelemetry.ts` | Shared outage predicate, optional bounded snapshot extension/validator (3–4) |
| `src/worker.ts` | Minimal union narrowing (1); secret/config/native fetch, overrides, redaction and summary projection (4) |
| `wrangler.jsonc`, generated `worker-configuration.d.ts` | Disabled defaults and binding types only (4) |
| `package.json` | One offline Workerd test script, no dependency changes (5) |
| `README.md`, `backlog.md`, `plan.md`, `docs/self-improvement/DAILY_SUMMARY.md`, `docs/self-improvement/CHANGELOG.md` | Operator procedure and factual offline handoff only (5) |

Tests added: `test/threadsDiscovery.test.ts`; `test/workerd/threadsDiscovery.worker.ts`, `test/workerd/threadsDiscovery.test.mjs`, `test/workerd/threadsDiscovery.wrangler.jsonc`. Existing tests extended: `test/batchCandidates.test.ts`, `test/batchCandidateSelection.test.ts`, `test/batchPrompt.test.ts`, `test/batchMonitoring.test.ts`, `test/batchAnalyzerFailover.test.ts`, `test/workerConfiguration.test.ts`, `test/monitoringTelemetry.test.ts`. No runtime edit to batchPrompt, renderer, analyzer adapters, stores, RSS/Brave collection or queries; report a required behavioral expansion before proceeding.

## Locked interfaces

These signatures define implementation contracts, not function bodies. Types live in `src/types/index.ts` unless a location is specified. Use existing readonly/input conventions and no import-time side effects.

```ts
type ThreadsQueryId = "ai_agents" | "claude_code" | "codex";
type ThreadsProvenance = {
  kind: "threads"; queryId: ThreadsQueryId;
  postId: string | null; resultOrdinal: number;
}; // Add to DiscoveryProvenance; null postId only with a null result.
type ThreadsHealth = "healthy" | "degraded" | "unavailable" | "disabled";
type ThreadsReason = "ok" | "disabled" | "configuration" | "expired"
  | "public_permission_unapproved" | "auth" | "permission_or_policy"
  | "rate_limit" | "redirect" | "http" | "transport" | "timeout"
  | "body_limit" | "malformed" | "api_error" | "budget" | "skipped";
interface ThreadsQueryOutcome {
  queryId: ThreadsQueryId; reason: ThreadsReason; httpStatus: number | null;
  elapsedMs: number; observedPositions: number;
  itemTruncated: boolean; pagingIgnored: boolean; bodyTruncated: boolean;
}
interface ThreadsPipelineMetrics {
  duplicates: number; retainedOwned: number; retainedAttributed: number;
  submitted: number | null; selected: number | null; delivered: number | null;
}
interface ThreadsCycleMetrics {
  enabled: boolean; configured: boolean; publicApprovalAttested: boolean;
  health: ThreadsHealth; reason: ThreadsReason;
  authentication: "unknown" | "accepted" | "rejected"; rotationDue: boolean;
  attemptedQueries: number; succeededQueries: number;
  failedQueries: number; skippedQueries: number;
  observedPositions: number; validObservations: number; rejectedPositions: number;
  outcomes: ThreadsQueryOutcome[];
  pipeline?: ThreadsPipelineMetrics;
}
interface ThreadsDiscoveryResult {
  observations: BatchObservation[]; metrics: ThreadsCycleMetrics;
}
// src/services/threadsDiscovery.ts
interface ThreadsCollectorOptions {
  enabled: boolean; publicSearchApproved: boolean;
  accessToken?: string; tokenExpiresAt?: string;
  now: Date; fetchImpl: typeof fetch;
  monotonicNow?: () => number; // performance.now default; injected for budget tests
}
declare function collectThreads(options: ThreadsCollectorOptions): Promise<ThreadsDiscoveryResult>;
// src/types/index.ts, source-completion evidence, not provider quota counts
interface DiscoverySourceSuccessCounts { brave: number; rss: number; threads: number }
// src/services/monitoringTelemetry.ts, pure shared decision
declare function isTotalDiscoveryOutage(
  successes: DiscoverySourceSuccessCounts, threadsEnabled: boolean
): boolean;
```

`configured` means locally valid nonempty token and valid unexpired UTC expiry; it does not mean authentication or public approval. Missing approval is a separate gate. `authentication=accepted` requires a valid authenticated response and never sets public approval. An explicit auth rejection wins over earlier acceptance in the same cycle. Invalid clock/config returns bounded configuration failure. Collector has no persistence/inference dependency.

`THREADS_QUERIES` is a readonly `{id: ThreadsQueryId; query: string}[]` in approved order; `THREADS_ENDPOINT` and frozen `THREADS_LIMITS` export the exact spec constants. New Threads provenance validates query IDs, ordinal 1–5 and decimal string ID 1–64; only a null observation can have null ID. No arbitrary username/body in it. Task 4 defines `type DiscoveryProvenanceSummary = Exclude<DiscoveryProvenance, ThreadsProvenance> | Omit<ThreadsProvenance, "postId">` for `BatchCycleMetrics.selected[].provenance`. Projection to scheduled telemetry omits postId; application `BatchCandidate.provenance` retains the full identity. All cross-task types/functions above are exported from their stated files. Task 1 creates collector contracts; Task 3 adds success-count/outage contracts, and Task 4 adds the summary projection.

## Task 1: Bounded Threads collector and source contracts

**Files:**
- Create: `src/config/threadsSources.ts`, `src/services/threadsDiscovery.ts`.
- Modify: `src/types/index.ts`; only necessary explicit-kind narrowing in `src/services/batchCandidates.ts` and `src/worker.ts` so adding a union member never treats Threads as RSS or breaks typechecking. Behavior integration follows Tasks 2–4; do not connect collection yet.
- Test: create `test/threadsDiscovery.test.ts`; preserve existing `test/batchCandidates.test.ts`, `test/workerConfiguration.test.ts` tests.

**Interfaces:**
- Consumes: SearchResult, BatchObservation, existing UTF-8 helpers from batchPrompt, native fetch/AbortController; options above.
- Produces: `THREADS_QUERIES`, `THREADS_ENDPOINT`, `THREADS_LIMITS`, `collectThreads(options): Promise<ThreadsDiscoveryResult>`, types above; no Worker invocation yet.

- [ ] **RED:** Add named fixture tests `disabled_and_missing_config_make_zero_requests`, `restricted_success_does_not_prove_public_access`, `three_recent_queries_fifteen_positions`, `invalid_positions_are_not_refilled`, `freshness_uses_one_collection_window`, `bounded_stream_and_deadlines`, `terminal_errors_stop_later_queries`, and `partial_failure_keeps_prior_observations`. Assert exact endpoint/params/order and <=3 calls, <=5 positions/query, <=15 observations; no next URL/redirect/retry/refresh. Use node:test mocked timers plus injected monotonic time; fake fetch only. Test 131072-byte success versus 131073 rejection, 8192-byte error cap, absent/lying Content-Length, streaming overflow/cancel, never-resolving headers/body, and parse completed after deadline rejected. With 9s elapsed there is no fourth or late request; remaining time shortens the next timeout. Empty array succeeds; error envelope on 200 never succeeds.
- [ ] **RED details:** Table-test malformed JSON/envelope/post; missing/non-string/oversize fields; invalid/future/out-of-window date; invalid calendar values and official `+0000` timestamp conversion to UTC; exact window endpoints. Test HTTPS hostname/path/userinfo/port/control/encoded-separator rejection and safe escaped output. Reject >8192-byte text and >2048-byte URL; truncate valid normalized title/snippet to 256/768 UTF-8 bytes. No text → null observation, no media fetch. Test null postId only for null results. Preserve host spelling under the existing normalizer, not `.net`→`.com` rewriting.
- [ ] **RED errors/config:** False approval always zero calls even if fake fetch would return valid own-account posts. With true attestation and HTTP 200, assert `publicApprovalAttested=true` but no `publicAccessVerified` field or inference; simulation cannot prove public access. Test missing/whitespace token, malformed/expired expiry, warning at seven days, 401/403/429, Graph 102/190/10/200–299/4/17/341/368, unknown code, transport, 3xx, timeout, budget, and collector rejection. Do not log token/encoded token, response or thrown URL. Preserve spec classification/stop policy; errors other than terminal auth/permission/rate/unknown-Graph can continue within budget.
- [ ] **Run RED:** `./node_modules/.bin/tsx --test test/threadsDiscovery.test.ts` → new tests fail for absent collector/contracts, not an environment/provider failure.
- [ ] **GREEN:** Implement only the registry/contracts/collector. Freeze until from options.now; use monotonic elapsed deadlines. Stream complete bounded JSON with fatal decoding, timer cleanup and cancellation. Manually reject redirect responses; query token exists only in the dispatch URL. Map first five positions, keep invalid null positions and bounded outcomes. Complete all query counters including skipped entries; no outcome array beyond three. Disabled has zero attempted/failed and no outcomes; gate failure has zero attempted/failed and three skipped queries. Once collection begins, record at most one outcome for each registry query, including skipped queries. Use the gate reason before collection, otherwise the first non-ok outcome in registry order as the aggregate reason (all successful → ok). Do not put an SDK, generic framework, parser or source text in monitor.ts. Add explicit RSS branches at existing binary union assumptions, with unhandled Threads not admitted before Task 2 and omitted safely from the old summary before Task 4.
- [ ] **Focused GREEN:** Repeat RED command, then `./node_modules/.bin/tsx --test test/batchCandidates.test.ts test/workerConfiguration.test.ts` and `./node_modules/.bin/tsc --noEmit`. Expect pass; no full suite.
- [ ] **Commit:** Stage only Task 1 files after `git diff --check`/staged inspection; `git commit -m "feat: add bounded official Threads collector"`.

## Task 2: Shared dedupe and deterministic three-source fairness

**Files:**
- Create: none.
- Modify: `src/services/batchCandidates.ts`, `src/services/batchCandidateSelection.ts`, `src/types/index.ts` (optional pool attribution only).
- Test: `test/batchCandidates.test.ts`, `test/batchCandidateSelection.test.ts`, `test/batchPrompt.test.ts`.

**Interfaces:**
- Consumes: Task 1 provenance and registry, existing DiscoveryHistory/NotificationHistory and `BatchCandidate[]`.
- Produces: unchanged `prepareBatchCandidates(observations, {history, notificationHistory, seenAt}): Promise<CandidatePool>` and `selectGeminiCandidates(candidates: readonly BatchCandidate[]): {candidates: readonly BatchCandidate[]; preFilterInputCount: number; selectorExcluded: number}`. Add `CandidatePool.threads?: {duplicates: number; retainedOwned: number; retainedAttributed: number}` for cycle-local attribution only, not storage. `duplicates` counts valid Threads observations merged into a previously encountered URL/alias group; known-history exclusions are not duplicates.

- [ ] **RED:** `three_source_aliases_merge_once_and_check_every_history_key` asserts one candidate with all provenances, immutable original source data, all observed aliases retained even beyond pool cap, known/notified aliases excluded and existing histories touched before analysis. Multiple observations with the same query/ordinal cannot expand capacity. Distinct URLs, including `.com` versus `.net`, remain distinct; do not introduce event dedupe. Bound valid positions at 50 Brave +25 RSS +15 Threads (current four-feed registry permits 85 total); candidate pool <=50.
- [ ] **RED fairness:** `saturated_three_sources_select_12_6_6` uses distinct owned candidates and one common Threads hostname. `borrowing_uses_brave_rss_threads_order` asserts exact IDs: repeatedly request [Brave,RSS,Brave,Threads]; when requested lane empty, first nonempty Brave→RSS→Threads supplies the slot. Cover one RSS candidate with ample Brave/Threads →17/1/6, no Brave with ample RSS/Threads →0/18/6, duplicate-only lane, query rotation, stable ties, no input mutation and invalid provenance. With no Threads-owned candidates, retain exact old 3:1 behavior and host-preference behavior.
- [ ] **RED prompt/fallback boundary:** Saturate all source positions with maximal permitted multibyte text/URLs, preserve at least one candidate per eligible lane through `prepareBatchPrompt`, assert <=24 and <=12288 bytes without changing its code. Raw pool still includes excluded analyzer candidates. No fabricated 32-KiB assertion. If existing prompt representation cannot satisfy early-lane representation, stop for the spec's bounded amendment rather than raising caps.
- [ ] **Run RED:** `./node_modules/.bin/tsx --test test/batchCandidates.test.ts test/batchCandidateSelection.test.ts test/batchPrompt.test.ts` → fail on Threads admission/allocation before implementation.
- [ ] **GREEN:** Order valid observations Brave positions, then RSS registry/position, then Threads registry/result ordinal before alias aggregation. Preserve existing alias/history semantics. Ownership precedence Brave→RSS→Threads; shared candidates consume one slot. Raw pool round-robin Brave,RSS,Threads; rotate Threads query queues. Analyzer pattern [Brave,RSS,Brave,Threads] with fixed borrowing above; retain current within-Brave/query and RSS/feed rotation and tie order (position, original index, candidateId code units). In three-source mode, relax soft host preference within requested lane before borrowing; it is not a hard two-post limit. Keep old selector path unchanged if no Threads-owned candidates.
- [ ] **Focused GREEN:** Repeat RED command plus `./node_modules/.bin/tsc --noEmit`; expect pass, same prompt contract, no full suite.
- [ ] **Commit:** Inspect and stage Task 2 files only; `git commit -m "feat: merge Threads into shared candidate selection"`.

## Task 3: Monitoring integration, isolation and outage semantics

**Files:**
- Create: none.
- Modify: `src/services/monitor.ts`, `src/types/index.ts`, `src/services/monitoringTelemetry.ts` (pure outage helper only in this task).
- Test: `test/batchMonitoring.test.ts`, `test/batchAnalyzerFailover.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–2 results, existing `runBatchMonitoringCycle(dependencies): Promise<MonitoringCycleResult>`, single `analyze(PreparedBatch)` and finalizer.
- Produces: optional `BatchMonitoringDependencies.collectThreads?: (now: Date) => Promise<ThreadsDiscoveryResult>` (absence means disabled); `MonitoringCycleResult.threads?: ThreadsCycleMetrics`; `DiscoverySourceHealthMetrics.threads?: ThreadsHealth`, `successfulResponses?: DiscoverySourceSuccessCounts`, `threadsEnabled?: boolean`; `BatchCycleMetrics.submittedBySource.threads?: number`. Optional fields preserve legacy call-site compatibility; the updated Batch path always populates them. Pure `isTotalDiscoveryOutage` from the locked interface is the only new outage decision.

- [ ] **RED:** `collectors_combine_before_one_analysis` asserts call order Brave→RSS→Threads→dedupe→selector→one analyze and uses the same PreparedBatch on eligible Luna failover. Threads receives fresh `now()` at collection, not stale cycle start. Disabled/missing collector causes zero Threads fetches and old behavior. Failure matrix covers thrown collector, timeout, partial results, missing/expired credentials, permission and budget exhaustion with healthy Brave/RSS: completion/finalization continues.
- [ ] **RED outage table:** Available means >=1 valid source response, even empty; disabled Threads supplies none. Assert the exact predicate: Brave successes=0 AND RSS successes=0 AND (Threads disabled OR Threads successes=0). Threads-only success (including empty array) →false; partial Brave success followed by quota-block →false; quota-blocked Brave before any success plus failed RSS and disabled/unavailable Threads →true. Keep outage distinct from content availability: replay or retained raw candidates can still feed the existing finalizer. No clearing admission/accounting latches.
- [ ] **RED delivery:** `threads_raw_candidate_uses_existing_degraded_finalizer` places an eligible Threads candidate outside the submitted subset, disables AI through existing fixtures, and verifies the full retained pool is available to degraded selection with escaped text/no invented score/HTML. Same canonical URL observed through three sources is not reanalyzed or resent after notification. Assert max four stories/one email for normal, degraded, empty, partial and total outage; no separate source email. Existing threshold and below-threshold labels unchanged.
- [ ] **RED analyzer guard:** Extend existing failover matrix with Threads observations: one logical analyze invocation, Gemini retries unchanged; exactly exhausted three confirmed-zero 503 attempts can admit one Luna, no admission for timeout/429/accounting/semantic failures, no second PreparedBatch. Simulate slow acquisition with injected clocks and assert existing shared admission deadlines are not reset/extended. No actual provider request.
- [ ] **Run RED:** `./node_modules/.bin/tsx --test test/batchMonitoring.test.ts test/batchAnalyzerFailover.test.ts` → new source/integration/outage assertions fail.
- [ ] **GREEN:** Append collector observations after RSS before `prepareBatchCandidates`. Catch source exceptions into fixed unavailable metrics, never raw text. Record successful response counts from actual Brave searchSuccesses, RSS succeededFeeds, Threads succeededQueries; compute outage once using the pure helper. Attach pool attribution, then submitted counts after prompt compaction and selected/fresh-delivered counts using candidate IDs/aliases through the existing finalizer. Before those stages use null rather than invented zero. Delivered attribution is only cycle-observed fresh Threads content accepted by the email provider; do not claim historical replay provenance if not persisted. Do not change storage to recover it. Keep the full pool and single finalizer path intact.
- [ ] **Focused GREEN:** Repeat RED command plus `./node_modules/.bin/tsc --noEmit`; expect pass. Do not run the full suite.
- [ ] **Commit:** Inspect and stage Task 3 files; `git commit -m "feat: integrate isolated Threads discovery into monitoring"`.

## Task 4: Worker gates and bounded additive telemetry

**Files:**
- Create: none.
- Modify: `src/worker.ts`, `src/services/monitor.ts` (snapshot projection), `src/services/monitoringTelemetry.ts`, `src/types/index.ts` (summary projection), `wrangler.jsonc`, generated `worker-configuration.d.ts`.
- Test: `test/workerConfiguration.test.ts`, `test/monitoringTelemetry.test.ts`, `test/batchMonitoring.test.ts`.

**Interfaces:**
- Consumes: `collectThreads`, success counts/outage helper, metrics and existing strict telemetry serialization.
- Produces: four optional string bindings on RadarWorkerEnv; `WorkerMonitoringDependencyOverrides.collectThreads?: BatchMonitoringDependencies["collectThreads"]`; receiver-safe `workerdThreadsFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)`; optional `ScheduledCycleSummary.threads?: ThreadsCycleMetrics`; optional `CycleSnapshotV1.threads?: ThreadsCycleMetrics`; exported `validateThreadsCycleMetrics(value: unknown): ThreadsCycleMetrics` in monitoringTelemetry for strict bounded validation. Existing serialization functions retain signatures and version 1.

- [ ] **RED gates:** `worker_threads_gate_is_independent_of_required_provider_config` verifies false/missing flags invoke no fetch and no secret requirement; true without token/expiry/approval yields unavailable Threads while Brave/RSS and one finalizer remain available. Literal false/invalid flag values must not enable. Default factory uses receiver-safe fetch, default false flags in vars, empty expiry default (not a fabricated expiry), no token in vars/required-secret list. Fake auth/permission and apparent-success restricted response tests must never turn attestation into a verified-permission claim. Rotation is manual only; no refresh URL requested.
- [ ] **RED telemetry:** Test old rows without extension, valid disabled/partial/full extension, unknown keys, duplicate/out-of-registry query IDs, >3 outcomes, non-finite/negative/oversized numbers, invalid flags/enums and post IDs/raw bodies accidentally offered to summaries. Clamp/allowlist summaries; strict persistence rejects malformed payloads. Test <=1536 extension bytes and <=8192 total bytes with all three outcomes, pipeline counters and maximum existing latency/failover evidence. Explicit stages: not reached=null, reached with no selection=0, accepted delivery>0 only with finalizer evidence. Unknown/failed email cannot count delivered; sum source attribution may exceed unique count but ownership may not.
- [ ] **RED redaction/outage:** Inject synthetic token and URL-encoded token into errors/URLs/hostnames/unexpected properties and assert none survives serialization/logging. Ensure new `DiscoveryProvenanceSummary` excludes postId. Given trusted bounded response counts, Worker and persisted snapshot agree with monitor's helper even for partial Brave quota-block or Threads-only success. Legacy summaries without new counts preserve legacy rendering; never infer a new successful Threads response. A failed optional console summary cannot abort content; mandatory checkpoint failure retains existing behavior.
- [ ] **Run RED:** `./node_modules/.bin/tsx --test test/workerConfiguration.test.ts test/monitoringTelemetry.test.ts test/batchMonitoring.test.ts` → fail for missing wiring/extension/three-source sanitization.
- [ ] **GREEN:** Wire defaults and overrides; parse flags/expiry locally without fetching permissions; missing Threads configuration must not throw from global dependency construction. Add token to existing redaction, including encoded dispatch URL handling. Extend strict optional snapshot keys, not schema/version/tables. Project all query outcomes and attribution through allowlists. Count aggregate positions max90 (current registry85), retained50/submitted24; do not repurpose Brave rawCount as bounded positions or silently change its existing meaning. Update sanitizer bounds for the actual field being projected. Preserve legacy optional-row support and bounded compatible-reader rollback warning. Serialize no raw provider object.
- [ ] **Focused GREEN:** Repeat RED command; `WRANGLER_SEND_METRICS=false npm run worker:typecheck` (inspect generated diff, retain only binding changes). Expect pass; no full suite. HTTP remains health-only, Cron and D1 binding unchanged, X disabled and no 0004 dependency.
- [ ] **Commit:** Inspect Task 4 staged diff including generated file; `git commit -m "feat: wire gated Threads source telemetry in Worker"`.

## Task 5: Workerd proof, final verification and operator handoff

**Files:**
- Create: `test/workerd/threadsDiscovery.worker.ts`, `test/workerd/threadsDiscovery.test.mjs`, `test/workerd/threadsDiscovery.wrangler.jsonc`.
- Modify: `package.json` (only `test:threads-workerd` script), `README.md`, `backlog.md`, `plan.md`, `docs/self-improvement/DAILY_SUMMARY.md`, `docs/self-improvement/CHANGELOG.md`.
- Test: new local Workerd harness; existing offline suites listed below. No additional runtime behavior is planned here; failures return to the owning task, with evidence and a scoped corrective commit if required.

**Interfaces:**
- Consumes: final Worker factory, collector, fake credentials, Task 1–4 contracts and existing local Workerd harness patterns.
- Produces: `test:threads-workerd` → `node test/workerd/threadsDiscovery.test.mjs`, local runtime evidence, one final verification report and manual operational instructions. No production endpoint or fixture override is added to the deployed Worker.

- [ ] **RED:** Build local Workerd fixture test names `native_fetch_receiver_and_abort`, `stream_cap_cancels_reader`, `redirect_never_forwards_token`, `disabled_binding_has_zero_requests`, `failed_threads_keeps_combined_cycle`. Use fixture service binding(s) implemented in the test Worker and injected fetch adapter; the adapter validates the fixed official request shape but sends only to the local fixture binding. No request may escape to an Internet origin. Include stalled headers/body, exact131072/+1 bodies, unsupported/3xx response, 3-request ceiling, 9s admission budget and healthy other-source continuation. Use no production DB bindings; a local fake persistence adapter suffices for the source boundary. Test-only routes are never imported by src/worker.ts.
- [ ] **Run RED:** `node test/workerd/threadsDiscovery.test.mjs` → fail on unimplemented fixture assertions/wiring; distinguish intended test failure from missing installed tooling. Use installed local Wrangler only, metrics disabled; no download or login.
- [ ] **GREEN:** Complete only the fixture service/test driver and package script, following existing harness URL/fileURLToPath and process cleanup conventions. Exercise actual Workerd streams/Abort/fetch binding, not a Node-only imitation. Assert fixture invocation counts and cancellation; process cleanup closes all servers/children. An observed production-runtime defect goes back to its owning task rather than an unrelated workaround in the harness.
- [ ] **Focused GREEN:** `WRANGLER_SEND_METRICS=false npm run test:threads-workerd` → pass with no external requests. Reuse this successful run as the Threads Workerd result in the final gate if no code changes afterward; do not repeat it just for ceremony.
- [ ] **Final verification:** Run the following once on the completed implementation, with external networking denied and fixture/local traffic allowed. Inspect every script first. Missing local tooling is a blocker, not permission to install. Only repeat failing/affected verification if a correction requires it.

```sh
npm test
npm run build
WRANGLER_SEND_METRICS=false npm run worker:typecheck
WRANGLER_SEND_METRICS=false npm run test:rss-workerd
WRANGLER_SEND_METRICS=false node test/workerd/geminiTelemetry.test.mjs
WRANGLER_SEND_METRICS=false node test/workerd/openaiFallback.test.mjs
# Threads Workerd: use the immediately preceding passing focused run.
threads_bundle_dir=$(mktemp -d /private/tmp/radar-threads-bundle.XXXXXX)
WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run --outdir "$threads_bundle_dir"
git diff --check
```

Inspect the dry-run bundle for forbidden Node filesystem/local JSON persistence/dotenv/OpenAI SDK dependencies, fixture hosts/routes, and unintended Threads refresh/posting endpoints. Check no dependencies/lockfile/migrations/0004/provider quotas/Cron/resource bindings changed. Do not run live `monitor`, provider `*:test`, migration or deployment commands; the named Workerd harnesses above must remain entirely local. `npm test` is the full-suite run, exactly once unless a failure requires rerun; report its actual count, never copy a historic total.

- [ ] **Operator docs and evidence:** README lists flags, secret binding and expiry, permissions/public App Review gate, absence of online public-access proof, seven-day warning, disable→rotate secret+expiry→reverify approval→enable procedure, expiry/revocation response, no auto-refresh/no D1 requirement. Describe natural proof and compatible telemetry-reader rollback restriction, with explicit staged release gates: offline work → one independent final Analyst review → separately authorized push/PR/CI/merge → Meta setup/token/permission approval → undeployed Worker version → authorized deployment → natural combined-source proof. Do not execute them. Update roadmap to actual offline status (awaiting Analyst review, not deployed), and durable summary/changelog with exact commits, checks and limitations. Keep existing production facts and pending natural validation intact; leave Analyst-owned review untouched.
- [ ] **Commit:** Recheck protected hash, inspect exact staged files and `git diff --cached --check`; `git commit -m "test: verify Threads Worker boundaries and document operations"`. Return final implementation HEAD, results/limitations and file diff to Analyst; no push or activation.

## Coverage and self-review

| Approved specification area / requested cases | Owning task |
| --- | --- |
| Official endpoint, permissions, query strategy, token gate, freshness, collector limits, normalization, errors; resumed-request cases 1–23 | 1 (Worker gate also 4) |
| Explicit provenance and shared history/alias dedupe; cases 25–26 | 1–2; integration proof 3 |
| Raw cap50, three-source fairness/borrowing/under-supply, prompt24/12288; cases 27–31 | 2 |
| One analyzer, unchanged Luna, raw degraded, one-email; cases 32–35 | 3 |
| Three-source outage, disabled/empty/partial/quota-block semantics; case 36 | 3, projection parity 4 |
| Secret wiring, disabled zero-call, bounded/redacted additive telemetry; cases 24, 37–38 | 4 |
| No X/0004/migration; case 39, Workerd/complete verification | 4–5 |
| Operator auth/rotation, external dependencies, compatible rollback, natural release proof, non-goals | 5 plus Global Constraints |

Self-review reconciled types with all five tasks: pipeline attribution is optional until available, no raw post ID enters summary/persistence, one shared outage helper uses successful responses rather than two-source health labels, no claimed ability to detect silent own-account restriction, no new raw-pool byte budget, and no second inference/email path. Public access must be attested externally; valid empty responses prove availability only. The original approved spec is unchanged. No implementation, tests, provider calls, migration, production validation or credential setup has been performed by this planning checkpoint.
