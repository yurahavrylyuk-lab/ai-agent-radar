# Idempotent Email Delivery Implementation Plan

> **For agentic workers:** After human approval of this plan, use `superpowers:executing-plans` for sequential Builder execution. Steps use checkbox syntax. Stop after Builder verification for independent Analyst review; do not merge, migrate production or deploy automatically.

**Goal:** Make each scheduled logical daily email durably identifiable, safely recover ambiguous sends within Resend's window, and repair notification history without resending an accepted daily digest.

**Architecture:** One D1 daily delivery ledger plus Resend Idempotency-Key and frozen exact request bytes. Fenced, conditional D1 mutations finish before the provider request; uncertain writes are reconciled against authoritative reads. Existing notifications alone remain cross-day story-delivery history.

**Tech stack:** Existing TypeScript/Node 24, Worker Web Crypto/native fetch, D1, node:test/tsx, better-sqlite3 and local Wrangler/Workerd. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-26-idempotent-email-delivery-design.md` (2026-10-29 amendment).

**Status:** PLAN READY / AWAITING HUMAN REVIEW. Written 2026-11-06 at the human-requested `2026-11-04` filename. The current request formally approves the design, superseding its historical awaiting-approval label. This plan does not alter that file or the existing uncommitted governance work. No implementation has occurred.

## Evidence and boundaries

Inspected existing physical checkout `/Users/yuriy/Documents/IT Study/General/IT WORK/AI Agents/The AI Monitoring Agent`, main `9439220e953c4f01ac198c559de73b50700be325`. Existing modifications: backlog.md, plan.md, PROJECT_STATE.md, DAILY_SUMMARY.md and CHANGELOG.md; existing untracked design files dated 2026-10-12 and 2026-10-26. Preserve all of them; no reset, worktree, automatic staging or broad audit. `ARCHITECT_PLAN.md` is marked historical/superseded; `ANALYST_REVIEW.md` is historical GOV-001, not review evidence for this feature.

Relevant observations: `src/services/notificationOrchestrator.ts` owns daily selection/finalization but only has an in-memory transport guard. `src/services/monitor.ts` uses execution time for delivery date. `src/worker.ts` also sends status-only email when cycle initialization or execution fails. `resend.ts` currently serializes the request itself and throws generic errors. `D1NotificationHistory` uses INSERT OR IGNORE then read-back. `monitoringTelemetry.ts` has strict key validation and an 8192-byte snapshot cap. The new path must cover all scheduled finalizers, including errors, without converting legacy single-story helpers into a new framework.

Human-reported November 1 observation (not independently re-queried): cycle `a33c2b83-f7b8-449f-b6be-a326371eed11`, one `gemini-3.8-flash` HTTP 200/observed request, exact accounting with no accounting error, settled, about 12 seconds, 24 candidates, response_invalid and no accepted analyzed stories; degraded raw-story email accepted. Luna was ineligible. Exact validator sub-reason remains unknown. Record only this observation: do not loosen validation, add diagnostic codes, retry invalid output or expand fallback. No scheduled follow-up is created.

## Global constraints

- Identity `daily-digest/YYYY-MM-DD` comes from valid scheduledAt UTC, never execution time, cycleId, stories, mode or recipient. Missing identity fails closed for scheduled email.
- Recovery clock is `first_provider_attempt_at + 23 hours`, written only at final provider-dispatch admission, never during preparation/reservation/claim. No possible dispatch means no provider-retention window. Preserve the spec's unavoidable crash gap: committed intent before fetch can be an uncertain possible dispatch, never falsely reported as observed HTTP.
- At most three actual-or-uncertain dispatch slots per digest, at most one Resend HTTP request per invocation. Proven non-dispatch consumes none. Deadline wins over unused slots. Two-minute claim lease; final fence/time check leaves 30 seconds transport plus 60 seconds margin. A lease or Abort is not proof of nonacceptance.
- Frozen serializer order `{from,to,subject,text,html}`; recipient reconstructed from the same secret binding and included in SHA-256 but not stored plaintext. Never persist API key. Store sender/rendered content. No different body or alternative key on replay. Single account/recipient namespace remains assumed.
- <=4 items; subject <=1 KiB, text <=64 KiB, HTML <=192 KiB, content JSON <=272 KiB, request <=280 KiB; <=128 unique aliases, <=2048 UTF-8 bytes each and <=128 KiB alias JSON; journal <=4 KiB. Reject overflow, no truncation.
- One additive delivery table only, with permanent daily tombstones. No alias-claim table/index or pending-alias eligibility predicate. Frozen aliases are repair evidence only. Different days can repeat a story before history repair; do not claim this feature closes that accepted limitation.
- Authoritative D1 reread after every uncertain correctness-critical mutation. Conditional retry only after known durable truth; no external side effect on an unresolved write. No DB transaction spans HTTP.
- Only authoritative sole-attempt rejection can become confirmed_failed. Timeout/lost response/termination/concurrent same-key requests remain ambiguous. Payload conflict blocks sends. Acceptance is durable before history repair and never downgraded.
- 30-second full transport deadline, 8 KiB response limit, no redirects, no SDK retries. No extra Cron, queue, endpoint or automatic next-day send of older daily content.
- Preserve current normal/degraded/status-only selection, four-story cap, notification history, Brave/RSS, source integrity, Gemini accounting/validation, Luna's exact three-503 eligibility, all quotas and existing telemetry admission policy.
- THREADS = IMPLEMENTED / OFFLINE-TESTED / PRODUCTION ACTIVATION DEFERRED / EXTERNALLY BLOCKED BY META BUSINESS REQUIREMENTS. No Threads changes. X/0004 stays untouched/unapplied.
- Next roadmap item is **Brave Request Timeout + Bounded Response**, not part of this work. No event dedupe, telemetry content-continuity redesign, CI improvements, cleanup, limit centralization or P7.
- Implementation may create 0010 only after plan approval. Production migration, merge and deployment each require their separate approval. Never run live test scripts (`email:test`, `monitor`, provider tests, end-to-end monitoring) for verification.

## File map and shared contracts

Create runtime modules:
- `src/services/emailDeliveryLedger.ts`: identity, frozen payload, bounded record types, dispatch/recovery contracts and pure validation; no filesystem imports.
- `src/services/d1EmailDeliveryLedger.ts`: concrete D1 adapter, authoritative reads, guarded mutations and atomic notification repair.
- `migrations/0010_email_delivery_ledger.sql`: delivery table/constraints/indexes, no changes to existing migration files.

Modify runtime only where required: `src/tools/email/resend.ts`, `src/services/notificationOrchestrator.ts`, `src/services/monitor.ts`, `src/worker.ts`, `src/types/index.ts`, `src/services/monitoringTelemetry.ts`. Existing notification-history implementation/schema remains unchanged. Keep feature helpers in these units, no general workflow engine.

Create tests: `test/emailDeliveryLedger.test.ts`, `test/emailDeliveryLedgerMigration.test.ts`, `test/d1EmailDeliveryLedger.test.ts`, `test/emailDeliveryWorker.test.ts`, `test/fixtures/emailDeliveryD1.ts`, `test/workerd/emailDelivery.worker.ts`, `test/workerd/emailDelivery.test.mjs`, `test/workerd/emailDelivery.wrangler.jsonc`.
Modify tests: `test/resend.test.ts`, `test/dailyDigestReliability.test.ts`, `test/notificationOrchestrator.test.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`, `test/d1Adapters.test.ts`, `test/monitoringTelemetry.test.ts`. Adapt only touched call contracts; keep existing discovery/analysis assertions. No package/lockfile/CI change is necessary; invoke the new harness directly.

The following are interface declarations for the future implementation, not implementation code. All new delivery contracts live in emailDeliveryLedger.ts; import existing PreparedDailyDigest, DailyDigestMode/Reason, DiscoveryEmailContent and DailyEmailOutcome from types/index.ts.

```ts
type DeliveryKey = `daily-digest/${string}`;
type DeliveryState = 'prepared' | 'attempting' | 'ambiguous' | 'accepted' | 'confirmed_failed';
interface DeliveryIdentity { key: DeliveryKey; logicalDate: string; scheduledAt: string }
interface FrozenDelivery {
  identity: DeliveryIdentity; payloadVersion: 1;
  content: DiscoveryEmailContent & { from: string };
  payloadSha256: string; mode: DailyDigestMode; reason: DailyDigestReason;
  aliases: readonly string[];
}
interface DispatchSlot {
  token: string; admittedAt: string; evidence: 'uncertain' | 'dispatched';
  outcome: 'pending' | 'ambiguous' | 'rejected' | 'accepted' | 'payload_conflict';
}
interface ClaimRef { key: DeliveryKey; token: string; generation: number }
interface DeliveryRecord {
  key: DeliveryKey; logicalDate: string; payloadSha256: string;
  frozen: FrozenDelivery | null; state: DeliveryState; createdAt: string; updatedAt: string;
  firstProviderAttemptAt: string | null; lastProviderAttemptAt: string | null;
  retryBefore: string | null; claim: ClaimRef | null; leaseUntil: string | null;
  slots: readonly DispatchSlot[]; providerMessageId: string | null;
  acceptedAt: string | null; reconciledAt: string | null; lastReason: string;
}
type MutationResult = { kind: 'committed' | 'superseded'; record: DeliveryRecord }
  | { kind: 'blocked'; reason: string };
type ResendOutcome = { kind: 'accepted'; id: string }
  | { kind: 'rejected'; rejection: 'validation' | 'authentication' | 'permission' | 'quota' }
  | { kind: 'ambiguous'; reason: 'timeout' | 'transport' | 'concurrent' | 'invalid_response' | 'http' }
  | { kind: 'payload_conflict' };
interface DeliveryLedger {
  read(key: DeliveryKey): Promise<DeliveryRecord | null>;
  reserve(frozen: FrozenDelivery): Promise<MutationResult>;
  claim(key: DeliveryKey, token: string): Promise<MutationResult>;
  admitDispatch(ref: ClaimRef): Promise<MutationResult>;
  verifyDispatch(ref: ClaimRef): Promise<{ record: DeliveryRecord; databaseNow: string }>;
  cancelUndispatched(ref: ClaimRef): Promise<MutationResult>;
  recordOutcome(ref: ClaimRef, hash: string, outcome: ResendOutcome): Promise<MutationResult>;
  reconcileAccepted(key: DeliveryKey): Promise<MutationResult>;
  reconcileOneOlder(logicalDate: string): Promise<void>;
}
function deliveryIdentity(scheduledAt: Date): DeliveryIdentity;
function freezeDelivery(digest: PreparedDailyDigest, identity: DeliveryIdentity,
  content: DiscoveryEmailContent & { from: string }, recipient: string): Promise<FrozenDelivery>;
function restoreDeliveryBody(frozen: FrozenDelivery, recipient: string): Promise<string>;
```

`read`/`verifyDispatch` throw a bounded delivery-state-unavailable error when truth cannot be established; null means authoritative absence only. Every mutation implements its own bounded reconcile-on-uncertainty behavior and returns blocked rather than fabricated success. `lastReason` and returned reasons use a closed enum of spec outcomes, never raw error strings. Database adapter constructor: `new D1EmailDeliveryLedger(database: D1Database)`. DB UTC supplies persisted timing; fake clocks belong in offline test boundaries, not production request parameters.

Content is retained in v1 (no cleanup scheduler). If reading an accepted/scrubbed tombstone is supported, decoding must permit absent content/aliases only for accepted, reconciled, aged records and never reconstruct/send it. DeliveryRecord.frozen may be null only for that accepted/reconciled tombstone; validate this invariant at decode and require non-null frozen content before any send; do not require recipient reconstruction merely to return already_accepted or repair stored aliases. No automatic purge is required by the spec.

## Task 1 — Pure identity, payload and state contracts

**Files:** Create `src/services/emailDeliveryLedger.ts`, `test/emailDeliveryLedger.test.ts`.
**Responsibility/interfaces:** Define the contracts above, deliveryIdentity, freezeDelivery and restoreDeliveryBody. Frozen metadata excludes credentials; hash full canonical UTF-8 JSON through Web Crypto. Collect actual rendered aliases, including canonical alias keys through existing batchAliasKey/normalizeDiscoveryUrl helpers. Validate every bound, daily date, journal enum and record consistency.

- [ ] RED: add tests with a scheduled date delayed across midnight, invalid/missing Date, identical serialization, changed recipient, frozen sender and renderer-version mismatch. Use four realistic formatted items at boundary sizes; reject each byte/alias overflow. Assert no plaintext recipient/API key in stored FrozenDelivery.
- [ ] Run `./node_modules/.bin/tsx --test test/emailDeliveryLedger.test.ts`. Expected RED: new exports absent, followed by behavioral failures until identity/hash validation exists.
- [ ] GREEN: implement only pure validators, canonical serialization and types; no D1/fetch. Keep scheduled identity separate from all recovery-clock parameters. Assert `deliveryIdentity(new Date('2026-11-04T23:59:59.000Z')).key === 'daily-digest/2026-11-04'`; restore returns identical bytes, changed recipient rejects.
- [ ] Verify with the same test command and `npm run build`.
- [ ] Proposed commit: `feat: define frozen daily email delivery identity` (only this task's two files).

## Task 2 — Additive delivery schema and migration proof

**Files:** Create `migrations/0010_email_delivery_ledger.sql`, `test/emailDeliveryLedgerMigration.test.ts`.
**Interfaces:** SQL row maps one-to-one to DeliveryRecord; snake_case names match spec, including first_provider_attempt_at, dispatch_evidence_json, provider_message_id and reconciled_at. Store mode/reason with frozen content metadata. Index accepted/unreconciled selection by accepted_at/delivery_key; no alias index. Claim generation stays durable even when token is cleared.

- [ ] RED: build an isolated production-shape SQLite fixture following test/monitoringTelemetryMigration.test.ts. Apply 0001, 0002, 0003, 0005, 0006, seed the exact row-22 fixture required by 0007, then 0007, 0008, 0009 and new 0010. Snapshot existing schema/data before 0010; assert only the email table/index/guards are added. Separately apply 0004 later to a disposable copy to prove independence, never to production.
- [ ] Run `./node_modules/.bin/tsx --test test/emailDeliveryLedgerMigration.test.ts`. Expected RED: missing 0010, then rejected/accepted transition assertions expose incomplete guards.
- [ ] GREEN: create unique daily key/date with consistency checks, five states, bounded JSON and timestamp/count checks. Guard immutable payload/identity/aliases; terminal acceptance cannot downgrade; reject deletion that would free a daily identity. Permit the specifically fenced transition shapes needed by Tasks 3–5, including proven pre-fetch cancellation and monotonic late acceptance. No trigger-sensitive meta.changes assumption. No old migration edits.
- [ ] Verify same command; test duplicate date/key, fourth slot, invalid timestamp/deadline, accepted without ID, changed frozen body and alias-schema absence. Bound JSON sizes in UTF-8 bytes, not JS character count.
- [ ] Proposed commit: `feat: add daily email delivery ledger migration`.

## Task 3 — Authoritative reservation, conditional claims and D1 uncertainty

**Files:** Create `src/services/d1EmailDeliveryLedger.ts`, `test/d1EmailDeliveryLedger.test.ts`, `test/fixtures/emailDeliveryD1.ts`; modify ledger contracts only if needed to encode the already specified results.
**Interfaces:** Implement read/reserve/claim. Use fresh `database.withSession('first-primary')` reads to establish primary truth after unknown outcomes; do not rely on a subsequent replica read merely because an earlier read was primary. Include the minimal prepare/bind/first/all/run/batch/session surface in the test fixture, modeled on test/d1Adapters.test.ts. Model atomic batch rollback and injected before-commit/after-commit-response-loss/read-failure separately.

- [ ] RED: reserve identical/different payloads concurrently under the same day, claim with two tokens, lose reservation and claim responses after commit, fail before commit, then fail reread. Assert exactly one daily row/owner, the persisted winner survives, no fabricated absence, and no provider spy invoked. Claiming must leave clock/slots empty.
- [ ] Run `./node_modules/.bin/tsx --test test/d1EmailDeliveryLedger.test.ts`. Expected RED: adapter absent, then missing CAS and uncertainty resolution.
- [ ] GREEN: conditional insert/update with read-back of exact identity/token/generation. Same-day collision returns authoritative winner; no overwrite. A conflicting proposal does not authorize its content. Use one immediate authoritative reconciliation read after uncertainty; if safely uncommitted, at most one conditional retry of the same operation identity plus final authoritative read. Further uncertainty blocks this invocation. Keep this helper private to the delivery adapter; no general retry framework.
- [ ] Verify same command plus Task 2 migration test. Assert live lease cannot be stolen, expired no-dispatch claim can be reclaimed, accepted/failed/integrity-held rows cannot be claimed, and conflicting tokens never both own the same generation.
- [ ] Proposed commit: `feat: persist fenced daily email reservations`.

## Task 4 — Dispatch clock, slots and cancellation safety

**Files:** Modify the two ledger modules and `test/d1EmailDeliveryLedger.test.ts`, `test/emailDeliveryLedger.test.ts`.
**Interfaces:** Implement admitDispatch/verifyDispatch/cancelUndispatched. Each claim token names at most one dispatch slot. Verify returns DB time and the full durable row; caller adds monotonic elapsed time before fetch.

- [ ] RED: reserve and claim an old scheduled day without dispatch; clock stays null. Admit its first request now; deadline is exactly DB admission time +23h. Reuse the token after lost D1 response; no extra slot. Attempt four across invocations; fourth blocked. Advance time past cutoff with only one slot; blocked. Local pre-fetch cancellation frees only its own proven slot; expired owner cannot refund uncertainty or reset clock.
- [ ] Run `./node_modules/.bin/tsx --test test/emailDeliveryLedger.test.ts test/d1EmailDeliveryLedger.test.ts`. Expected RED: admission/clock/cancellation absent or transitions fail.
- [ ] GREEN: one atomic conditional mutation appends uncertain slot, sets first/last timestamps and immutable cutoff; predicates verify fence, state, lease, capacity and existing deadline. Admission is immediately before the HTTP boundary. No preparation or ordinary claim starts the clock. Cancellation requires the same live generation plus caller-owned positive no-fetch knowledge, invalidates that token and exits the invocation. Reset the clock only when cancelling the sole slot with no actual/possible dispatch and no successor. Never use missing telemetry as proof.
- [ ] Verify same command. Include response lost during timestamp/slot mutation and cancellation, late resumed owner, remaining-time margin, conflicting claim, one slot per token, and monotonic clock preservation on replay. Unknown slot consumes capacity but is never labeled observed HTTP. A crash between intent and fetch remains conservatively uncertain as approved.
- [ ] Proposed commit: `feat: bound email dispatch admission and recovery clock`.

## Task 5 — Durable outcomes and no-send history repair

**Files:** Modify `src/services/d1EmailDeliveryLedger.ts`, `test/d1EmailDeliveryLedger.test.ts`, `test/emailDeliveryLedgerMigration.test.ts`.
**Interfaces:** Implement recordOutcome, reconcileAccepted, reconcileOneOlder. Outcomes include attempt token/hash evidence; acceptance stores ID/time/state atomically. ReconcileOneOlder selects deterministically by accepted_at then key, at most one older accepted/unreconciled row and 128 aliases, and never dispatches.

- [ ] RED: accept then lose D1 response, fail acceptance before commit, race stale failure against acceptance, conflicting acceptance IDs, concurrent-same-key ambiguous outcome, sole confirmed rejection and rejection after earlier uncertainty. Fail notification batch and repeat after restart. Existing notification record must retain original timestamp/ID. Assert HTTP spy remains untouched throughout repair.
- [ ] Run `./node_modules/.bin/tsx --test test/d1EmailDeliveryLedger.test.ts test/emailDeliveryLedgerMigration.test.ts`. Expected RED: outcome/repair methods absent or incomplete.
- [ ] GREEN: store observed dispatch evidence and outcome under fencing. Late valid same-hash/attempt success can monotonically establish acceptance even after lease expiry; do not permit failure to downgrade it. Only authoritative sole-attempt rejection/current fence becomes confirmed_failed. Conflicting IDs or provider payload conflicts create a no-send integrity hold. Every uncertain mutation rereads first; observed acceptance persistence retries only that write, never another POST.
- [ ] GREEN: atomic bounded D1 batch inserts missing notifications with ON CONFLICT DO NOTHING and original accepted_at/provider ID, then marks reconciled. Each statement is conditional on durable accepted state. Reread marker and expected rows after response loss; retry safe repair only. Empty aliases reconcile without notification inserts. No ledger-based cross-day eligibility, alias uniqueness, or fake history records.
- [ ] Verify same command plus `./node_modules/.bin/tsx --test test/notificationHistory.test.ts test/notificationEligibility.test.ts test/notificationReplay.test.ts`. Assert same alias can occur in two daily ledgers while notification eligibility continues to consult only notifications; accepted tombstones never resend, including aged/scrubbed fixture records.
- [ ] Proposed commit: `feat: reconcile accepted daily delivery and notification history`.

## Task 6 — Exact-body Resend transport with typed outcomes

**Files:** Modify `src/tools/email/resend.ts`, `test/resend.test.ts`; consume ResendOutcome from ledger contracts.
**Interfaces:** Add `sendFrozenWithResend(body: string, key: DeliveryKey, dependencies: ResendDependencies): Promise<ResendOutcome>`. Preserve existing sendWithResend signature for legacy nonscheduled callers; scheduled production will use only the new entry point. Export a bounded `ResendPreDispatchError` solely for failures positively detected before fetch is invoked (missing bindings or invalid local key/body). Any fetch rejection is a ResendOutcome ambiguous result, never this error. No configurable production endpoint or new provider wrapper framework.

- [ ] RED: capture exact POST body and Idempotency-Key; accept valid bounded ID. Test structured rejection classes, 409 concurrent, 409 payload mismatch, 5xx, timeout/lost response, oversized/malformed/empty success, redirects and body-read timeout. Assert one fetch and no retries. Add a deterministic mock with 24h key expiry, same-body replay/same ID, different-body conflict and timeout after acceptance.
- [ ] Run `./node_modules/.bin/tsx --test test/resend.test.ts`. Expected RED: new entry point absent; later typed classification/header/limits fail.
- [ ] GREEN: send already-verified bytes unchanged with fixed URL/POST, authorization and key headers. Validate local bindings/key before any fetch. Native manual redirect handling, full 30s deadline including bounded body read, maximum 8 KiB, no raw response diagnostics. Parse documented structured rejection names conservatively; unknown name/status combinations remain ambiguous. Provider rejection is evidence for ledger evaluation, not permission for adapter alone to mark confirmed_failed.
- [ ] Verify same command. Test fixture's key eviction must actually permit a new provider email after 24h so expired-send application tests can catch a real regression. Preserve existing sender/legacy contract tests without using a live address/token. Never infer non-dispatch merely from a rejected fetch promise.
- [ ] Proposed commit: `feat: send frozen email payloads with Resend idempotency`.

## Task 7 — Ledger-backed daily finalizer and recovery

**Files:** Modify `src/services/notificationOrchestrator.ts`, `src/types/index.ts`, `test/dailyDigestReliability.test.ts`, `test/notificationOrchestrator.test.ts`.
**Interfaces:** Define `DailyDeliveryDependencies` in notificationOrchestrator.ts: context: DailyEmailContext; identity: DeliveryIdentity; ledger: DeliveryLedger; recipient: string; sender: string; sendFrozen: (body: string,key: DeliveryKey) => Promise<ResendOutcome>; optional beforeEmailAttempt/onAccepted hooks. Keep recipient/key in runtime dependencies only. New signatures: `finalizeDailyDigest(digest: PreparedDailyDigest, dependencies: DailyDeliveryDependencies): Promise<DailyEmailOutcome>`; `recoverDailyDelivery(dependencies: DailyDeliveryDependencies): Promise<DailyEmailOutcome | null>`. Null means no daily row and permits normal cycle; any existing row yields terminal invocation outcome. Extend DailyEmailContext with finalizationEntered; emailAttempted guards the single transport invocation; reported emailAttempts counts actual fetch invocations only, never D1 work. Extend DailyEmailOutcome with optional deliveryLedger observation (Task 9).

- [ ] RED: successful first delivery then second invocation same day; timeout after provider acceptance then exact replay; crash after acceptance before persist; unavailable ledger; regenerated mismatched content; history failure then no-send repair. Cover normal/degraded/status-only independently and nested finalizer reentry. Assert zero new HTTP calls for accepted daily rows and no callback/count for a new acceptance on already_accepted.
- [ ] Run `./node_modules/.bin/tsx --test test/dailyDigestReliability.test.ts test/notificationOrchestrator.test.ts`. Expected RED: dependencies/signatures and durable recovery behavior absent.
- [ ] GREEN: existing-row lookup wins before formatting; recover frozen content only. Format new content once, capture effective status-only fallback with zero aliases, freeze/reserve, verify hash and claim, admit slot, resolve uncertain writes, verify fence/time, synchronously set transport guard and invoke sendFrozen. No awaited telemetry or other work between final dispatch check and fetch. Run the best-effort beforeEmailAttempt hook before the final check. Catch only ResendPreDispatchError as positive no-fetch evidence: cancel the same live slot, report zero actual HTTP requests and exit; generic errors cannot refund a slot. Validate all available bindings before admission so this cancellation is exceptional. Record result before notification repair. Stop after one HTTP request; never fall through to an untracked error email.
- [ ] Verify same command plus `./node_modules/.bin/tsx --test test/emailDeliveryLedger.test.ts test/d1EmailDeliveryLedger.test.ts test/resend.test.ts`. Run fake-provider expiration scenarios at cutoff and after24h. Unknowns report unknown, confirmed rejection reports failed, already accepted reports accepted with emailAttempts0 and explicit already_accepted action. Ledger fault before dispatch reports not_attempted/blocked. Render fallback must never mark undisplayed stories notified.
- [ ] Proposed commit: `feat: finalize daily email through durable recovery`.

## Task 8 — Scheduled Worker integration across every finalization path

**Files:** Modify `src/services/monitor.ts`, `src/worker.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`, `test/d1Adapters.test.ts`; create `test/emailDeliveryWorker.test.ts`.
**Interfaces:** Add required `dailyDelivery: DailyDeliveryDependencies` to BatchMonitoringDependencies for scheduled Batch execution. Reuse its shared context. Replace the status-only sender parameter with `finalizeStatusOnlyMonitoringCycle(delivery: DailyDeliveryDependencies, reason?: 'history_unavailable' | 'discovery_unavailable' | 'preparation_unavailable'): Promise<MonitoringCycleResult>`. Change all call sites together; no fallback raw sender. `runScheduledMonitoring` derives identity once from dependencies.scheduledAt, supplied by scheduled event. `createWorkerMonitoringDependencies` receives the same dailyDelivery object for the Batch path; legacy runMonitoringCycle remains outside this feature.

- [ ] RED: scheduled event delayed across midnight; absent/invalid scheduledAt; telemetry.createCycle failure; monitor catch/status path; normal/degraded sends; already accepted and ambiguous pending records before discovery. Assert no Brave/RSS/Gemini/Luna invocation when recovering existing daily state, and all scheduled sends pass through the ledger. Shared finalizer guard survives catch/reentry.
- [ ] Run `./node_modules/.bin/tsx --test test/emailDeliveryWorker.test.ts test/batchMonitoring.test.ts test/workerConfiguration.test.ts test/d1Adapters.test.ts`. Expected RED: missing dependency/signature and existing raw status-only paths.
- [ ] GREEN: construct ledger and fixed-body transport at the Worker boundary. Check daily record before acquisition/analysis, opportunistically repair <=1 older accepted record, then run unchanged pipeline only for a genuinely absent current row. Frozen scheduled identity drives email date in all branches; discovery timestamps remain execution-based. Ledger read errors fail closed. Missing ledger/bindings cannot call the old transport. No health endpoint, Cron or configuration change. Update only directly affected offline fixtures.
- [ ] Verify same command plus `npm run build`. Assert accepted duplicate produces notificationsSent0/emailCount0, no repeat analysis, and recovered already-stored content is not labeled newly generated stories. Newly observed acceptance can count one accepted email with actual HTTP count1. Test invalid Gemini output still follows existing degraded path and never invokes Luna without its three-503 proof; add no new validator behavior.
- [ ] Proposed commit: `feat: integrate daily delivery recovery into scheduled Worker`.

## Task 9 — Bounded delivery observations and compatible readers

**Files:** Modify `src/services/monitoringTelemetry.ts`, `src/types/index.ts`, `src/services/monitor.ts`, `src/worker.ts`, `test/monitoringTelemetry.test.ts`, `test/emailDeliveryWorker.test.ts`.
**Interfaces:** Add optional `deliveryLedger` to CycleSnapshotV1 and DailyEmailOutcome, with `version:1`, daily key, action first/recovery/already_accepted/in_progress/blocked, state nullable on unreadable ledger, bounded reason, knownDispatchCount and uncertainSlotCount (each0–3, sum<=3), reconciliation not_required/pending/complete/failed, replayEvidence same_key_requested/unknown. Export validateDeliveryLedgerObservation(value: unknown) from monitoringTelemetry.ts. No ID/payload/hash/recipient/alias/raw-response fields.

- [ ] RED: round-trip legacy snapshots without extension; valid new extension; unknown fields/enums, oversized extension, total8192 overflow, inconsistent counts, and malicious secret/content values. Exercise summary projection and telemetry failures before/after provider acceptance.
- [ ] Run `./node_modules/.bin/tsx --test test/monitoringTelemetry.test.ts test/emailDeliveryWorker.test.ts test/workerConfiguration.test.ts`. Expected RED: strict readers reject extension or lose it; bounded/redacted observer missing.
- [ ] GREEN: exact-key allowlist plus byte cap1024 inside8192; update serialization/parsing, monitor snapshots and Worker summary together. Preserve current mandatory pre-analysis checkpoint policy. Delivery truth never depends on telemetry success; unreadable D1 truth still blocks send. Observed HTTP count remains0/1, uncertain slots are distinct; never claim provider replay was deduplicated without evidence. No telemetry schema migration.
- [ ] Verify same command and `npm run build`. Assert accepted-write ambiguity cannot become falsely confirmed_failed, already_accepted increments no new-email metric, and existing snapshots remain readable through D1MonitoringTelemetry without changing Gemini accounting logic.
- [ ] Proposed commit: `feat: expose bounded daily email recovery telemetry`.

## Task 10 — Workerd crash, concurrency and persistence proof

**Files:** Create `test/workerd/emailDelivery.worker.ts`, `test/workerd/emailDelivery.test.mjs`, `test/workerd/emailDelivery.wrangler.jsonc`; extend `test/fixtures/emailDeliveryD1.ts` only for scoped failure injection if needed.
**Interfaces:** Test-only Worker routes invoke the real delivery adapter/finalizer against local D1; they are never imported by src/worker.ts or exposed in production. Follow existing openaiFallback harness's temporary persistence, fileURLToPath, local Wrangler binary, loopback receiver and process teardown. Fixed production Resend URL remains unchanged: injected fetch maps to loopback in the harness only. Harness refuses non-loopback traffic.

- [ ] RED: run two requests racing same day with different payload proposals, assert one persisted winner and one provider-created email. Restart Workerd using the same local persistence after reservation, claim, intent-before-fetch, provider acceptance-before-persist and accepted-before-history repair. Inject every critical D1 write as both committed/response-lost and not-committed, with unreadable reread as a third case. Test no transaction spans HTTP by observing committed intent from an independent D1 read in the receiver before returning its response.
- [ ] Run `node test/workerd/emailDelivery.test.mjs`. Expected RED: harness asserts the missing real-runtime guarantees; an unavailable runtime is blocked verification, not PASS.
- [ ] GREEN: wire only the local fixture/harness; use real D1 session/batch semantics, not a mock as final evidence. If production code fails, correct only the responsible earlier task's approved scope and repeat its focused tests. Reuse isolated production-shape migration fixtures, including 0007 preconditions; no local blanket migration command that silently applies0004. Advance fixture times using isolated seeded DB records/test boundaries, never a production override. No waiting23h.
- [ ] Verify same command. Include stale claimant, late success, conflicting provider IDs, original acceptance timestamp preserved, three-slot exhaustion, exact replay before cutoff and no request after cutoff even when fake provider evicts its24h key. Accepted restart repairs notifications with zero receiver calls; test read-back consistency and batch rollback under actual runtime.
- [ ] Proposed commit: `test: prove email delivery recovery under Workerd`.

## Task 11 — Full offline verification and documentation handoff

**Files:** Verification across scoped files; modify only completion/status entries in `backlog.md`, `plan.md`, `docs/self-improvement/PROJECT_STATE.md`, `docs/self-improvement/DAILY_SUMMARY.md`, `docs/self-improvement/CHANGELOG.md` after Builder evidence exists. Do not overwrite the existing edits or Analyst-owned review. Plan checkbox completion is permitted. No new standalone release tooling.
**Interfaces:** No runtime contract added. Produce commit-specific Builder evidence for one independent final Analyst review. Documentation completion is not a fabricated code RED test: preceding tasks supply behavioral RED→GREEN proof.

- [ ] RED/entry gate: review mandatory tests below and collect any missing/failing acceptance evidence. Add missing feature-specific regression to its owning test before fixing code. Do not write tests that merely grep prose. Inspect scripts before execution; use existing installed tools, no downloads/live provider calls.
- [ ] Run focused aggregate: `./node_modules/.bin/tsx --test test/emailDeliveryLedger.test.ts test/emailDeliveryLedgerMigration.test.ts test/d1EmailDeliveryLedger.test.ts test/emailDeliveryWorker.test.ts test/resend.test.ts test/dailyDigestReliability.test.ts test/monitoringTelemetry.test.ts`.
- [ ] Run `npm test`, `npm run build`, `npm run worker:typecheck`, `node test/workerd/emailDelivery.test.mjs`, `node test/workerd/geminiTelemetry.test.mjs`, `node test/workerd/openaiFallback.test.mjs`, `npm run test:rss-workerd`, `npm run test:threads-workerd`.
- [ ] Run an offline bundle build: `./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/ai-radar-idempotent-email-bundle`. Inspect generated bundle for local JSON persistence, Node filesystem, dotenv and SDK imports; expected absence. This command must remain dry-run; no version upload/deployment. Worker type generation may produce worker-configuration.d.ts changes; keep only genuinely necessary generated binding/type changes, otherwise leave it unchanged. No new binding is expected.
- [ ] GREEN/verification gate: all commands pass with actual counts recorded, no live network beyond test loopback, no unsupported runtime semantics or unverified acceptance cases. If tests fail, diagnose within scope; never delete/weaken a test, loosen validation or claim an environmental failure passed.
- [ ] Reconcile docs with implementation/review-pending status; formally approved design, plan/execution evidence and next Brave timeout feature. Preserve the Nov1 observation as observation only and Threads deferred state. Document separate migration approval, cutover outside old in-flight invocations on an untouched logical day, missing-ledger fail-closed, one-account/recipient restoration requirement, no stale-ambiguity reset, and rollback only to ledger-aware versions. Keep current production facts unchanged.
- [ ] Inspect `git diff --check`, exact staged diff, file list and secret/artifact audit; stage only intended implementation/doc hunks, never unrelated existing work. Commit boundaries are proposals, not permission to stage the dirty repository wholesale. Do not execute any commit on production main without its required approval; observe current AGENTS branch rules during later authorized Builder execution. No worktree is required.
- [ ] Proposed final commit: `docs: record idempotent email delivery verification and release gates`. Stop for Analyst → Architect → human. Merge, migration application, deployment and natural validation remain subsequent separate approvals; no implementation was authorized by writing this plan.

## Mandatory-test mapping and final Analyst focus

1. First delivery success: Tasks6–8,10.
2. Second same logical day no duplicate: Tasks3,7,8,10.
3. Crash after provider acceptance before accepted persistence: Tasks5,7,10.
4. Transport timeout with possible acceptance: Tasks6,7,10.
5. Exact retry inside provider window: Tasks4,6,7,10.
6. Same key/different payload fails closed: Tasks1,3,6,7,10. Reject mismatched content; only the stored winner may enter its normal approved recovery path.
7. Accepted provider/history failure: Tasks5,7,10.
8. Later no-send repair: Tasks5,7,10.
9. Concurrent same-day Workers: Tasks3,4,10.
10. Ledger unavailable before dispatch: Tasks3,7,8,10.
11. Authoritative confirmed rejection: Tasks5–7; reject ambiguous or prior-uncertain terminalization.
12. Normal idempotency: Tasks7,8.
13. Degraded idempotency: Tasks7,8.
14. Status-only idempotency: Tasks7,8, including Worker error paths.
15. One HTTP request per invocation: Tasks6–8,10.
16. Telemetry redaction: Task9, end-to-end Task10.
17. Exact Idempotency-Key: Task6,10.
18. Expired ambiguity: Tasks4,7,10, with actual mock key eviction.
19. Every uncertain D1 mutation/read-back: Tasks3–5,10, before/after commit and unreadable truth.
20. No DB transaction spans provider call: Tasks7,10.
21. Three exhausted slots: Tasks4,7,10.
22. Proven non-dispatch not charged: Tasks4,7,10.
23. Ambiguous dispatch consumes capacity: Tasks4,7,10.
24. No first timestamp before provider admission: Tasks3,4,10.
25. Clock independent of scheduled date: Tasks1,4,8,10.
26. Idempotent notification reconciliation: Tasks5,10.
27. Correct concurrent fencing: Tasks3–5,10.

Analyst must prioritize exact-body replay and recipient changes, primary read-back after lost writes, late outcomes/fencing, immutable clock with cancellation exception, all status-only entry points, bounded provider parsing, actual-versus-uncertain counters, zero-resend accepted history repair, existing cross-day semantics and unchanged Gemini/Luna behavior. Review the exact Builder commit, not this plan as proof of implementation.

## Planning self-review

- Spec coverage: identity/payload Task1; durable model Task2; reservation/uncertainty Task3; clocks/budget Task4; acceptance/history Task5; transport Task6; recovery/finalization Task7; all Worker paths Task8; telemetry Task9; runtime crash/race proof Task10; rollout/rollback/docs Task11.
- Granularity: eleven sequential tasks, each with scoped files, a contract, RED reason, targeted command, minimal GREEN responsibility, verification and proposed commit boundary. No per-task approval gates beyond the single plan review and final independent Analyst review.
- Type consistency: DeliveryLedger and ResendOutcome are shared; snake_case SQL is mapped at one adapter boundary. DailyDeliveryDependencies replaces raw scheduled send dependencies in both normal/error paths. Legacy non-scheduled helpers remain unchanged.
- Proportion: no general job engine, new discovery lane, cross-day alias authority, cleanup service, provider integrations or CI redesign. Signatures and test assertions are planning contracts; no implementation/SQL was written during planning.
- Mandatory-test coverage: all27 numbered requirements mapped above; limits, clock crash gap, cancellation, same-key winner and provider-retention assumptions remain explicit.
- Existing work: preserve pre-existing files byte-identically in this planning turn. Human approval is recorded here without rewriting historical status or unrelated pending governance changes.
- No unresolved design decision is introduced. Builder must stop on a concrete contradiction or unsupported D1 capability rather than weakening an invariant. The known finite provider retention and possible unsent-but-held digest are accepted design limitations, not a promise of unconditional exactly-once inbox delivery.

**STOP: READY FOR HUMAN IMPLEMENTATION-PLAN REVIEW.**
