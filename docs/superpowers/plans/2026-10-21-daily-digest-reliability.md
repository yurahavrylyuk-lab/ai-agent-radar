# Daily Digest Reliability Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for native Builder execution after plan approval. Follow the checkbox steps. No worktrees or additional branch creation in this planning task; use the existing physical repository. This document contains no runtime implementation.

**Goal:** A naturally executing monitoring invocation reaches one final normal, degraded or status-only email attempt despite Gemini failure.

**Architecture:** Reuse the existing bounded candidate order and canonical/history evidence. Separate delivery preparation from one guarded final send; later add one same-model retry only after durable confirmed-zero transient failure, inside the original 90-second deadline.

**Tech stack:** TypeScript, existing Worker/D1/Resend/Gemini adapters, Node offline tests with injected transport, clocks and RNG. No new dependency, migration, queue, scheduler or ranking engine.

**Spec:** [Approved design](../specs/2026-10-21-daily-digest-reliability-design.md), approved commit `2f44ea8a9e093296f4907bb0f34a8d31d1bd8a2a`. Design branch: `codex/daily-digest-reliability-design`. Production baseline: `4fad7003c6619aa1fdee2b27c0f9cae219a9aa60`.

## Global constraints and execution order

- Preserve Brave/RSS collection, four approved feeds, body_limit behavior, dedupe/replay, 50-candidate/32 KiB limits, normal selected scores 1–10 and exact low-score label `It could be relevant`.
- Four stories maximum; one final mail attempt maximum. No alternative AI, model fallback, second ranking stage or mail retry. No D1 schema, X, 0004, Threads, quota, secret or Cron changes.
- Retry only existing structured `resource_exhausted_429` / `unavailable_503` evidence AFTER successful durable confirmed_zero settlement. Same model/prompt, at most two dispatches, one context, 1000–1500 ms delay and a shared 90,000 ms deadline from first dispatch. Timeout/unknown execution never retries.
- Per-invocation send protection does not promise inbox delivery or cross-invocation exactly-once semantics. Platform termination and missing mail configuration remain limitations.
- **Delivery-first staging:** execute Tasks 1, 2, 4A, 5A, 6A while Gemini remains one-dispatch. Obtain Phase A acceptance and the separately authorized release/natural observation gate specified by the design. Then execute Task 3, 4B, 5B, 6B. Task numbers describe units, not permission to implement retry before Phase A. No live deployment or observation is authorized by this plan.
- Commit checkpoints below are local documentation/runtime checkpoints for the later authorized Builder. Do not auto-stage unrelated work. No push, merge, provider calls, monitoring or production mutation. Preserve the existing untracked batch design byte-identically.

## File map

Modify `src/types/index.ts` for cycle-local delivery/attempt contracts; `src/services/notificationOrchestrator.ts` for preparation and finalization; `src/services/discoveryEmailFormatter.ts` for degraded/status rendering; `src/tools/email/resend.ts` for the existing 30-second deadline through body parsing; `src/tools/llm/gemini.ts` for batch-only retry policy; `src/services/monitor.ts` and `src/worker.ts` for orchestration/composition/telemetry.

Tests: add `test/dailyDigestReliability.test.ts`; extend `test/notificationOrchestrator.test.ts`, `test/discoveryEmailFormatter.test.ts`, `test/resend.test.ts`, `test/notificationReplay.test.ts`, `test/notificationHistory.test.ts`, `test/geminiAmbiguityAccounting.test.ts`, `test/geminiUsageGuard.test.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`. Existing batch candidate/prompt and RSS tests are regression gates, not a reason to redesign those modules.

Documentation at handoff: `backlog.md`, `plan.md`, `docs/self-improvement/PROJECT_STATE.md`, `DAILY_SUMMARY.md`, `CHANGELOG.md`. No change to persistence adapters or migrations is expected; inability to use their existing contracts requires explicit scoped review.

## Review focus

- History fails after valid-looking observations: status only; no unchecked raw/replay delivery (Tasks 1/4).
- A send is accepted but history persistence fails: no replacement/status send (Task 2).
- A late confirmed-zero response leaves too little time for retry: skip retry without another reservation/dispatch (Task 3).
- Valid empty AI output differs from provider failure and low-score AI output (Tasks 2/4/5).
- Non-mail dependency construction fails before monitoring starts: independent status payload still reaches the same finalizer (Task 4).

## Task 1 — Deterministic degraded-story and replay selection

**Files:** `src/types/index.ts`, `src/services/notificationOrchestrator.ts`; tests `test/dailyDigestReliability.test.ts`, `test/notificationReplay.test.ts`.

**Interfaces:** Add cycle-local `DailyDigestItem = {kind:'analyzed'; candidate:BatchDeliveryCandidate} | {kind:'raw'; candidate:BatchCandidate}`. No StoredDiscovery/AgentAnalysis changes. Add `DailyDigestMode = 'normal' | 'degraded' | 'status_only'` and closed `DailyDigestReason = 'selected' | 'no_eligible_stories' | 'ai_unavailable' | 'ai_no_selections' | 'discovery_unavailable' | 'history_unavailable' | 'preparation_unavailable' | 'persistence_unavailable'`.

Export `prepareDailyDigest(input: DailyDigestInput, history: NotificationHistory): Promise<PreparedDailyDigest>`. Input: UTC cycle date, persisted fresh analyzed candidates, eligible replay candidates, bounded pre-prompt `BatchCandidate[]`, all observed aliases, `allowRawFallback:boolean`, and closed reason. Output: mode/reason/date, <=4 DailyDigestItems with all aliases needed for accepted notification writes. No transport call here. `allowRawFallback` is false on selection persistence/history failure; the caller cannot pass unchecked observations.

- [ ] **RED:** add `raw_selection_preserves_pool_order`: input raw c003,c001,c002 yields exactly that order, not a score/source/title sort; first four of six win. Add same-key Brave/RSS/fragment duplicates and notified aliases; assert one representative and unioned evidence, with notified groups excluded.
- [ ] Add `delivery_precedence`: deliverable normal fresh + replay wins and contains zero raw fillers; with no normal fresh, safe raw fills first then replay in existing score/date/URL order; no raw means replay; none means status_only. Assert combined cap four and no legacy low-score replay without persisted Batch provenance. Test 72-hour/cutoff behavior through existing replay tests, not a new eligibility implementation.
- [ ] Add `history_failure_suppresses_all_stories` for initial and final alias rechecks; status-only carries no items. A newly notified lead is replaced from the same bounded pool; never extend scanning past its existing cap. Raw fallback remains disabled after persistence failure.
- [ ] Run `./node_modules/.bin/tsx --test test/dailyDigestReliability.test.ts test/notificationReplay.test.ts`; confirm RED from missing behavior, not a fixture/import typo.
- [ ] Implement shared grouping and the existing two-pass notification exclusion as preparation helpers in notificationOrchestrator. Preserve fresh/replay ordering; raw candidates follow existing pool order before prompt tail truncation. Do not create a trust score, analysis row, ranking subsystem or new URL normalization.
- [ ] Rerun focused tests; expect PASS. Inspect diff and commit only Task 1 paths: `feat: prepare deterministic daily digest candidates`.

## Task 2 — Unified payload rendering and one final email attempt

**Files:** `src/services/discoveryEmailFormatter.ts`, `src/services/notificationOrchestrator.ts`, `src/tools/email/resend.ts`, delivery types; `test/dailyDigestReliability.test.ts`, `test/discoveryEmailFormatter.test.ts`, `test/notificationOrchestrator.test.ts`, `test/resend.test.ts`, `test/notificationHistory.test.ts`.

**Interfaces:** `formatDailyDigestEmail(digest: PreparedDailyDigest): DiscoveryEmailContent`; `createDailyEmailContext(): {emailAttempted:boolean}`; `finalizeDailyDigest(digest: PreparedDailyDigest, dependencies: {context; history?:NotificationHistory; sendEmail:(content:DiscoveryEmailContent)=>Promise<EmailSendResult>; onAccepted?:()=>void}): Promise<DailyEmailOutcome>`. Outcome contains attempted/accepted status and closed historyOutcome, not raw exceptions. Duplicate finalizer calls return the existing consumed state without another send. Share context across all error paths.

- [ ] **RED:** render normal scores 1 and 10; assert below-7 exact label remains. Raw mode shows original title/hostname/URL and <=768-byte existing snippet, escapes HTML/attributes, and contains no invented score/analysis fields. Use spec's exact degraded/status headings. Valid-empty selection uses `Daily digest — discovery highlights` with an accurate no-usable-selections explanation; it must not claim provider outage. Replay is labelled previously analyzed.
- [ ] Test status-only includes UTC scheduled date and truthful closed reason, no stories or provider details. Unsafe URLs cannot reach rendering. Rendering failure before transport produces the minimal static status payload.
- [ ] Test normal/degraded/status each call send once; repeated/concurrent finalization calls also total one. Provider rejection/timeout/invalid response and acceptance followed by history-write failure do not call send again. Assert onAccepted occurs before record writes; failures after that remain accepted/persistence_failed.
- [ ] Test raw acceptance records existing normalized URL/email notifications for representative and aliases, with provider ID, but no discovery write or Batch analysis provenance. Failed send writes no success; status writes no fake story record. A later candidate/history pass excludes accepted raw stories.
- [ ] Test Resend slow headers AND successful/error response bodies: total deadline remains 30,000 ms; unreadable/ambiguous result ends the attempt without a retry. No unbounded body wait after timer cleanup.
- [ ] Run `./node_modules/.bin/tsx --test test/dailyDigestReliability.test.ts test/discoveryEmailFormatter.test.ts test/notificationOrchestrator.test.ts test/resend.test.ts test/notificationHistory.test.ts`; prove RED.
- [ ] Implement pure formatting with existing escaping and normal rendering. Consume context synchronously immediately before send invocation; catch rendering failures only before send, never initiate a new send from transport/history catch. Reuse notification persistence semantics; extend the Resend abort deadline through body parsing and clean it up in finally. Do not alter legacy send entry points except extracting shared helpers safely.
- [ ] Rerun focused tests, expect PASS; commit `feat: finalize normal degraded and status digests once`.

## Task 3 — Confirmed-zero retry inside one overall deadline (Phase B only)

**Files:** `src/tools/llm/gemini.ts`, attempt types in `src/types/index.ts`; `test/geminiAmbiguityAccounting.test.ts`, `test/geminiUsageGuard.test.ts`, `test/batchMonitoring.test.ts`.

**Interfaces:** Keep `generateBatchWithGemini(input, dependencies): Promise<LlmResult>` and existing singleton context. Extend its injectable dependencies with RNG if absent; use existing sleep/monotonicNow/fetch hooks. Internal batch attempt loop max 2, same primary model and immutable input; context retains batchStarted, frozen allowance and counters. Attempt summaries have ordinal 1|2, optional existing reviewed class, closed accountingOutcome, bounded duration. Never derive retry authorization from serialized telemetry.

- [ ] **RED:** in real offline SQLite/D1-adapter fixtures, return an existing structurally accepted 429/503 then success. Assert ordered events `reserve1 -> dispatch1 -> confirmZero1 completed -> sleep -> admission2 -> reserve2 -> dispatch2 -> exact2`. Two distinct IDs, request_count=1 each, first stays confirmed_zero/tokens zero, second exact values; no third call. Assert identical model/prompt in both bodies and only one generateBatchWithGemini entry.
- [ ] Test confirmed-zero second failure ends without third; second timeout/network/body uncertainty remains transport_ambiguous. First timeout, network ambiguity, malformed/unknown response, arbitrary 429, authentication failure, invalid model output or failed zero settlement forbids dispatch2. Preserve known exact usage even when model output is semantically invalid.
- [ ] Test fake RNG endpoints produce 1000 and 1500 ms; retry shares first-dispatch deadline. At 89,000 ms with a 1,500 ms delay, skip retry. After a 10,000 ms first attempt plus 1,000 ms delay, attempt2 has at most 79,000 ms, including response reading/parsing. Recheck time after sleep/admission/reservation before fetch; never reset 90 seconds. Ignore unbounded provider Retry-After.
- [ ] Test frozen allowance 1, global quota exhaustion, UTC-window changes, unresolved ownership, and repeated/concurrent API entry deny extra dispatch. Known pre-dispatch abort uses existing proven-not-dispatched settlement, not a fake executed request. Assert actual `providerDispatches` equals mock fetch count; reservation/request records are counted separately and are never deleted to force equality.
- [ ] Test no reserved row remains on ordinary handled exits when storage is functioning, including budget expiry after reservation. Inject storage write failure and prove no further dispatch and no forced zero; preserve unresolved evidence for the existing operator reconciliation process. A D1 outage cannot honestly guarantee successful settlement.
- [ ] Run `./node_modules/.bin/tsx --test test/geminiAmbiguityAccounting.test.ts test/geminiUsageGuard.test.ts test/batchMonitoring.test.ts`; confirm RED.
- [ ] Implement eligibility only after existing classifier and successful confirmZeroRequest. Recheck all existing guards before reservation2; keep separate rows and existing state transitions. Start one monotonic deadline at first dispatch, include backoff and subsequent work, abort remaining request budget. No model fallback, quota change, legacy retry change, latch clearing or migration.
- [ ] Rerun focused tests, expect PASS; commit `fix: bound batch retry to durably confirmed zero failures`.

## Task 4 — Batch orchestration, fallback and replay integration

**Files:** `src/services/monitor.ts`, `src/worker.ts`, delivery types; `test/batchMonitoring.test.ts`, `test/dailyDigestReliability.test.ts`, `test/workerConfiguration.test.ts`.

**Interfaces:** Retain runBatchMonitoringCycle and runScheduledMonitoring public result contracts, adding delivery outcome fields. Worker creates one DailyEmailContext and mail closure before non-mail dependency construction; pass them through batch dependencies. Non-mail initialization exceptions build status using that same context. Scheduled paths must not call both old notifyBatchDeliveryDigest and the finalizer. Legacy runMonitoringCycle behavior stays unchanged.

- [ ] **RED, Phase A:** model the supplied incident with 42 prepared candidates and approximately 22,367 bytes, fake 90-second timeout, zero replay. Assert ONE Gemini dispatch, unchanged timeout ambiguity and ONE degraded mail with first safe ordered candidates. Repeat with no safe candidates: one status attempt. No fresh lookup, provider call or retry is introduced by fallback.
- [ ] Test success with low-score selection → normal; valid empty result → raw highlights; blocked AI/preparation error → raw only if shared history-checked pool exists; persistence failure → safe replay/status, not raw resurrection; known/notified items never reenter. Assert raw+replay and fresh+replay each cap at four.
- [ ] Test replay lookup/history/dedupe errors → status; source outage → replay/status; non-mail configuration/constructor errors → status without relying on successful D1/Gemini construction. Mail configuration failure reports not_attempted clearly and cannot bypass required credentials. Do not catch provider send errors by restarting the cycle.
- [ ] Run `./node_modules/.bin/tsx --test test/batchMonitoring.test.ts test/dailyDigestReliability.test.ts test/workerConfiguration.test.ts`; confirm RED. Implement one preparation/finalization convergence after source/analysis work, with safe upstream exceptions producing status. Preserve source collectors, bounds and low-score/replay policy.
- [ ] GREEN Phase A; commit `feat: route scheduled batch outcomes through daily finalization`. Proceed to Tasks 5A/6A before Task 3.
- [ ] **RED/GREEN, Phase B after Task 3:** retry success → one normal send; retry failure → one degraded/status send; retry skipped by guard/budget → one degraded/status send. Assert at most one finalizer/send and at most two dispatches under the exact eligibility rule, with no discovery rerun. Run the same focused command, make only required integration adjustments and commit `test: cover retry outcomes through daily finalization`.

## Task 5 — Scheduled mode/outcome telemetry

**Files:** `src/types/index.ts`, `src/services/monitor.ts`, `src/worker.ts`; `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`.

**Interfaces:** Add `deliveryMode: normal|degraded|status_only`, closed deliveryReason from Task 1, analyzed/raw/replay counts, emailAttempts 0|1, emailOutcome accepted|failed|unknown|not_attempted, historyOutcome not_required|recorded|unavailable|persistence_failed and finalizationReached. In Phase B add at most two attempt summaries, retryEligible/retryAttempted and closed retrySkipReason none|not_eligible|accounting|admission|budget|exhausted, plus bounded elapsed milliseconds. Existing provider failure classification/source health remain intact.

- [ ] **RED Phase A:** summary distinguishes modes and valid-empty selections; reports attempted versus accepted versus unknown accurately. Post-acceptance history failure remains accepted. All-source outage can coexist with a successful status email. Existing source-health enums/counts and quota-blocked distinction are unchanged.
- [ ] Inject forged enums, huge counts, exception text, prompt/story bodies, secrets and invalid provenance into summary input. Assert closed allowlisting, <=4 stories, <=1 attempt and no raw data leakage; preserve existing secret redaction tests.
- [ ] Run `./node_modules/.bin/tsx --test test/batchMonitoring.test.ts test/workerConfiguration.test.ts`; confirm RED, implement explicit sanitized copying, rerun GREEN and commit `feat: report bounded daily delivery modes and outcomes`.
- [ ] **Phase B RED/GREEN:** assert first failed attempt stays visible even after retry success, counters allow two without truncating to one, attempt summaries <=2 and elapsed <=90000, reservation counts not falsely reported as dispatches, and uncertain outcomes never acquire reviewed classification. Same command; commit `feat: report bounded batch retry accounting outcomes`.

## Task 6 — Acceptance, final verification and governance

**Files:** tests from Tasks 1–5; `backlog.md`, `plan.md`, `docs/self-improvement/PROJECT_STATE.md`, `docs/self-improvement/DAILY_SUMMARY.md`, `docs/self-improvement/CHANGELOG.md`.

- [ ] **RED then GREEN on missing coverage:** complete a table-driven matrix normal/degraded/status × provider accepted/rejected/unknown × history available/failed, plus repeated finalization. Add a failing case before any corrective runtime change; if implementation already passes, record it as a regression test rather than manufacturing RED. Focused command: `./node_modules/.bin/tsx --test test/dailyDigestReliability.test.ts test/batchMonitoring.test.ts test/notificationReplay.test.ts test/resend.test.ts test/workerConfiguration.test.ts`.
- [ ] Assert unchanged Brave/RSS request count/order, RSS body_limit, canonical/history dedupe, source-health/outage, prompt byte/candidate bounds, HTTP health-only, X disabled and production-shaped offline DB without 0004. Run focused tests: `./node_modules/.bin/tsx --test test/rssDiscovery.test.ts test/batchCandidates.test.ts test/batchPrompt.test.ts test/batchAnalysis.test.ts test/notificationHistory.test.ts test/notificationOrchestrator.test.ts test/discoveryEmailFormatter.test.ts test/geminiAmbiguityAccounting.test.ts test/geminiUsageGuard.test.ts`. Use injected network only; no live feed/provider tests.
- [ ] **Phase A checkpoint:** prove delivery paths with dispatch ceiling still 1, record reviewable exact commit and focused evidence. Obtain the design-required independent review/acceptance and separately authorized rollout/natural observation before Phase B. Never deploy or wait for a production event by invoking monitoring. Production release verification may require its own full suite; do not count it as already performed here.
- [ ] **Final Phase B verification:** inspect scripts, run `npm test` once for the completed change, `npm run build`, `WRANGLER_SEND_METRICS=false npm run worker:typecheck`, and `WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/radar-daily-digest-dry-run`. Expect all PASS and a Worker-compatible bundle. Do not run monitor/provider/demo scripts. Repeat checks only for subsequent fixes or new evidence, not ritual task gates.
- [ ] Run `git diff --check`; inspect full/staged scope, secrets, generated files and untracked preservation. Compare migration directory/X/config/runtime limits to baseline: no change, no migration applied. Offline absence of 0004 verifies compatibility, not fresh remote migration state. No remote reads/writes are required for these checks.
- [ ] Update trackers with IMPLEMENTED/REVIEW evidence and actual tests; never mark DEPLOYED/NATURALLY VALIDATED from offline PASS. Preserve the exact ten-priority order below. PROJECT_STATE receives deployment/natural facts only when independently established or explicitly provided as a verified handoff. Summarize limitations: no mail retry, uncertain acceptance duplicate window, inability to settle during storage outage, per-invocation not global exactly-once semantics.
- [ ] Commit only reviewed changes: `test: verify daily digest reliability and actualize roadmap`. Submit final Phase B change for independent Analyst review and Architect disposition; deployment/merge remains human-controlled.

## Self-review and spec reconciliation

All spec requirements map to Tasks 1–6: selection/history/replay (1/4), safe formatting/finalization and 30-second mail body deadline (2), retry/accounting/timeout (3), incident and startup errors (4), allowlisted telemetry (5), regression/rollout/governance (6). No prompt compaction, background Gemini, new source or ranking subsystem.

Naming clarification: the design's `status` mode is serialized as the user's requested closed enum `status_only`; behavior is unchanged. Accounting clarification: actual dispatch metrics equal fetch attempts, but durable request_count conservatively counts reservations, including proven pre-dispatch zero rows. Do not erase those rows to force a misleading numerical equality. “No stuck reservation” is testable for handled exits with functioning storage, not a promise to write through a storage outage; uncertainty remains protected. Rollout order follows the approved Phase A-before-Phase B gate despite Task 3's numeric position. No unresolved product decision or behavioral spec mismatch remains.

## Authoritative priority order (unchanged)

1. Daily email delivery guarantee
2. Gemini transient-failure hardening
3. Production validation
4. RSS BODY_LIMIT reliability
5. Threads
6. Brave + RSS + Threads production proof
7. Legacy cleanup
8. Centralize pipeline limits
9. P7 / relevance + feedback
10. Final stabilization / V1.0

### Backlog/Plan Actualization Checkpoint

After every major feature or fix that is merged and/or production-validated, before beginning the next major roadmap item:

1. Update `backlog.md` with `DONE`, `TODO`, `DEFERRED`, or `DEPRECATED`, plus current priority and actual execution order.
2. Update `plan.md` with the current architecture and active implementation rules, explicitly superseding obsolete architecture.
3. Update `docs/self-improvement/PROJECT_STATE.md` only with verified production or deployment evidence.
4. Do not begin the next major roadmap item while these authoritative documents materially contradict the shipped state.

Update DAILY_SUMMARY/CHANGELOG as appropriate with exact implementation/review evidence. Passing tests alone never establishes production validation.
