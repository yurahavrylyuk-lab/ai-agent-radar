# Gemini Reliability V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native Builder execution task-by-task; one independent final Analyst review follows. Steps use checkbox (`- [ ]`) syntax. This document does not start implementation.

**Goal:** Make scheduled Gemini failures durably diagnosable, retry only proven-zero transient 503 failures safely, and polish the existing degraded digest without changing selection or daily delivery guarantees.

**Architecture:** Keep the existing scheduled Batch pipeline and one-email finalizer. Add bounded cycle/attempt evidence in existing D1, bind accounting settlement to attempt outcomes, then introduce max-three same-model retry with one shared deadline. Isolate snippet/formatter work from persistence/accounting.

**Tech Stack:** Node 24, TypeScript, existing node:test/tsx, better-sqlite3 fixtures, Cloudflare Worker/D1 and installed Wrangler/Workerd; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-gemini-reliability-v2-design.md`, approved at `19ade824b7ca301afe666508d587c8b225093966`. Human approval in the planning request supersedes that immutable document's awaiting-review label. Production remains `0df2c2399c76b4c7c518119b6a8511a300ef9aee`.

## Global constraints

- Planning branch: `codex/gemini-reliability-v2-design`; this planning task changes/commits only this document. No new branch/worktree. Builder execution requires subsequent plan approval and its approved working context.
- Daily delivery is COMPLETED / NATURALLY VALIDATED. V2 is not implemented/deployed yet. No new production-validation claims from offline tests.
- Same approved model, normally one actual dispatch, max THREE; only reviewed 503 plus durable confirmed_zero can retry. Reviewed 429 never retries. Unknown, timeout, transport, response_invalid and accounting failures never retry.
- One original 90-second envelope; stop Gemini dispatch/body/parsing by +75 seconds. Backoff 1500–2000 ms then 3000–4000 ms; at least 10 seconds must remain after delay before retry. No fresh deadline, model/provider fallback, new quota or background execution.
- Preserve exact accounting identity/transitions, conservative intervals and ambiguity; no guessed zero, automatic recovery or legacy latch changes. Fallback/finalizer may run beyond the envelope; the 15-second reserve is opportunity, not a platform-delivery guarantee.
- Four stories, one final email attempt, existing analyzed scores/labels, replay/dedupe/history and deterministic raw/status fallback unchanged. Brave/RSS limits/acquisition unchanged; RSS body_limit fix excluded; X disabled, 0004 intentionally unapplied. No Threads, cleanup, ranking change or new notification channel.
- Only disposable offline test databases may execute migration SQL. Never run `npm run d1:migrate:local`, a repository/production migration apply, remote D1, providers, live monitoring, push, merge or deploy. Do not install/download dependencies.
- Migration artifact gate: **MIGRATION_READY_FOR_HUMAN_APPROVAL**. Creating/testing SQL is not permission to apply it to the application database.
- Preserve unrelated files. Stage explicit task files only. Tests below are future Builder instructions, not tests claimed run by this plan.

## Review focus

1. Process death between dispatch intent and actual fetch must leave unknown dispatch evidence, not a fabricated exact count (Tasks 3/5).
2. A zero-row settlement CAS inside D1.batch must not commit a falsely settled attempt (Tasks 2/3).
3. Successful usage settlement followed by invalid selection JSON must remain exact accounting plus response_invalid, never retry (Tasks 1/3/4).
4. Telemetry failure after Resend acceptance must not cause replacement email or overwrite known acceptance with failure (Task 5).
5. Mixed raw/replayed cards and encoded malformed markup must preserve truthful labels and safe text (Tasks 6/7).

## File map and interfaces

New files: `src/services/geminiFailureClassification.ts` (closed classifier), `src/services/monitoringTelemetry.ts` (types/validation), `src/services/d1MonitoringTelemetry.ts` (D1 cycle/attempt repository), `src/services/degradedSnippet.ts` (plain text helper); migration/test files identified below. Keep existing adapter/finalizer boundaries, no generic event framework.

### Shared contract (Tasks 1–3)

- `GeminiFailureClass = 'none' | 'unavailable_503' | 'resource_exhausted_429' | 'unclassified_http_error' | 'timeout' | 'transport_error' | 'response_invalid' | 'accounting_failure'`.
- `classifyGeminiHttpFailure(status: number, parsed: unknown, model: ApprovedGeminiModel): GeminiFailureClass`. Uses existing reviewed predicates; status remains separately bounded 100..599/null. No prose-based inference. Local failure paths select the other closed classes explicitly.
- `AttemptRef = { cycleId: string; ordinal: 1 | 2 | 3 }`.
- `CycleStart = { cycleId: string; scheduledAt: string; startedAt: string; sourceSha: string | null; workerVersion: string | null }`; UTC ISO dates, UUID invocation identity, source SHA exactly 40 hex, version UUID or null. Existing bindings lack release metadata: use null unless a trusted injected release value exists; do not add configuration/deployment work or infer from local HEAD.
- `CyclePhase = 'started' | 'sources_complete' | 'gemini_complete' | 'email_attempting' | 'completed'`.
- `CycleSnapshotV1` has exactly: `version: 1`, `braveHealth`, `rssHealth`, `outage`, `candidateCounts`, `geminiDispatchCount`, `delivery`, `accounting`. Health/outage are null until observed, otherwise existing approved enums/boolean. `candidateCounts = { received, unique, submitted }`, nullable counters (received/unique safe integers 0..100000, submitted 0..50; reject out of bounds, never silently clamp). Dispatch count is 0..3 or null if unknown. `delivery` is null or existing `ScheduledCycleSummary['delivery']` with each existing field allowlisted (counts 0..4, emailAttempts 0..1). `accounting = { reserved, exact, confirmedZero, ambiguous, unavailable }`, each count 0..3 and boolean unavailable. No free-form error/outcome strings. Reject extra keys and snapshots exceeding 8192 UTF-8 bytes at write/read boundaries; never truncate JSON.
- `AttemptEvidence = { failureClass: GeminiFailureClass; httpStatus: number | null; accountingError: boolean; observedAt: string }`.
- `AttemptSettlement = { kind: 'exact'; usage: GeminiUsageSettlement; evidence: AttemptEvidence } | { kind: 'confirmed_zero'; evidence: AttemptEvidence } | { kind: 'transport_ambiguous'; reason: GeminiAmbiguityReason; evidence: AttemptEvidence }`. Uses existing usage/reservation types. Confirmed-zero proof remains adapter-owned, not supplied by arbitrary HTTP status.
- `RetryDecision = 'not_evaluated' | 'retry' | 'stop'`; `RetryReason = 'none' | 'retryable_503' | 'non_retryable' | 'max_attempts' | 'deadline' | 'quota' | 'accounting' | 'telemetry' | 'cancelled'`.
- `MonitoringTelemetry` methods: `createCycle(start: CycleStart): Promise<void>`; `checkpoint(cycleId: string, phase: CyclePhase, snapshot: CycleSnapshotV1): Promise<void>`; `bindAttempt(ref: AttemptRef, reservation: GeminiUsageReservation): Promise<void>`; `markDispatchIntent(ref: AttemptRef): Promise<void>`; `markDispatchObserved(ref: AttemptRef): Promise<void>`; `recordEvidence(ref: AttemptRef, evidence: AttemptEvidence): Promise<void>`; `recordRetryDecision(ref: AttemptRef, decision: RetryDecision, reason: RetryReason): Promise<void>`; `completeCycle(cycleId: string, snapshot: CycleSnapshotV1): Promise<void>`; `readCycle(cycleId: string): Promise<{ cycle: CycleStart; phase: CyclePhase; snapshot: CycleSnapshotV1; attempts: PersistedAttempt[] } | null>`. Define `PersistedAttempt` as typed mapping of the exact attempt columns below.
- `D1MonitoringTelemetry(db: D1Database)` implements this boundary. Extend `D1GeminiUsageStore` with `settleObservedAttempt(ref: AttemptRef, reservation: GeminiUsageReservation, outcome: AttemptSettlement): Promise<void>`; this owns atomic accounting/attempt writes using the same DB. Do not change legacy `GeminiUsageStore` required methods or JSON persistence behavior.
- Add optional `GeminiDependencies.attemptTelemetry: { repository: MonitoringTelemetry; cycleId: string; settle: (ref: AttemptRef, reservation: GeminiUsageReservation, outcome: AttemptSettlement) => Promise<void> }`. Production scheduled composition MUST supply it; optionality supports existing legacy/offline adapters, not a deployed telemetry bypass.

### Exact additive migration contract (Task 2)

Next available file: **`migrations/0008_monitoring_cycle_observability.sql`**. Create only these tables, indexes and telemetry-table validation triggers; do not alter/drop existing tables/triggers or rewrite historical rows.

| Table | Columns |
| --- | --- |
| `monitoring_cycles` | `cycle_id TEXT PRIMARY KEY NOT NULL`; `scheduled_at TEXT NOT NULL`; `started_at TEXT NOT NULL`; `updated_at TEXT NOT NULL`; `completed_at TEXT NULL`; `source_sha TEXT NULL`; `worker_version TEXT NULL`; `schema_version INTEGER NOT NULL DEFAULT 1 CHECK (=1)`; `phase TEXT NOT NULL` checked against CyclePhase; `snapshot_json TEXT NOT NULL` with json_valid and length(CAST(... AS BLOB)) <=8192 |
| `monitoring_gemini_attempts` | `cycle_id TEXT NOT NULL REFERENCES monitoring_cycles(cycle_id)`; `ordinal INTEGER NOT NULL CHECK BETWEEN 1 AND 3`; `usage_id INTEGER NOT NULL UNIQUE REFERENCES gemini_usage(id)`; `model TEXT NOT NULL` checked against approved model enum; `started_at TEXT NOT NULL`; `updated_at TEXT NOT NULL`; `ended_at TEXT NULL`; `dispatch_status TEXT NOT NULL` enum `not_dispatched, intent, observed`; `failure_class TEXT NOT NULL` closed taxonomy default none; `http_status INTEGER NULL` 100..599; `accounting_status TEXT NOT NULL` enum `reserved, exact, confirmed_zero, transport_ambiguous, unresolved`; `accounting_error INTEGER NOT NULL` boolean; `settlement_status TEXT NOT NULL` enum `pending, settled, unresolved`; `retry_decision TEXT NOT NULL` RetryDecision; `retry_reason TEXT NOT NULL` RetryReason; PRIMARY KEY(cycle_id,ordinal) |

Index: `monitoring_cycles_scheduled_at_idx ON monitoring_cycles(scheduled_at,cycle_id)`; existing composite attempt PK supports ordered reads and usage_id UNIQUE supplies linkage lookup. No redundant indexes, retention job or delete cascade. Validate UTC/monotonic timestamps and complete-phase/completed_at consistency. Cross-field repository validation rejects inconsistent accounting/settlement statuses and out-of-order phase regression; exception finalization may skip phases but cannot invent source observations.

Telemetry-table triggers enforce immutable cycle/ordinal/usage/model/start identity and matching usage model/reservation timestamp. An attempt transition to settled must match the authoritative linked usage outcome. Atomic settlement still compares the full immutable reservation tuple using existing SQL guards. A batch that fails a guard must abort, not merely return zero updated rows. Achieve this with an unconditional identity-targeted attempt update whose validation trigger uses RAISE(ABORT) on usage/outcome mismatch; prevalidate attempt existence/identity and verify resulting row. Conflicting terminal replays reject; identical committed outcomes may be read back idempotently after uncertain acknowledgement. Never trust meta.changes===1 as sole proof.

`dispatch_status=intent` is written before fetch; crash there cannot establish actual dispatch. `observed` is persisted only once invocation of fetch is known on a live path; if interruption prevents it, leave intent and count unknown. Final complete live-cycle counts must exactly equal adapter dispatch accounting; incomplete evidence never guesses. A proven pre-dispatch rejection can settle zero while status remains not_dispatched; it does not count as an actual request dispatch.

## Phase A — classification

### Task 1: Closed failure contract

**Files:** create `src/services/geminiFailureClassification.ts`, `test/geminiFailureClassification.test.ts`; modify `src/types/index.ts`, `src/tools/llm/gemini.ts`; extend `test/geminiUsageGuard.test.ts` only for boundary evidence assertions. **Interfaces:** classifier/GeminiFailureClass above; retain legacy reviewed-failure accessor compatibility, extend Batch evidence separately.

- [ ] RED: table-driven `classifies_only_reviewed_http_evidence`: accepted 503 absent/UNAVAILABLE status → unavailable_503; valid model-specific 429 → resource_exhausted_429; malformed/mixed/foreign-model details, 401/403 and arbitrary provider prose → unclassified_http_error; preserve observed status without granting zero. `local_failures_are_closed` pins timeout/transport/invalid/accounting classes. `settlement_failure_preserves_observed_provider_class` asserts separate accountingError. Assert canary provider messages never appear in serialized evidence.
- [ ] RED command: `./node_modules/.bin/tsx --test test/geminiFailureClassification.test.ts test/geminiUsageGuard.test.ts`. Expect missing classifier/new-contract assertions, not infrastructure errors.
- [ ] Implement only predicate extraction, closed types and adapter evidence mapping. Do not change retry counts yet or loosen existing zero proofs. A valid usage response with invalid selection retains exact accounting and response_invalid downstream.
- [ ] GREEN: same command; all tests pass, existing accounting behavior unchanged.
- [ ] Commit explicit task files: `feat: define bounded Gemini reliability outcomes`.

## Phase B — durable evidence

### Task 2: D1 model, migration and repository

**Files:** create `src/services/monitoringTelemetry.ts`, `src/services/d1MonitoringTelemetry.ts`, `migrations/0008_monitoring_cycle_observability.sql`, `test/monitoringTelemetry.test.ts`, `test/monitoringTelemetryMigration.test.ts`; modify `test/d1Adapters.test.ts` only for shared fixture compatibility if needed. **Interfaces:** shared contract and exact schema above.

- [ ] RED: `migration_is_additive` compares all old row bytes/values and sqlite_schema definitions before/after 0008; two invocations on one date stay distinct; test duplicate usage, ordinal4, invalid enum/status/time, oversized JSON/unknown keys, identity mutation and phase regression rejection. Repository tests pin ordered fresh-instance recovery, null unknown health/version, exact snapshot allowlist, idempotent identical writes versus conflicting updates, UTF-8 byte bound and no provider canary leakage.
- [ ] RED command: `./node_modules/.bin/tsx --test test/monitoringTelemetry.test.ts test/monitoringTelemetryMigration.test.ts` (missing artifact/repository initially).
- [ ] Implement schema, types, strict serialization and repository methods only. Use disposable SQLite fixtures through 0001→0002→0003→0005→0006→0007→0008, seeding the exact existing row22 migration fixture where 0007 requires it. Never weaken 0007 guards to make fixtures pass. Omit 0004 from production-shape fixture; separate disposable compatibility test may verify it still applies without authorizing production application.
- [ ] GREEN: same command plus `./node_modules/.bin/tsx --test test/d1Adapters.test.ts`; old usage and row17 placeholders stay unchanged. Migration status **MIGRATION_READY_FOR_HUMAN_APPROVAL**; continue offline implementation, not application migration.
- [ ] Commit explicit task files: `feat: add bounded D1 cycle telemetry schema`.

### Task 3: Atomic accounting and attempt persistence

**Files:** modify `src/services/d1GeminiUsageStore.ts`, `src/services/d1MonitoringTelemetry.ts`, `src/tools/llm/gemini.ts`; create `test/geminiAttemptPersistence.test.ts`, `test/workerd/geminiTelemetry.test.mjs`, `test/workerd/geminiTelemetry.worker.ts`, `test/workerd/geminiTelemetry.wrangler.jsonc`. **Interfaces:** settleObservedAttempt and optional attemptTelemetry boundary above; existing reserveRequest/confirmZeroRequest semantics remain authoritative.

- [ ] RED: `zero_settlement_and_class_are_atomic`, `cas_zero_cannot_settle_attempt`, `rollback_on_attempt_write_failure`, `identical_replay_does_not_double_settle`, `conflicting_replay_rejects`, `attempt_bind_failure_never_dispatches`, `exact_usage_invalid_selection_stays_exact`, `ambiguity_is_not_zero`, `interruption_leaves_truthful_incomplete_evidence`. Assert separate reservation IDs, no fetch after failed bind, no stranded reservation on recoverable pre-fetch failures, original unresolved protection when cleanup fails, and no silent accounting/telemetry disagreement.
- [ ] RED commands: `./node_modules/.bin/tsx --test test/geminiAttemptPersistence.test.ts test/geminiAmbiguityAccounting.test.ts`; `node test/workerd/geminiTelemetry.test.mjs` after adding the failing local fixture. Workerd harness follows existing RSS harness, installed Wrangler, loopback only, metrics disabled, temporary persistence directory, isolated fake DB identity, no secrets/provider fetch, finally cleanup. Execute SQL only in that disposable DB, never root Wrangler config.
- [ ] Implement reserve→bind→intent→fetch sequence; failed bind/intent before fetch uses proven pre-dispatch cleanup. After fetch is invoked, attach response/error handlers immediately; record dispatch observation without abandoning that in-flight response on telemetry failure. Such failure suppresses further retries, while response/timeout accounting still completes through the existing safety paths. Persist observed HTTP/class evidence before settlement; atomically guarded usage settlement plus attempt outcome for exact/zero/ambiguous paths. Durable settlement failure stops further dispatch even if console classified a retryable503. Preserve provider class when marking accountingError; do not relabel uncertainty as zero. Use injected transaction failure points, not production repair code.
- [ ] GREEN: both commands; real Workerd tests must validate batch rollback and changes/RETURNING semantics, not rely solely on SQLite shim. Shutdown between checkpoints, reopen isolated DB and prove records remain recoverable without console logs. No automatic recovery of genuinely stranded rows.
- [ ] Commit explicit task files: `feat: persist Gemini attempt evidence with accounting`.

## Phase C — retry and Worker integration

### Task 4: Retry V2 and single deadline

**Files:** modify `src/tools/llm/gemini.ts`, `src/types/index.ts`; create `test/geminiReliabilityV2.test.ts`; update `test/geminiUsageGuard.test.ts`, `test/geminiAmbiguityAccounting.test.ts` only where scheduled Batch expectations intentionally change. **Interfaces:** existing generateBatchWithGemini/cycle context and injected monotonicNow/random/sleep; add `GEMINI_BATCH_CUTOFF_MS=75000`, `MAX_GEMINI_BATCH_DISPATCHES=3`. Keep legacy generateWithGemini policy unchanged.

- [ ] RED: `three_503_dispatches_and_no_fourth` asserts IDs all distinct, three request counts, settled zero before each retry and terminal fallback after third. Table-test 429, timeout, network/body error, response_invalid, accounting_failure, unknown HTTP → one actual dispatch/no retry. Test zero-dispatch admission denial, quota loss before retry, failed durable class write, double-call shared context, interrupted sleep and no late dispatch after deadline.
- [ ] RED command: `./node_modules/.bin/tsx --test test/geminiReliabilityV2.test.ts test/geminiUsageGuard.test.ts test/geminiAmbiguityAccounting.test.ts`.
- [ ] Implement scheduled-only state machine: immutable batch/model, consume attempt before fetch; retry requires unavailable_503 AND matching durable zero outcome AND remaining allowance/quota/time. Sample integer jitter 0..500 then 0..1000 over bases1500/3000. Start original clock at first dispatch; absolute cutoff firstDispatch+75000 includes body read/parse and sleep; original envelope remains +90000. Require >=10000 ms after delay and recheck after sleep/reservation. Never extend timeout through dependency overrides; smaller test deadlines may shorten it.
- [ ] GREEN: same command; fake-clock assertions pin both jitter extrema, max6000 ms total sleep, exactly10000 ms boundary, exhausted-time skip without sleep, no body/parsing completion accepted after cutoff and late promise ignored. Abort outgoing request at cutoff; asynchronous cleanup may finish later but must not resume Gemini. Assert ambiguous timeout retains unknown tokens and existing day block. Accounting cleanup/fallback are not aborted by the provider timer.
- [ ] Commit explicit task files: `feat: bound Gemini retries by durable failure evidence`.

### Task 5: Scheduled cycle checkpoints and delivery isolation

**Files:** modify `src/worker.ts`, `src/services/monitor.ts`, `src/services/notificationOrchestrator.ts`, `src/types/index.ts`; extend `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`, `test/dailyDigestReliability.test.ts`. **Interfaces:** add optional `BatchMonitoringDependencies.onTelemetryCheckpoint?: (phase: 'sources_complete' | 'gemini_complete', snapshot: CycleSnapshotV1) => Promise<void>`; scheduled composition always supplies it. Add optional `beforeEmailAttempt?: () => Promise<void>` to the existing finalizeDailyDigest second-argument dependency object at its existing guarded-send boundary, handled non-throwingly. Reuse MonitoringTelemetry.completeCycle; generate one UUID per scheduled invocation and retain the same daily-email/Gemini contexts through exception finalization.

- [ ] RED: fresh reader recovers source checkpoint before Gemini, complete cycle after email and bounded attempts after console loss; two same-day invocations do not overwrite. Failure injection at cycle-create/source-write skips Gemini but still produces at most one fallback/status send; email checkpoint failure still sends once; post-acceptance final write failure never sends twice. Persist unknown/incomplete on termination. Known terminal live-cycle actual dispatch counts equal context/reservations/attempts; intent-only interrupted records do not falsely count as observed dispatches.
- [ ] RED command: `./node_modules/.bin/tsx --test test/batchMonitoring.test.ts test/workerConfiguration.test.ts test/dailyDigestReliability.test.ts`.
- [ ] Compose D1 telemetry and atomic settlement callback in Worker; establish cycle before provider work, checkpoint source evidence before Gemini, persist Gemini result before finalizer, email_attempting before guarded transport and completed after final result. Build snapshots with allowlists, never copy console error arrays into D1. Checkpoint failure at sources must prevent Gemini even if callback is otherwise caught; finalization remains available. Catch telemetry exceptions separately from delivery exceptions; do not replace known accepted delivery with status fallback. Update bounded console attempt cap from2 to3, retaining secret scrubbing.
- [ ] GREEN: same command plus `./node_modules/.bin/tsx --test test/notificationReplay.test.ts`. Pin existing healthy-empty, partial RSS, all-source outage, quota-blocked distinctions; normal/degraded/status paths each <=1 final email attempt, four-story cap, unchanged pool/replay/alias ordering, raw no-fake-analysis and no-resend behavior. Successful exact accounting followed by analysis validation failure records response_invalid via the same attempt ref without rewriting exact usage. Permit only the bounded none→response_invalid post-analysis refinement for that exact attempt; other conflicting terminal evidence remains rejected.
- [ ] Commit explicit task files: `feat: persist scheduled cycle outcomes without risking delivery`.

## Phase D — presentation only

### Task 6: Plain degraded snippets

**Files:** create `src/services/degradedSnippet.ts`, `test/degradedSnippet.test.ts`. **Interfaces:** `cleanDegradedSnippet(input: string | undefined): string`; bound scan input to first8192 UTF-8 bytes at a complete code-point boundary; output <=768 UTF-8 bytes.

- [ ] RED: strong Hello → Hello; nested tags → plain words; amp/lt/gt/quot/apos/nbsp decode once; double-encoded entities do not recursively decode; script/style blocks lose contents; incomplete markup tails omitted; controls removed, whitespace collapsed; empty input → empty; long multibyte output <=768 bytes with no broken code point. Add adversarial unmatched `<`, quoted `>` and encoded script delimiters to pin bounded scanner behavior and no markup output.
- [ ] RED command: `./node_modules/.bin/tsx --test test/degradedSnippet.test.ts`.
- [ ] Implement the approved linear scanner, including quoted tag attributes and safe omission on unterminated tags/script/style. Strip tags, decode only approved entities once, remove decoded tag constructs, normalize whitespace, UTF-8 truncate. Never evaluate HTML, decode numeric/unlisted entities or escape HTML inside this plain-text helper. Unknown entities stay literal and will be escaped by rendering.
- [ ] GREEN: same command; test input bound and linear progress, not fragile wall-clock benchmarks.
- [ ] Commit explicit task files: `feat: clean bounded degraded digest snippets`.

### Task 7: Reuse normal email styling

**Files:** modify `src/services/discoveryEmailFormatter.ts`, `test/discoveryEmailFormatter.test.ts`; extend `test/dailyDigestReliability.test.ts` for mixed-card truthfulness only. **Interfaces:** preserve formatDailyDigestEmail signature; consume cleanDegradedSnippet; extract only small private shared shell/card helpers as necessary.

- [ ] RED: degraded HTML uses existing dark page/card/panel/text/accent tokens and table/inline styles, header `AI AGENT RADAR — DAILY DIGEST`, badge `DEGRADED MODE`, indexed cards, safe hostname, styled `View source`, shared footer. Raw cards have neither score nor `It could be relevant`/AI summary. Mixed analyzed low-score replay keeps its own analyzed label and prior provenance. No selections after successful Gemini uses truthful highlights copy, not unavailable. Status-only has shell with no fabricated stories.
- [ ] RED command: `./node_modules/.bin/tsx --test test/discoveryEmailFormatter.test.ts test/dailyDigestReliability.test.ts test/degradedSnippet.test.ts`.
- [ ] Implement formatter-only reuse. Unavailable copy: `AI analysis was temporarily unavailable. These stories were selected directly from today's discovery results.` Qualify replay separately. Clean once for both text/html, escape at HTML interpolation, use existing safe HTTP(S) validation; invalid URL must be non-clickable and must not throw during hostname extraction. No external CSS/scripts/dependencies. Selection, subject policy and send semantics unchanged.
- [ ] GREEN: same command. Assert title/source/snippet escaping, malicious URLs, script-like snippets, four cards/missing snippet, useful plain text with numbered titles/source/URL. Render representative HTML locally and inspect wide/narrow viewport, long titles and mixed replay; no email send. Normal digest regression stays green.
- [ ] Commit explicit task files: `feat: style degraded digests with the existing email theme`.

## Phase E — acceptance and governance

### Task 8: Integration regression, full verification and actualization

**Files:** extend `test/dailyDigestReliability.test.ts`, `test/geminiReliabilityV2.test.ts`, `test/monitoringTelemetry.test.ts`, `test/workerd/geminiTelemetry.test.mjs` only for cross-boundary gaps; update `backlog.md`, `plan.md`, `docs/self-improvement/PROJECT_STATE.md`, `docs/self-improvement/DAILY_SUMMARY.md`, `docs/self-improvement/CHANGELOG.md`. No deployment/config/migration-application files. **Interfaces:** consume Tasks1–7 contracts unchanged; introduce no new runtime boundary.

- [ ] RED: add end-to-end offline `503_503_503_persists_three_then_one_degraded_email`, `429_persists_one_then_degraded`, `no_payload_status_only`, `accounting_or_telemetry_failure_still_finalizes`, `source_health_survives_missing_console`; assert no fourth request, exact IDs/counts/classes and final fresh-instance D1 read. Use mocked providers, not live endpoints. Run `./node_modules/.bin/tsx --test test/dailyDigestReliability.test.ts test/geminiReliabilityV2.test.ts test/monitoringTelemetry.test.ts`. Add only missing integration assertions; already passing paths need no manufactured failure.
- [ ] Minimal implementation: fix only integration omissions within Tasks1–7; return to the relevant task's RED test for any discovered defect. Update governance from actual Builder results, never from expected counts.
- [ ] GREEN focused command: `./node_modules/.bin/tsx --test test/geminiFailureClassification.test.ts test/geminiReliabilityV2.test.ts test/geminiUsageGuard.test.ts test/geminiAmbiguityAccounting.test.ts test/geminiAttemptPersistence.test.ts test/monitoringTelemetry.test.ts test/monitoringTelemetryMigration.test.ts test/d1Adapters.test.ts test/batchMonitoring.test.ts test/workerConfiguration.test.ts test/degradedSnippet.test.ts test/discoveryEmailFormatter.test.ts test/dailyDigestReliability.test.ts test/notificationReplay.test.ts`.
- [ ] Run `node test/workerd/geminiTelemetry.test.mjs`; fresh temporary DB only. Then full suite once: `npm test`; `npm run build`; `npm run worker:typecheck`; `WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/radar-gemini-v2-dry-run`; `git diff --check`. Inspect scripts first, use installed dependencies only; do not switch to live verification if a local harness is unavailable. Inspect bundle for forbidden Node filesystem/local JSON/OpenAI/dotenv runtime inclusion. Generated types/build outputs must not silently expand the commit scope.
- [ ] Record evidence explicitly: max3; 429/timeout/ambiguity no retry; shared90 envelope/cutoff75; durable prior settlement; one final send; deterministic fallback unchanged; Brave/RSS and body_limit unchanged; no X activation; 0004 untouched/unapplied; 0008 exists and has been executed only inside disposable fixtures, NOT applied to application/production D1. Do not query production merely to establish these facts.
- [ ] Mark new scope IMPLEMENTED / TESTED only where checks pass; migration **MIGRATION_READY_FOR_HUMAN_APPROVAL**. Preserve current production source/Worker and daily delivery NATURALLY VALIDATED milestone. Record remaining human migration/deployment gates and natural-validation items. Commit explicit acceptance/governance files: `test: verify Gemini reliability v2 and record implementation evidence`.
- [ ] Handoff exact Builder head and tests to ONE independent final Analyst review, then Architect disposition/human release decision. No production migration/deployment/monitoring is part of this plan. A failed or unavailable mandatory check blocks completion; never claim it passed.

## Self-review and coverage

Eight tasks in dependency order 1→2→3→4→5→6→7→8; phases A/B precede risky retry activation, D remains formatter-only. Classification/privacy→1–3; additive schema/atomic accounting→2–3; retry/time/quota→4; durable cycle/source health/delivery isolation→5; snippets/style→6–7; full regression and governance→8. All approved requirements map to these tasks.

No behavioral spec/plan mismatch. Schema columns and interfaces make the approved design concrete. The original spec awaiting-review label is historical; human approval is recorded above without editing that document. “No stuck reservation” means no avoidable reservation leak on handled failures, not permission to conceal platform termination or failed persistence; uncertain rows stay protected under the approved recovery rules. Migration testing is restricted to disposable fixtures, not application migration. No implementation or test pass is claimed by this plan.

## Backlog/Plan Actualization Checkpoint

After each major merged/deployed/naturally validated milestone, reconcile `backlog.md`, `plan.md`, `PROJECT_STATE.md`, `DAILY_SUMMARY.md`, and `CHANGELOG.md` before the next major item. Distinguish IMPLEMENTED / TESTED, DEPLOYED, PARTIALLY NATURALLY VALIDATED and NATURALLY VALIDATED. No invented release evidence; retain human migration gate and actual historical provenance.

COMPLETED / NATURALLY VALIDATED: Daily email delivery guarantee.

1. Gemini Reliability V2
2. Degraded email visual redesign
3. Production validation
4. RSS BODY_LIMIT reliability
5. Threads
6. Brave + RSS + Threads production proof
7. Legacy cleanup
8. Centralize pipeline limits
9. P7 / relevance + feedback
10. Final stabilization / V1.0
