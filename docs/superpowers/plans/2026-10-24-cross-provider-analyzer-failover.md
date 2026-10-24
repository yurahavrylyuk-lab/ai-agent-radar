# Cross-provider Analyzer Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native Builder execution, task-by-task, followed by ONE independent final Analyst review. Steps use checkbox syntax. This document does not start implementation.

**Goal:** After three conclusively unavailable Gemini attempts, obtain one bounded Luna analysis or retain existing deterministic delivery.

**Architecture:** Preserve Gemini V2. Add one Worker-native Responses adapter and one narrow D1 accounting table. A coordinator consumes the same PreparedBatch and existing validator, returning the existing BatchAnalysisResult to the unchanged persistence/finalization path.

**Tech Stack:** TypeScript, native fetch/AbortController, Cloudflare D1, existing node:test/tsx/better-sqlite3 and local Workerd/Wrangler. No new dependency/tokenizer.

**Spec:** `docs/superpowers/specs/2026-10-24-cross-provider-analyzer-failover-design.md`, amended from approved `efdddb77dc66f256b9ebf443a0d07f7e1389e854`. Read it before these five tasks. Preserve main `aaa0543ab1b37f4e64a52231136d9787d8845ca5`; use the current design branch unless the human specifies an implementation branch. No worktree or subagent execution in this planning task.

## Global constraints

- This turn changes documentation only; future Builder work begins after plan approval. No push, deployment, credentials, remote D1, live provider/feed call or production migration authorization.
- Only three actual unavailable_503 Gemini dispatches, each durably confirmed_zero, normal exhaustion, no uncertainty, permit Luna. One Luna fetch/cycle, no retry, no third provider. Keep Gemini75s cutoff/backoff unchanged.
- Model gpt-6-luna; Responses; reasoning low; max_output_tokens=12288 INCLUDING reasoning. Exact same PreparedBatch <=24 candidates and prompt <=12288 UTF-8 bytes. No additional discovery/preparation pass.
- Reserve input12288 + output12288 =24576 as a spending budget, not a tokenizer identity. UTC day/week(Monday)/month requests1/7/31 and tokens24576/172032/761856. Exact reported usage replaces reservation; anomaly blocks later Luna. No silent cap increase.
- Luna timeout15000ms through body/parsing; require >=30000ms under BOTH firstGeminiStart+90000 and cycleStart+110000. Preserve5000ms settlement and10000ms finalization allowance. Use one injected monotonic clock; missing timing denies admission.
- Keep full raw pool/aliases for fallback, shared parser, score1–10/current below7 label, max4 stories, replay/dedupe and one final email attempt. At most one email, not guaranteed acceptance; no retry after ambiguous email.
- Missing/invalid Luna config/schema/accounting denies Luna only. Production HTTP health-only, Cron unchanged,0004 unapplied, no X/Threads/generic router.
- Protected untracked design SHA256 `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66` must be unchanged and excluded from all staging. Inspect scripts before executing offline commands.

## Files and interfaces

Create runtime: `src/config/openaiFallback.ts` (fixed settings/schema/quota validation); `src/services/d1OpenAIFallbackUsageStore.ts` (durable admission/settlement); `src/tools/llm/openaiFallback.ts` (one native HTTP attempt); `src/services/batchAnalyzerFailover.ts` (eligibility/coordination). Create only `migrations/0009_openai_fallback_usage.sql` later, not in this Architect task.
Modify runtime: `src/tools/llm/gemini.ts` (expose original monotonic start, no policy change), `src/worker.ts` (optional bindings, composition, redaction, summary), `src/services/monitor.ts` (metric/snapshot plumbing only), `src/services/monitoringTelemetry.ts` (compatible bounded extension), `src/types/index.ts` (metrics). Existing D1 telemetry serializer uses these shared validators; change `src/services/d1MonitoringTelemetry.ts` only if its serialization path needs explicit extension plumbing. Modify `wrangler.jsonc` for six vars only; no required global secret or Cron changes. Existing `radarRuntimeConfiguration.ts` remains unchanged: parse optional Luna settings separately so missing key never breaks Gemini initialization.

Tests: add `test/openaiFallbackTransport.test.ts`, `test/openaiFallbackAccounting.test.ts`, `test/batchAnalyzerFailover.test.ts`; modify `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`, `test/monitoringTelemetry.test.ts`, `test/geminiReliabilityV2.test.ts` for exact seams. Add local-only `test/workerd/openaiFallback.test.mjs`, `.worker.ts`, `.wrangler.jsonc`. Use existing fixture helpers/patterns; no package install or provider script.

## Review focus

1. Crash/response-loss after successful reservation or intent: no reconstructed handle may dispatch (Tasks1/3/5).
2. Incomplete response with plausible valid JSON and exact usage: retain billing, reject analysis, no retry (Task2/3).
3. UTC rollover during admission or settlement: interval counts conserved, no stale-window dispatch (Tasks1/3).
4. D1 late completion after timeout: no late fetch or normal delivery, unresolved evidence retained (Tasks1/3/5).
5. Optional telemetry plus maximum prior snapshot: retain8192-byte total and no secret/content leakage (Task4).

## Task 1 — Durable admission and spending contract

**Files:** new config/store/migration; `test/openaiFallbackAccounting.test.ts`.

**Interfaces:** config exports `OPENAI_FALLBACK` (model,reasoning,maxOutputTokens,inputBudget,outputBudget,reservationTokens,timeoutMs,admissionMs,responseBodyBytes=131072) and `parseOpenAIFallbackLimits(env: Record<string,string|undefined>): OpenAIFallbackLimits | null`; six required positive integers may reduce but not exceed ceilings. No env model override.
Store exports `OpenAIExactUsage = {inputTokens:number;outputTokens:number;totalTokens:number}`, `LunaReservation = {cycleId:string;scheduledAt:string;reservedAt:string;attemptId:string}` and `D1OpenAIFallbackUsageStore` constructed with the existing D1 database interface. Methods: `reserve(cycleId:string, limits:OpenAIFallbackLimits): Promise<LunaReservation|null>`, `markIntent(ref:LunaReservation): Promise<void>`, `markObserved(ref:LunaReservation): Promise<void>`, `settleExact(ref:LunaReservation,usage:OpenAIExactUsage,evidence:LunaEvidence): Promise<void>`, `markUnknown(ref:LunaReservation,evidence:LunaEvidence): Promise<void>`, `cancelBeforeDispatch(ref:LunaReservation): Promise<void>`. `LunaEvidence` carries allowlisted outcome/httpStatus/endedAt/duration only. Expose read-only `read(cycleId)` for reconciliation/tests; it cannot authorize dispatch. Only a successfully returned NEW reserve result is eligible; read-back after reserve exception is never permission.

### Exact table contract (migration to be written by Builder)

Table `openai_fallback_usage`, ordinary SQLite/D1 types, one row per scheduled cycle:

| Columns | Definition |
|---|---|
| cycle_id | TEXT PRIMARY KEY NOT NULL REFERENCES monitoring_cycles(cycle_id) |
| attempt_id | TEXT UNIQUE NOT NULL, runtime-generated UUID, immutable |
| scheduled_at | TEXT UNIQUE NOT NULL, copied from monitoring_cycles, immutable |
| model | TEXT NOT NULL CHECK(model='gpt-6-luna'), immutable |
| reserved_at | TEXT NOT NULL, DB UTC strftime('%Y-%m-%dT%H:%M:%fZ','now'), immutable |
| accounting_through | TEXT NOT NULL, initially reserved_at, never decreases |
| started_at, settled_at | nullable TEXT, valid canonical UTC; started_at set at intent, settled_at only terminal |
| request_count | INTEGER NOT NULL CHECK(request_count=1), immutable; keep count even for cancelled reservation (conservative) |
| reserved_input, reserved_output, reserved_total | INTEGER NOT NULL CHECK values=12288,12288,24576, immutable |
| state | TEXT NOT NULL CHECK IN ('reserved','exact','unknown','cancelled_pre_dispatch') |
| dispatch_status | TEXT NOT NULL CHECK IN ('not_dispatched','intent','observed') |
| input_tokens, output_tokens, total_tokens | nullable INTEGER; exact only, safe integers0..9007199254740991, total=input+output; sum itself must be safe |
| failure_class | TEXT NOT NULL CHECK IN ('none','not_admitted','timeout','transport_error','http_failure','invalid_response','usage_unknown','accounting_failure') |
| http_status | nullable INTEGER CHECK100..599 |
| duration_ms | nullable INTEGER CHECK0..110000, clamped observation, not a clock source |
| budget_anomaly | INTEGER NOT NULL DEFAULT0 CHECK IN(0,1); set on exact usage above any reservation component |

CHECKs: reserved has NULL settled_at/usage; unknown has settled_at and NULL usage; exact has settled_at and all exact usage; cancelled has settled_at, NULL usage and dispatch not observed. Non-exact accounting is not fabricated zero. Validate dates with strftime plus canonical-format validation in adapter; all dates >=reserved_at where applicable, accounting_through>=reserved_at and >=started_at/settled_at. All read rows must pass validation; corrupt/malformed evidence denies admission.

Indexes: unique expression index on `(1)` WHERE state IN('reserved','unknown'); index `(reserved_at,accounting_through)` for window queries. BEFORE INSERT trigger verifies scheduled_at matches cycle and inserts only reserved/not_dispatched/no usage/no anomaly. BEFORE UPDATE trigger rejects identity/budget changes, accounting interval regression, started_at rewriting once set, terminal row changes, unsupported transitions or dispatch regression. Allowed dispatch transitions: not_dispatched→intent→observed, or unchanged. Allowed state transitions from reserved only: exact/unknown/cancelled_pre_dispatch; exact and unknown require at least intent; cancelled may be not_dispatched or intent but caller must prove fetch never invoked. Exact anomaly must equal whether usage exceeds a budget. Unknown/terminal evidence cannot be unlocked/erased by runtime; BEFORE DELETE aborts. These are validation-only triggers; no nested normalization UPDATEs. No auto-retirement/recovery SQL.

### Atomic admission algorithm

One conditional INSERT…SELECT…RETURNING identity (no insert-or-ignore replacing old evidence), DB UTC now. Require monitoring cycle exists, no existing same cycle/scheduled identity, no reserved/unknown/budget-anomaly OpenAI row, valid configured limits, and durable Gemini proof: exactly ordinals1/2/3 in monitoring_gemini_attempts, all unavailable_503/confirmed_zero/settled without accounting_error, matching gemini_usage IDs/model/timestamps/states, third stop/max_attempts. Require gemini_usage_state.usage_unknown=0, no unresolved reserved/transport_ambiguous Gemini row and no inconsistent interval/evidence. Do not infer from error strings. Historical ambiguous rows make this deliberately strict gate fail closed until separately reconciled; do not rewrite them here.

For each UTC [start,end) day/week/month: include rows reserved_at<end AND accounting_through>=start; sum request_count plus1 <= request limit; sum CASE exact THEN total_tokens WHEN cancelled THEN0 ELSE reserved_total END plus24576 <= token limit. Any unresolved state globally blocks irrespective of windows. Bind limits, do not interpolate untrusted input. D1 serialization plus unique constraints closes concurrency race. Distinguish exception/unknown insert outcome from clear no-row admission denial; neither dispatches.

markIntent is a conditional update of NEW reservation identity/state/status, rechecks Gemini proof, unresolved-state exclusivity, limits/windows and no UTC rollover since reservation. Recheck quotas with the existing reservation counted once, not by adding a second reservation. Use exact RETURNING identity or authoritative read-back, not assumptions about trigger-inclusive meta.changes. A failed CAS denies dispatch. Settlement is exact-identity CAS; DB time extends accounting_through, charging crossed windows conservatively. If write success cannot be confirmed, fail closed; surviving reserved is sufficient durable blocking state, even when markUnknown also fails.

- [ ] RED: add local SQLite/D1-adapter fixtures applying0001/2/3/5/6/7/8 and proposed0009 explicitly (exclude0004). Seed three settled503 attempts. Assert `reserve` returns one handle; second same cycle/scheduled cycle and concurrent invocations return no authority. Assert SQL state is reserved before fetch spy can run.
- [ ] RED: test quota boundaries, null/malformed config, exact replacement, incomplete exact billing, anomaly, invalid arithmetic, unknown never zero, terminal mutation/deletion denial, reserve/intent result loss, UTC crossings and absent/inconsistent Gemini proof. `assert.equal(secondReservation, null)`; `assert.equal(row.state,'unknown')`; `assert.equal(row.input_tokens,null)` for ambiguity.
- [ ] Run `./node_modules/.bin/tsx --test test/openaiFallbackAccounting.test.ts`; expect missing module/migration failures initially.
- [ ] Implement only the table/constraints and store/config above, using existing D1 interface/test adapter. Do not touch Gemini schema or local JSON tracker. Check0009 is still free; stop on conflict.
- [ ] Rerun the same test command; require PASS. Verify unrelated migration rows/history unchanged and later0004 applies independently in disposable DB.
- [ ] Commit only task files: `feat: add durable Luna fallback admission and accounting`.

## Task 2 — One bounded Responses request and shared output validation

**Files:** `src/tools/llm/openaiFallback.ts`, config schema, `test/openaiFallbackTransport.test.ts`; reuse `analysisAgent.ts` without changing its validator.

**Interfaces:** `requestLuna(batch:PreparedBatch, deps:{apiKey:string;fetch:typeof fetch;monotonicNow:()=>number;timeoutMs?:number}): Promise<LunaTransportResult>`. Production timeout fixed15000; optional test override cannot enter Worker config. Result has `outcome:'success'|'timeout'|'transport_error'|'http_failure'|'invalid_response'|'usage_unknown'`, `outputText?:string`, `usage:OpenAIExactUsage|null`, `httpStatus:number|null`, `durationMs:number`. `success` means completed envelope with exact usage and usable text; business validation remains coordinator-owned. No D1 or email inside transport.

- [ ] RED: capture request and assert fixed endpoint, POST, redirect:error, model gpt-6-luna, reasoning.effort low, max_output_tokens12288, store:false, stream:false, input strictly equals batch.prompt, no tools/previous-response/background params and exactly one fetch. Assert no SDK imports/retries.
- [ ] RED: fixed strict schema `radar_batch_v1`, all object properties required/additionalProperties:false; schemaVersion integer enum[1], stories maxItems4, existing category enum, score integer1..10, all required prose/ID strings, technologies/projectOpportunities string arrays maxItems8/3. Shared validator still rejects empty/oversized UTF-8 fields, unknown/duplicate IDs, ordering and source substitution. Do not encode dynamic IDs or rank-dependent byte limits into provider schema.
- [ ] RED: completed response with safe usage accepted; malformed JSON, refusal, tool output, multiple ambiguous answers, >128KiB stream, invalid UTF-8, incomplete including max_output_tokens rejected. Exact usage is retained even with invalid/incomplete output; missing/negative/unsafe/mismatched total becomes null/usage_unknown. Require total_tokens in v1; do not add reasoning tokens twice.
- [ ] RED: timeout before headers/during body, transport rejection, HTTP429/503/other, nonsettling/rejecting cancellation, late response; assert one fetch/no retry. HTTP error without valid usage remains unknown; status alone never proves zero.
- [ ] Run `./node_modules/.bin/tsx --test test/openaiFallbackTransport.test.ts`; expect missing adapter failures.
- [ ] Implement native receiver-safe fetch, bounded fatal UTF-8 reader, AbortController through parse, output message extraction; do not assume SDK output_text convenience field exists in REST response. Never log raw errors/content. Validate entire business text later with unchanged parseBatchAnalysis.
- [ ] Add representative boundary fixture:24 candidates, exact12288 prompt bytes, four maximum-valid stories with rich first-story bounds and Unicode; simulated completed envelope reports output tokens <=12288 INCLUDING reasoning. Assert parseBatchAnalysis accepts completed case; same valid text in incomplete/max_output_tokens fails. Fixtures prove contract handling, not model generation: record any available reviewed provider evidence separately. If evidence shows cap inadequacy STOP, do not raise it or issue a live call. No tokenizer required.
- [ ] Rerun focused test plus `./node_modules/.bin/tsx --test test/batchAnalysis.test.ts test/batchPrompt.test.ts`; require PASS.
- [ ] Commit task files: `feat: add bounded Luna Responses transport`.

## Task 3 — Exact failover gate and unchanged Batch pipeline

**Files:** `src/services/batchAnalyzerFailover.ts`, `src/tools/llm/gemini.ts`, `src/worker.ts`, `test/batchAnalyzerFailover.test.ts`, `test/geminiReliabilityV2.test.ts`, `test/batchMonitoring.test.ts`.

**Interfaces:** extend GeminiBatchCycleContext with optional `deadlineStartedAtMonotonic:number` assigned at the EXISTING first-dispatch clock initialization, never recreated. `analyzeBatchWithFailover(batch:PreparedBatch,deps:FailoverDependencies):Promise<BatchAnalysisResult>`; deps contain `primary:()=>Promise<BatchAnalysisResult>`, original Gemini context, cycleId, cycleStartedAtMonotonic, now clock, store, limits, optional apiKey, `requestLuna` injection, and an in-memory per-cycle consumed flag. Coordinator result shape stays unchanged; telemetry sink added in Task4. It calls primary once then considers Luna only on primary failure plus exact positive gate proof. `lunaTimingAllowed(now,firstGeminiStart,cycleStart):boolean` uses remaining>=30000 for both boundaries.

- [ ] RED table tests: Gemini success/empty/503then success→0; exactly3 unavailable_503+confirmed_zero+normal stop→1; timeout/transport/unknown/accounting/429/unclassified/invalid output/quota stop/fewer attempts→0. Include forged context contradicted by D1; zero fetch. Never fall back after a successful primary or parse error from success.
- [ ] RED deadline tests at exactly30000 remaining and one millisecond below, missing start, clock shared with Gemini, delays in reserve/intent; late D1 resolve never fetches. Assert unchanged75s cutoff/backoff and three Gemini max. No rearm of consumed flag.
- [ ] RED ordering spy: reserve durable→intent durable→final time check→fetch→exact usage settlement→shared validator→return. On pre-fetch lost reserve cancel only with proof no fetch; on thrown/lost settlement leave durable reserved/unknown and throw to existing fallback. Unknown/anomaly never normal analysis, no retry even after restart.
- [ ] Run `./node_modules/.bin/tsx --test test/batchAnalyzerFailover.test.ts test/geminiReliabilityV2.test.ts test/batchMonitoring.test.ts`; new gate tests must fail before integration.
- [ ] Implement coordinator and Worker analyze injection. Preserve existing Gemini invalid-output telemetry catch around PRIMARY only, so Luna validation errors do not relabel Gemini attempts. Exact usage settles before business parsing, even when parser rejects. Do not modify discovery, selection persistence or notificationOrchestrator. Preserve original Gemini failure when Luna not admitted; classify Luna failure through bounded telemetry without inventing Gemini failure evidence.
- [ ] GREEN integrated fixtures: Luna valid→normal analyzed digest; malformed/schema/source substitution/incomplete/HTTP/timeout→existing raw degraded fallback when no eligible replay; replay still wins where applicable; valid empty output retains existing no-selection behavior. Assert same PreparedBatch object/content, <=24/12288, full original raw pool/aliases available, unchanged acquisition calls and history dedupe, at most one final email attempt (exactly one when delivery fixture eligible), zero second provider after Luna.
- [ ] Rerun focused commands; require PASS. Commit: `feat: integrate narrow Gemini to Luna failover`.

## Task 4 — Optional configuration and bounded production telemetry

**Files:** `src/worker.ts`, `src/types/index.ts`, `src/services/monitor.ts`, `src/services/monitoringTelemetry.ts`, optional serialization plumbing `src/services/d1MonitoringTelemetry.ts`, config, `wrangler.jsonc`; tests workerConfiguration/monitoringTelemetry/batchAnalyzerFailover.

**Interfaces:** coordinator accepts `onObservation:(value:AnalyzerFailoverObservation)=>void`; this callback updates in-memory bounded snapshot and must not dispatch. Optional snapshot `analyzerFailover` version1, provider=openai/model fixed, eligible boolean, eligibilityReason enum, attempted boolean, dispatchCount0..1, startedAt/endedAt nullable UTC, durationMs0..110000, outcome enum from design, httpStatus nullable, exact usage or null, accountingState, finalAnalyzer gemini|openai|none. Define once in monitoringTelemetry.ts and reuse; no unbounded arrays. Keep final delivery snapshot authoritative.

- [ ] RED config tests: optional OPENAI_API_KEY absent/blank leaves Gemini/degraded functional, invalid/missing six quota vars disable Luna, raises above ceilings denied, arbitrary OPENAI_MODEL ignored, key redacted from every summary/caught error. No startup-required OpenAI secret.
- [ ] RED telemetry tests: legacy and latency-only snapshots readable; new extension<=1024bytes, full snapshot<=8192 with max legacy fields; malformed enums/timestamps/usage rejected, no prompts/titles/snippets/URLs/raw bodies/API keys/error text. Gemini counters/attempt rows remain unchanged when Luna succeeds; finalAnalyzer identifies fresh validation only, not replay.
- [ ] Run `./node_modules/.bin/tsx --test test/workerConfiguration.test.ts test/monitoringTelemetry.test.ts test/batchAnalyzerFailover.test.ts`; expect new assertions fail.
- [ ] Implement optional env typing/separate limits parser, Worker store/transport wiring, six quota vars1/7/31/24576/172032/761856, key redaction; source constants pin model/settings. Pass cycle execution monotonic start from scheduled handler and cycleId from existing telemetry. Missing durable cycle means no Luna. No secret value/configuration action.
- [ ] Wire bounded observation through existing monitor/snapshot sanitizer and completion path. Historical `gemini_complete` phase remains the post-analysis checkpoint; do not alter0008 SQL or use Gemini attempts for Luna. Supplemental snapshot failure cannot authorize retry or bypass accounting. Record rollback reader incompatibility in operator/governance notes; do not claim old readers accept new fields.
- [ ] Rerun focused tests; require PASS. Commit: `feat: expose bounded analyzer failover telemetry`.

## Task 5 — Real-runtime offline proof, full verification and handoff

**Files:** new three Workerd fixture files; governance `backlog.md`, `plan.md`, `docs/self-improvement/PROJECT_STATE.md`, `DAILY_SUMMARY.md`, `CHANGELOG.md`; targeted `AGENTS.md` future-policy reconciliation only for the approved one-Luna exception (do not rewrite unrelated rules/history). Keep Analyst-owned review untouched.

- [ ] RED: local Workerd harness modeled on geminiTelemetry harness, private temp persistence and loopback fixture server, metrics off. Require real D1 reservation-before-fetch, simultaneous admission→one winner, restart with intent/unknown→zero dispatch, exact rows survive restart, triggers/CAS behavior under actual meta.changes, late failed writes never dispatch. Dedicated local fixture config must not use production DB ID or creds.
- [ ] RED: assert native fetch receiver, real streamed response timeout/cancel, one provider-shaped loopback request, no real internet target. Exercise successful max-sized contract fixture and incomplete/max_output_tokens. Assert optional telemetry round-trip after restart. Run `node test/workerd/openaiFallback.test.mjs`; new expectations initially fail until fixture/harness wiring exists.
- [ ] Implement test-only routes/scenarios; never add production manual monitoring endpoint. Rerun local harness; require PASS. Stop/report any D1 semantic mismatch or cap failure rather than loosening safety.
- [ ] Final verification after final edits: `npm test`; `npm run build`; `npm run worker:typecheck`; `node test/workerd/openaiFallback.test.mjs`; `node test/workerd/geminiTelemetry.test.mjs`; `npm run test:rss-workerd`; `WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/radar-failover-dry-run`; `git diff --check`. Inspect scripts first; use installed binaries, no download. Dry-run validates bundle only. Confirm bundle excludes node:fs/local JSON tracker/OpenAI SDK retry dependency; existing V2/latency tests stay green.
- [ ] Actualize governance with actual checks and IMPLEMENTED / OFFLINE-TESTED / NOT DEPLOYED only when true. Preserve production source a1024cb72b1e08c7433e0f954da81f6283f106d3, Gemini mixed cycle1 and RSS awaiting validation. Record migration NOT APPLIED, secret NOT PROVISIONED, pending natural cap/failover proof. Hash protected file again, stage exact task files only, inspect staged diff and `git diff --cached --check`.
- [ ] Commit: `test: verify durable analyzer failover in Workerd`. One independent Analyst reviews exact final head; Architect disposition follows. No task-by-task independent review gates, push/merge/deploy or remote migration in this plan's execution authorization.

## Acceptance mapping / self-review

Requested cases1–8→Task3;9–15→Tasks2/3;16–20→Tasks1/3/5;21–26→Task3;27→Task4;28→Tasks1/5;29→Tasks3/5. Output cap/structured schema→Task2. All five Review Focus cases map above. No business validator fork, generic router or changed acquisition/delivery behavior. Return exact commands/results, runtime/migration diff, accounting evidence and any deviations for independent review.

Release is separate: human review of plan, implementation, independent Analyst, Architect, then explicit human migration/secret/spend/release approval. Migration0009 does not authorize applying0004. Retain unresolved rows across rollback; older snapshot readers may reject new optional fields, so a compatible rollback reader is a release gate. Continue Gemini/RSS natural observation in parallel; after authorized release observe first3 eligible natural failover cycles with an initial5-scheduled-cycle window, label NOT EXERCISED if none. Never force production503s/manual monitoring. Incomplete/output-cap evidence that contradicts reliability requires bounded design amendment, not a silent cap increase.
