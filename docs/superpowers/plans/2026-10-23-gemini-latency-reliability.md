# Gemini Latency Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native Builder execution task-by-task, followed by ONE independent final Analyst review. Steps use checkbox (`- [ ]`) syntax. This plan does not start implementation.

**Goal:** Increase the chance of a normal analyzed digest by reducing only Gemini's input workload and thinking effort, preserving the complete source pool and all deployed V2 safety behavior.

**Architecture:** Keep acquisition, URL/history dedupe and the full pool unchanged. A pure selector supplies at most24 original candidate objects to compact prompt preparation; scheduled Gemini adds low thinking. Extend bounded JSON telemetry without schema changes and leave delivery/accounting state machines intact.

**Tech Stack:** Node24, TypeScript, existing node:test/tsx, Cloudflare Worker/D1, installed Wrangler/Workerd and SQLite test fixtures. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-23-gemini-latency-reliability-design.md`, human-approved at `b671ec49813b29118060fdba22c14b0f75e90933`. Its awaiting-review language is historical; approval is supplied by this planning request. Main/production baseline is `4eb3cf049f222b1193d827b94b93f88196b03880`.

## Global constraints

- Plan-only work stays on `codex/gemini-latency-reliability-design`; commit only this plan. No runtime edits, new branch/worktree, provider call, D1 mutation, migration application, PR, push, merge or deployment now.
- After plan approval, Builder creates `codex/gemini-latency-reliability-implementation` from exactly `b671ec49813b29118060fdba22c14b0f75e90933` in the main physical repo. Preserve/hash unrelated files first. Bring in only the approved one-file plan commit identified in the Architect handoff by cherry-pick, after verifying its parent/base and file scope. Do not start from a moving main or overwrite an existing branch. No worktree.
- Discovery stays10 Brave searches plus current RSS; existing50-candidate full pool, observedAliases, known/history touches and notification alias checks survive unchanged. The24 cap applies only to analysis.
- Max24 submitted candidates; initial snippet192 UTF-8 bytes; title160; instructions<=3072; prompt<=12288 including JSON escaping/delimiters. Source/domain and candidate ID remain available; original title/URL/provenance stay application-owned.
- Scheduled native Interactions request keeps endpoint/model/input; add only `generation_config: { thinking_level: 'low' }`. No minimal, background, model fallback, tools, output-token clamp, store-policy change or extra call.
- V2 remains: only reviewed503 plus durable confirmed_zero can retry, max3 actual dispatches; delays1500–2000ms then3000–4000ms; shared90s envelope,75s cutoff and >=10s after backoff.429/timeout/transport/invalid response/accounting uncertainty never retry. No reservation reuse, unknown→zero, fourth request or changed quota.
- Output schema/validation unchanged: up to4 stories, first detailed, others concise, scores1–10, educational value/project opportunities/technologies; analyzed low-score label `It could be relevant`. Source titles/URLs are bound from original candidate objects, never supplied by the model.
- Normal/degraded/status finalizer, polished rendering, replay, alias checks and <=1 final email attempt unchanged. No new send on uncertainty.
- **NO NEW MIGRATION.** Applied0008 unchanged;0004 remains intentionally unapplied. Tests may use existing disposable offline fixture databases only; no application/production D1 commands. If schema compatibility proves impossible, stop for Architect review rather than create a migration.
- No background/hybrid implementation, semantic dedupe, idempotent email, telemetry-degraded continuity redesign, RSS BODY_LIMIT fix, Threads, X, CI expansion, legacy cleanup, P7 or limit centralization.
- Focused tests during tasks; one full suite after final edits. No manual production cycle or provider latency benchmark. Preserve existing production facts until a separately approved release.

## Review focus

1. A candidate omitted from analysis must still be deliverable through original raw fallback (Task5).
2. Host-cap saturation, dual provenance and borrowed slots must terminate without lost/duplicated candidates (Task1).
3. Quotes/control escapes and multibyte input must be counted after JSON serialization, with deterministic tail removal only (Task2).
4. Late telemetry errors must not interrupt accounting settlement or cause another dispatch/email (Tasks4–5).
5. Old snapshots must read with the new reader; old reader rejection of the extension must not be misrepresented as transparent rollback compatibility (Task4).

## Exact file map

Create:
- `src/services/batchCandidateSelection.ts` — pure analysis subset selection.
- `test/batchCandidateSelection.test.ts` — selector fixtures/invariants.
- `test/geminiLatencyReliability.test.ts` — offline cross-boundary acceptance/full-pool regression.

Modify runtime/types only:
- `src/services/batchPrompt.ts` — compact wire fields and byte packing.
- `src/tools/llm/gemini.ts` — Batch-only low thinking and per-dispatch timing observation; no retry/accounting rewrite.
- `src/services/monitoringTelemetry.ts` — optional bounded latency extension and compatible validation.
- `src/services/monitor.ts` — select only for prompt; retain original fallback inputs and construct latency snapshot.
- `src/worker.ts` — wire timing checkpoint and bounded summary fields.
- `src/types/index.ts` — prompt stage/limit metadata and optional Batch latency metrics.

Modify tests:
- `test/batchPrompt.test.ts`, `test/batchAnalysis.test.ts`, `test/geminiReliabilityV2.test.ts`, `test/monitoringTelemetry.test.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`, `test/dailyDigestReliability.test.ts`, `test/workerd/geminiTelemetry.worker.ts`.

Governance at Task6 only: `backlog.md`, `plan.md`, `docs/self-improvement/PROJECT_STATE.md`, `docs/self-improvement/DAILY_SUMMARY.md`, `docs/self-improvement/CHANGELOG.md`.

Read/reuse without changing: `batchCandidates.ts`, RSS/Brave collectors and registry, `analysisAgent.ts`, formatter/finalizer/replay implementations, `d1MonitoringTelemetry.ts`, accounting store, migrations, package/config/lock files. If a required change exceeds this map, state the concrete need before expanding scope.

## Shared interfaces

- In `batchCandidateSelection.ts`: `export const MAX_GEMINI_ANALYSIS_CANDIDATES = 24`; `selectGeminiCandidates(candidates: readonly BatchCandidate[]): { candidates: readonly BatchCandidate[]; preFilterInputCount: number; selectorExcluded: number }`. Consumes validated pool<=50; returns a new array containing the original object references. No re-ID, cloning away provenance, mutation or I/O.
- Keep `prepareBatchPrompt(candidates: readonly BatchCandidate[], instructions?: string): PreparedBatch`. Empty or >24 input is a preparation error rather than implicit arbitrary slicing. Add `PreparedBatch.snippetBytesLimit: 192 | 128 | 96 | 0`; retain sizeExcluded as byte exclusions only. Add `snippet128` to BatchTruncationStage; retain old stage literals for historical readers but never emit snippet384 in the new path. `initial` now means160/192 under this release.
- In `monitoringTelemetry.ts`: `GeminiAttemptTiming = { ordinal: 1 | 2 | 3; requestStartedAt: string | null; elapsedMs: number | null }`; `CycleLatencyV1 = { version: 1; preFilterInputCount: number | null; selectedCount: number | null; selectorExcluded: number | null; byteExcluded: number | null; submittedCount: number | null; promptBytes: number | null; snippetBytesLimit: 192 | 128 | 96 | 0 | null; thinkingMode: 'low' | null; executionMode: 'synchronous' | null; attemptTimings: GeminiAttemptTiming[] }`.
- Add `CycleSnapshotV1.latency?: CycleLatencyV1`, `BatchCycleMetrics.latency?: CycleLatencyV1`, and `GeminiDependencies.onAttemptTiming?: (timing: GeminiAttemptTiming) => Promise<void>`. Reuse this callback type in WorkerMonitoringDependencyOverrides; add `GeminiBatchCycleContext.attemptTimings: GeminiAttemptTiming[]` so terminal/failure finalization retains observations. All imports of telemetry types from `types/index.ts` must be type-only to avoid a runtime dependency cycle.
- Telemetry names follow the approved spec: `latency.submittedCount` mirrors existing `batch.submittedCandidates`, `latency.thinkingMode` describes request thinking_level. Do not store parallel submittedCandidates/thinkingLevel aliases. Existing source snapshot `candidateCounts.unique` remains untouched; preFilterInputCount comes from actual pool length.

### Task 1: Deterministic Gemini-only selector

**Files:** create `src/services/batchCandidateSelection.ts`, `test/batchCandidateSelection.test.ts`. **Interfaces:** selector above; read `RSS_FEEDS`, BatchCandidate and DiscoveryProvenance.

- [ ] RED tests: `caps_at_24_without_mutation`, `stable_query_feed_round_robin`, `borrows_in_both_directions`, `host_cap_relaxes_only_after_no_progress`, `dual_provenance_is_selected_once`. Deep-freeze input and compare deep snapshot after selection; assert `selected.every(c => input.includes(c))`, original provenance/alias arrays identical, IDs unique, repeated input gives equal order. Empty input returns empty; single-host47 returns24 after relaxation.
- [ ] RED command: `./node_modules/.bin/tsx --test test/batchCandidateSelection.test.ts`; expect missing selector/new assertions, not a tooling error.
- [ ] Minimal GREEN: assign Brave-backed candidate to its lowest queryOrdinal/lowest resultOrdinal within that query; RSS-only to first registry feed/lowest itemOrdinal. Sort each queue by provider position, original index, then candidateId using code-unit comparison. Cycle source pattern B,B,B,R, query/feed queues with rotating cursors; advance cursor after a successful pick, skip temporarily blocked queues. On a source slot, scan all that source's queues for first unselected host-eligible item (skip deferred host-blocked entries without deleting them); if none, borrow from other source. After four pattern slots with no pick, disable global exact-host cap2 and continue same cursors/pattern until24/exhaustion. Never create a general scoring layer or trust/freshness bonus.
- [ ] GREEN command: same plus `./node_modules/.bin/tsx --test test/batchCandidates.test.ts`. Pin exact18 Brave-backed/6 RSS-only with enough unconstrained supply, all10 Brave queries and all4 RSS feeds represented; query-order/rank ties, missing snippets/dates and near-duplicate URLs retain existing upstream semantics. Under constrained hosts source counts may differ; assert alternatives precede cap relaxation and queue sweep terminates. Upstream shuffled-observation fixture through prepareBatchCandidates must produce same canonical input/result; do not demand reorder invariance for arbitrary tied input arrays where original index is the approved tie-break.
- [ ] Commit only task files: `feat: select a bounded diverse Gemini candidate subset`.

### Task 2: Compact prompt, unchanged output contract

**Files:** modify `src/services/batchPrompt.ts`, `src/types/index.ts`, `test/batchPrompt.test.ts`, `test/batchAnalysis.test.ts`. **Interfaces:** PreparedBatch additions above; existing original candidate mapping remains intact.

- [ ] RED: `prompt_has_compact_candidate_fields` asserts exact keys candidateId/title/snippet/sourceHost/publishedAt and no URL/queryOrdinals on wire; original object retains source URL/title/provenance. `prompt_bytes_include_json_escaping` asserts actual UTF-8<=12288 with quotes, slashes, controls and emoji. `uniform_reduction_then_ordered_tail` pins192→128→96→0 snippets, titles160→128, then only tail removals. `excluded_id_is_rejected` checks analysis validator rejects unsubmitted ID and still binds accepted ID to full original source.
- [ ] RED command: `./node_modules/.bin/tsx --test test/batchPrompt.test.ts test/batchAnalysis.test.ts`.
- [ ] Minimal GREEN: title160, snippet192 after existing whitespace normalization; sourceHost from normalizedUrl hostname, exact when<=128 UTF-8 bytes otherwise null; retain current validated ISO-or-null date. Keep instructions<=3072 bytes, update only removed-field descriptions/redundancy. Keep all current output fields/categories/byte limits, no-filler, untrusted-input protections and detailed/concise rules. Implement exact spec reduction stages with actual serialized byte measurement; reject empty or >24 input and oversized instruction block; no arbitrary replacement candidates. A first Unicode code point always fits title bound, so valid nonempty titles remain useful.
- [ ] GREEN: same command. Replace the obsolete fifty-submitted test with24, while separate full-pool tests stay50. Test192-byte exact boundary/multibyte prefixes (no U+FFFD/split code point), deterministic rerun, tiny/long source host, missing snippet/date, no item fits, and each stage via controlled instruction/input sizes within the3072 limit. Test <=4 detailed-first/concise-rest, scores1–10 and field validation with existing fixtures; no weaker validator or runtime analysisAgent change.
- [ ] Commit only task files: `feat: reduce Gemini batch prompt payload`.

### Task 3: Scheduled low-thinking request

**Files:** modify `src/tools/llm/gemini.ts`, `test/geminiReliabilityV2.test.ts`. **Interfaces:** generateBatchWithGemini unchanged; shared internal request construction branches only when batchContext exists.

- [ ] RED: `scheduled_request_uses_only_low_thinking` inspects mocked fetch URL/body and asserts deepEqual body to `{model:'gemini-3.8-flash',input:originalPrompt,generation_config:{thinking_level:'low'}}`. Check every503 retry uses the identical input/model/config. `legacy_request_shape_unchanged` asserts generateWithGemini does not acquire this new Batch policy. No tools/store/background/temperature/seed/output caps or camelCase thinking fields.
- [ ] RED command: `./node_modules/.bin/tsx --test test/geminiReliabilityV2.test.ts`.
- [ ] Minimal GREEN: add only scheduled request generation_config. Endpoint/headers/response validation/admission/settlement unchanged; invalid config response cannot trigger a compatibility retry/model change.
- [ ] GREEN: same plus `./node_modules/.bin/tsx --test test/geminiUsageGuard.test.ts test/geminiAmbiguityAccounting.test.ts test/geminiAttemptPersistence.test.ts test/geminiFailureClassification.test.ts`. Preserve existing V2 tests rather than duplicate its algorithm:503 max3/durable zero before next dispatch, distinct reservations,429/timeout/transport/invalid/accounting no retry, no fourth, original deadline/cutoff and10s reserve. Do not relax tests to pass the new body.
- [ ] Commit only task files: `perf: use low thinking for scheduled Gemini analysis`.

### Task 4: Bounded latency telemetry and compatibility

**Files:** modify `src/services/monitoringTelemetry.ts`, `src/types/index.ts`, `src/tools/llm/gemini.ts`, `test/monitoringTelemetry.test.ts`, `test/geminiReliabilityV2.test.ts`, `test/workerd/geminiTelemetry.worker.ts`. **Interfaces:** optional latency extension/timing callback/context above. The existing repository already delegates snapshot serialization; no SQL/schema/store API change.

- [ ] RED: `reads_legacy_and_latency_snapshots` checks missing latency remains missing and old data round-trips unchanged. `rejects_unknown_or_sensitive_latency_fields` rejects prompt/body/message/headers and arbitrary keys. Bound all scalars/nulls/array lengths; final full JSON<=8192 bytes. `timing_is_per_dispatch_before_settlement` uses injected wall/monotonic clocks: reserve/settlement/backoff delays do not contaminate request elapsed,75.331s is75331 not75000; actual elapsed>180000 becomes null, not clamp. Pre-dispatch rejection records no invented timing. `timing_checkpoint_failure_never_bypasses_accounting` asserts settlement completes and retries stop.
- [ ] RED commands: `./node_modules/.bin/tsx --test test/monitoringTelemetry.test.ts test/geminiReliabilityV2.test.ts`; `node test/workerd/geminiTelemetry.test.mjs` after adding failing round-trip assertions to its existing isolated worker fixture.
- [ ] Minimal GREEN: retain outer version1/schema_version1. Accept exact legacy key-set or legacy+latency; extension exact fields/version1 only. Limits: input/excluded0..50, selected/byteExcluded/submitted0..24, bytes0..12288, stage192/128/96/0, unique ascending timing ordinals1..3, valid UTC ISO/null, elapsed integer0..180000/null, low/synchronous only; unknown stages null. Validate consistency selected+selectorExcluded=input, submitted+byteExcluded=selected when operands known. Record local timing immediately before actual fetch; freeze at response body/parse completion or terminal transport event before settlement awaits. Keep existing cumulative/clamped attempt elapsedMs unchanged for compatibility; latency has separate semantics.
- [ ] Append timing once per actual dispatch to shared context. Invoke optional callback **after accounting settlement/ambiguity handling**, with the already-frozen duration, before another dispatch; checkpoint rejection marks telemetryObservationFailed/stops retry but never interrupts outstanding accounting or causes re-dispatch. Preserve completed timings if terminal error propagates. Pure timing introduces no new ledger writes, attempts or accounting statuses. Hook remains optional for legacy/local mocks; scheduled composition supplies it in Task5.
- [ ] GREEN: both commands. Workerd fixture uses existing disposable DB only, proves extended snapshot survives read/restart and legacy rows remain valid, with0008 unchanged. Pin old strict validator's expected rejection of extension separately from new reader compatibility; old rollback Worker generates new legacy records and must not read/rewrite historical extended cycles for admission. Prove that path with existing dependency spies and source call-path checks. If a historical read dependency blocks this, stop for Architect amendment; no migration workaround.
- [ ] Commit only task files: `feat: retain bounded Gemini latency observations`.

### Task 5: Pipeline wiring and full-pool fallback proof

**Files:** modify `src/services/monitor.ts`, `src/worker.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`, `test/dailyDigestReliability.test.ts`; create `test/geminiLatencyReliability.test.ts`. **Interfaces:** selector/PreparedBatch/latency contracts from1–4; add WorkerMonitoringDependencyOverrides.onAttemptTiming of the same callback type, passed to scheduled Gemini dependency.

- [ ] RED mandatory test `excluded_analysis_candidate_remains_in_raw_fallback`: build47 valid safe unnotified candidate groups, with an early full-pool candidate excluded from analysis by the host-cap/query policy. Assert selected length24 and target ID absent. Inject terminal Gemini timeout/failure, capture outgoing digest and assert that exact original excluded candidate appears according to existing raw order. Assert full pool remains47, original observedAliases unchanged and passed through; one email attempt; no fabricated analysis for raw item. The test must fail if rawCandidates is incorrectly changed to selected/prepared.candidates.
- [ ] RED companion `filtered_alias_cannot_bypass_notification_history`: an excluded/byte-trimmed alias retains notification evidence and blocks resurfacing; do not erase observedAliases. `success_maps_original_sources` verifies normal response uses only submitted IDs, original title/URL and unchanged full output contract. `no_safe_payload_status_only` asserts one status email, not zero or two. `telemetry_failure_preserves_existing_finalization_policy` pins current admission/fallback behavior.
- [ ] RED command: `./node_modules/.bin/tsx --test test/geminiLatencyReliability.test.ts test/batchMonitoring.test.ts test/workerConfiguration.test.ts test/dailyDigestReliability.test.ts`.
- [ ] Minimal GREEN: leave prepareBatchCandidates unchanged; assign selection to a distinct local variable, pass only it to prepareBatchPrompt. Keep `rawCandidates: pool.candidates` and `observedAliases: pool.observedAliases` exactly. Compute selector exclusions separately from prepared.sizeExcluded; selected count may24 while final submitted count is smaller after byte packing. Source acquisition/order/history touches remain unchanged.
- [ ] Populate batch.latency before sources_complete; retain counts/mode through Gemini/error/final snapshots. Worker timing callback merges cumulative timings into the latest source snapshot and persists same sources_complete phase until Gemini finishes; do not advance gemini_complete between retries. Use existing checkpoint path/UUID, fresh copies of bounded data, no historical read or new observer framework. The final gemini_complete/email/completed snapshots carry the same extension instead of overwriting it. Terminal fallback reason remains existing delivery/attempt evidence. Add optional bounded latency field to ScheduledCycleSummary using the shared allowlist, never raw callback input. All exception/status finalizers preserve latest valid extension.
- [ ] GREEN: same plus `./node_modules/.bin/tsx --test test/notificationReplay.test.ts test/batchCandidates.test.ts test/batchAnalysis.test.ts`. Test ten Brave calls/RSS fixture positions unchanged; full source pool/alias evidence not lost when prompt packing excludes additional IDs; healthy-empty/partial outage/quota-block semantics unchanged; no resend on send/history uncertainty; telemetry callback failure suppresses another retry but does not suppress finalization. Verify final-reader counts, all timings and <=1 email across normal/degraded/status.
- [ ] Commit explicit task files: `feat: integrate latency optimization without shrinking fallback coverage`.

### Task 6: Acceptance, one full verification and governance

**Files:** extend `test/geminiLatencyReliability.test.ts` only for missing end-to-end assertions; update the five governance documents listed in the file map. No extra runtime scope. **Interfaces:** consume1–5 unchanged.

- [ ] RED acceptance gaps: mocked47-input cycle sends<=24 candidates and<=12288 bytes with low thinking; valid model fixture→normal, timeout→full-pool degraded, empty→status; persisted counts/classes/timings remain bounded and one-email guard survives. Add missing assertions and run `./node_modules/.bin/tsx --test test/geminiLatencyReliability.test.ts`. If existing coverage already passes, record it; do not manufacture failures or duplicate the V2 state-machine suite.
- [ ] Minimal GREEN: address only a concrete uncovered integration defect through the owning task's RED test; otherwise documentation evidence only. Never add provider probing or output repair to obtain success.
- [ ] Focused GREEN: `./node_modules/.bin/tsx --test test/batchCandidateSelection.test.ts test/batchPrompt.test.ts test/batchAnalysis.test.ts test/geminiLatencyReliability.test.ts test/geminiReliabilityV2.test.ts test/geminiUsageGuard.test.ts test/geminiAmbiguityAccounting.test.ts test/geminiAttemptPersistence.test.ts test/geminiFailureClassification.test.ts test/monitoringTelemetry.test.ts test/batchMonitoring.test.ts test/workerConfiguration.test.ts test/dailyDigestReliability.test.ts test/notificationReplay.test.ts`.
- [ ] Final offline verification (inspect scripts first; installed dependencies only): `node test/workerd/geminiTelemetry.test.mjs`; `npm test` **once after final changes**; `npm run build`; `npm run worker:typecheck`; `WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/radar-gemini-latency-dry-run`; `git diff --check`. Inspect bundle for forbidden Node filesystem/local JSON/OpenAI/dotenv runtime imports. No unreviewed generated output in commits. If checks fail, fix approved defects and rerun affected checks; repeat full suite only if subsequent changes justify it.
- [ ] Confirm changed-file scope; no migrations/config/secrets/collectors/formatter/accounting state-machine edits. No migration file added or applied;0008 remains applied from prior release,0004 intentionally unapplied. Runtime performance goals are unproven until natural validation; offline assertions cover deterministic caps/shape/budgets only.
- [ ] Actualize governance to IMPLEMENTED / TESTED only for verified new behavior. Production source/Worker remains current baseline until human release; preserve completed delivery/styling/telemetry and partially validated V2 milestones. Record tests, preserved aliases/full pool, no new migration and no production actions. Commit explicit acceptance/governance files: `test: verify Gemini latency reliability and record evidence`.
- [ ] Hand exact Builder head to ONE independent final Analyst review, then Architect/human disposition. No deployment, production observation or integration is triggered by completing this plan.

## Later natural validation — separate human-controlled release

After approved deployment, observe natural Cron only. Initial3 eligible dispatched cycles, extend up to5 scheduled cycles if inconclusive. Admission-blocked cycles remain reported but do not inflate the completion denominator; fewer than3 dispatched cycles within5 means insufficient evidence and a later human-approved window, not manual probes.

Record input/selected/submitted counts, prompt bytes, low/synchronous mode, measured attempt duration, result/fallback reason, normal/degraded/status split, quality, accounting, retry only if exercised, one-email invariant and total runtime. Baseline47 /24303 bytes /75.331s timeout /reported~136.4s runtime; scheduled-to-completed interval137.448s is a different measure. Goals:<=24,<=12288; typical8–12 KiB (small real pools may be below8); median successful Gemini<=45s, comparable cycle<=110s, hard cutoff75s unchanged. All3 successes for early close or >=4/5 if5 dispatched; report every timeout rather than hiding censored values. These small samples do not establish an SLA. Two timeouts or clear quality regression returns to Architect review, never automatic background/model fallback.

Check detailed-first/concise-rest, grounded educational/project value, score/low-score labels, correct source binding and no duplicates. Empty valid selections are not provider failure. Do not infer live provider quality/speed from mocks or add a second inference for comparison.

## Self-review and permanent governance checkpoint

Coverage: selector/diversity→1; compact input/unchanged output validation→2; exact low-thinking payload/V2 regressions→3; bounded optional telemetry/legacy reads/timing→4; full-pool fallback/alias/replay/one email→5; final checks/governance/natural handoff→6. No schema blocker or behavioral spec mismatch found. Requested submittedCandidates/thinkingLevel facts map explicitly to approved stored submittedCount/thinkingMode names; there is no duplicate schema. No implementation plan content authorizes a production action.

Backlog/Plan Actualization Checkpoint: after each major merged/deployed/naturally validated milestone, reconcile backlog.md, plan.md, PROJECT_STATE.md, DAILY_SUMMARY.md and CHANGELOG.md before the next item. Preserve current facts; do not mark latency work deployed/naturally validated from offline checks.

Completed/naturally validated: daily email guarantee, durable cycle telemetry, durable attempt telemetry, degraded redesign. V2 remains deployed/partially naturally validated. Roadmap order remains: latency reliability → latency natural validation → RSS BODY_LIMIT → Threads → combined-source proof → idempotent email → cross-source event dedupe → telemetry-degraded continuity → Workerd CI gate → legacy cleanup → centralize limits → P7/relevance+feedback → stabilization/V1.0.
