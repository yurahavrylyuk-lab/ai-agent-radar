# Idempotent email delivery + ambiguous-send recovery

2026-10-26 design; amended 2026-10-29 — **DESIGN AMENDED / AWAITING FINAL HUMAN APPROVAL**. Architecture only; no implementation plan or SQL is created.

## Evidence and scope

Inspected local main `9439220e953c4f01ac198c559de73b50700be325`. Current roadmap records: **THREADS = IMPLEMENTED / OFFLINE-TESTED / PRODUCTION ACTIVATION DEFERRED / EXTERNALLY BLOCKED BY META BUSINESS REQUIREMENTS**. Idempotent Email Delivery is the active engineering item; Threads is untouched, and production still on `bd2a3220611e5992b226e6cf7c0f9ec0b92c18ac`. No production verification was performed. Preserve Cron `0 8 * * *`, pending natural validation, disabled Threads/X and unapplied 0004.

`notificationOrchestrator.ts:finalizeDailyDigest` sets an invocation-local guard, formats content, calls sendEmail, then writes each alias to notification history. The transport in `tools/email/resend.ts` posts from/to/subject/text/html without an idempotency header; all errors become thrown errors. Provider acceptance followed by process termination or history-write failure therefore leaves no durable daily delivery authority. `D1NotificationHistory.recordNotificationSent` uses INSERT OR IGNORE and reads back the record, which is suitable for repeatable reconciliation but cannot prove a previously unrecorded email was accepted.

`worker.ts` supplies ScheduledEvent.scheduledTime as scheduledAt, but the monitor currently uses execution start for cycleDate, and both Worker error paths call the status-only finalizer with startedAt. All of these paths must share the new delivery authority. Preserve existing discovery/analysis timestamps and policy; only daily delivery identity/display date uses the frozen scheduled identity.

## Options and recommendation

| Approach | Assessment |
| --- | --- |
| A: Resend key only | Protects repeated identical requests temporarily; cannot recover a changed regenerated payload or suppress duplicates indefinitely. |
| B: D1 ledger only | Can suppress all retries, but cannot distinguish crash-before-send from crash-after-acceptance. Retrying an unknown outcome can duplicate email. |
| C: D1 ledger + Resend key | Recommended. Freeze request and daily identity durably; replay identical bytes within the provider window; retain permanent acceptance/tombstone evidence afterward. |

Verified official documentation on 2026-10-26: [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys) supports the Idempotency-Key header on POST /emails, retains keys for 24 hours, permits at most 256 characters, and returns the same successful result for an identical replay. [Resend errors](https://resend.com/docs/api-reference/errors) distinguishes invalid_idempotency_key (400), invalid_idempotent_request (409, payload conflict), and concurrent_idempotent_requests (409, request in progress). Neither a 5xx nor a lost response proves nonacceptance. No email API was called.

This is at-most-one provider-created email for a logical delivery under Resend's documented contract, not a guarantee of inbox delivery or exactly-once behavior inside downstream mail systems. No finite-retention API can give an unconditional exactly-once guarantee under arbitrarily delayed network execution. Safety depends on dispatches reaching the provider within its window; use the conservative cutoff below and never claim leases or Abort alone prove a request was not accepted. If an unlimited-delay guarantee is required, automatic ambiguous replay must be disabled or a stronger provider contract obtained.

## Daily identity

Use `daily-digest/YYYY-MM-DD`, with date from valid scheduledAt in UTC (24 characters). It is independent of random telemetry cycleId, execution start, mode, stories and recipient. A delayed duplicate event crossing UTC midnight retains its original key; next day's scheduled event has a different key. The production scheduled boundary must pass this identity through monitor, normal/degraded/status-only finalization and recovery. No wall-clock fallback is permitted when a production scheduled identity is absent/invalid: no email, bounded identity error. Test/local callers must provide the same explicit identity. No manual endpoint is added.

The namespace assumes the existing single production recipient and one Resend account. Nonproduction uses isolated credentials/DB and never the production namespace. Account migration, recipient replacement and database restore are explicit operational events, not reasons to change a pending key. Preserve deployment/account identity while unresolved requests exist; rotating a key within the same Resend account is allowed, switching accounts is not an automatic recovery mechanism.

## Exact payload without storing credentials

Freeze renderer output before any request: payload version1, fixed sender string, subject/text/html, delivery mode/reason and normalized aliases for the actual rendered items. The body serializer has fixed field order `{from,to,subject,text,html}`, UTF-8 JSON, no dynamic tags/date/headers. The provider endpoint/method are fixed. Hash the complete serialized body using SHA-256 via Worker crypto, including the recipient array. Store content and hash in private D1, never logs, git, telemetry or public endpoints.

Recipient is currently a Worker secret binding. Do not persist its plaintext or the API key: reconstruct to from the same binding and require the complete body hash to match before every send/replay. This permits exact recovery while that binding remains available. If it changes, recovery blocks with configuration_payload_mismatch rather than sending to a different address; an operator must restore the original binding under separate approval. Store sender/content, so a renderer or sender-code change cannot silently change an old request. A payload hash is not a credential or proof of confidentiality and must not be used as a public recipient lookup.

Bounds: <=4 rendered items; subject <=1 KiB, text <=64 KiB, HTML <=192 KiB; serialized content record <=272 KiB; reconstructed full request <=280 KiB. Reconciliation metadata <=128 unique normalized aliases, each <=2048 UTF-8 bytes, aggregate JSON <=128 KiB. Reject overflow before reservation/dispatch, never truncate content or discard aliases silently. Use fixtures from current formatter to prove ordinary maximum-size digests fit. If formatting falls back to status_only, freeze that effective empty-item digest and no story aliases: never mark unseen stories notified. A failed freeze is no-send, not permission for an untracked status email.

Regeneration is not recovery. Existing key wins: discard a different newly formatted proposal, report payload_conflict, and enter the existing-record recovery path using only stored content. No mismatched body is dispatched and no alternate key is generated.

## Minimal durable model

Reserve **`0010_email_delivery_ledger.sql`**, subject to rechecking migration inventory before implementation. It is proposed only. One `email_deliveries` table records daily delivery and bounded recovery evidence; no alias-claim table or unique cross-day alias index is introduced. Existing `notifications` remains the sole ordinary story-delivery history.

| Field | Meaning |
| --- | --- |
| delivery_key PRIMARY KEY, logical_date UNIQUE | Immutable daily identity with format/date consistency checks |
| state | prepared / attempting / ambiguous / accepted / confirmed_failed |
| payload_version, content_json, payload_sha256, mode | Frozen bounded content and canonical full-body identity |
| aliases_json | Immutable sorted reconciliation evidence only; empty for status_only |
| created_at, updated_at | DB UTC timestamps |
| first_provider_attempt_at, last_provider_attempt_at, retry_before | First dispatch-admission anchor and immutable recovery deadline, separate from scheduled identity |
| claim_token, claim_generation, lease_until | Conditional ownership/fencing; acquiring a claim alone is not a provider attempt |
| dispatch_evidence_json | Bounded journal of at most three dispatched-or-uncertain slots: unique attempt token, DB admission timestamp, dispatch evidence (uncertain / dispatched), bounded outcome; no raw provider response |
| provider_message_id, accepted_at | Validated acceptance evidence, required in accepted state |
| reconciled_at, last_reason | Reconciliation completion and bounded application reason enum |

The dispatch journal is limited to 4 KiB and updated atomically with the daily row; it is recovery evidence, not a second ledger. A known-not-dispatched slot is removed only through the fenced cancellation rule below. Do not store an unbounded admission log. Claim generation may advance without consuming a provider slot. Derive known dispatch count and uncertain-slot count separately; their sum must never exceed three.

Use CHECK constraints for states, nullability, timestamps, counts and byte bounds, plus immutability/transition enforcement in guarded SQL and focused migration tests. Acceptance cannot be downgraded. Identity, body hash/content and aliases are immutable. The first-provider-attempt/cutoff cannot advance after a possible dispatch. No daily row is deleted to allow another send. After accepted reconciliation and 30 days, content/alias JSON may be scrubbed in a bounded maintenance pass while retaining key/date/state/hash/provider ID/times forever; scrubbed records cannot become retryable. Unresolved payloads are not automatically deleted. No background cleanup service is required in v1; storage growth is bounded per day, not globally, and should be observed.

## Reservation, claims and concurrency

[D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/) describes atomic batched statements with rollback on statement failure. Use supported D1 conditional statements/batches and primary-authoritative reads. A reservation inserts one frozen daily row; a same-day uniqueness loser retrieves the winner. No read-then-write ownership, INSERT OR REPLACE, or ownership inferred from aggregate trigger-sensitive meta.changes. Confirm exact identity and claim token from returned data/authoritative read-back.

Claim acquisition is a conditional UPDATE of prepared, ambiguous, or expired attempting state, excluding accepted/confirmed_failed, live leases and integrity holds. Set a unique token, increment claim generation and set a two-minute lease. Acquiring a claim does not start the recovery clock or consume dispatch budget. Validate the reconstructed payload, configuration and time gates before dispatch admission. A resumed claimant must revalidate its fence; never queue or delay a send after the final check. An expired claim with no dispatch slot has no provider ambiguity and may be reclaimed without a provider recovery deadline.

Immediately before fetch, conditionally reserve one dispatch slot under the current token/fence with capacity remaining. In this same atomic mutation, set `first_provider_attempt_at` once to authoritative DB UTC if absent, and `retry_before = first_provider_attempt_at + 23 hours`. Record the slot as uncertain until dispatch evidence is durable. Reusing the same attempt token after an uncertain D1 response must be idempotent, not append another slot. The admission predicate also rejects accepted/confirmed_failed state, a changed fence, any integrity hold, and an expired existing retry_before. This is the first request admitted for external dispatch, not reservation creation, claim acquisition, scheduledAt or logical midnight. A one-hour margin avoids the provider's 24-hour retention boundary. Subsequent admissions never extend the deadline. Re-read the committed fence/slot and recheck DB time plus local monotonic elapsed time, with at least the 30-second transport deadline plus 60-second margin left, then call fetch immediately. No transaction remains open during fetch.

If no dispatch has happened or could have happened, no provider-ambiguity retention window exists: an old prepared row is not expired merely because of its scheduled date. D1 cannot atomically commit a timestamp and invoke an external HTTP request. A crash after the dispatch-intent write and before fetch therefore leaves a *possible* attempt, with a conservatively early anchor; it is not proof an HTTP request occurred. Do not move this anchor later on restart. A live owner that positively knows it never invoked fetch may atomically cancel its own slot, invalidate its token and release its claim. It may clear the anchor only if this was the sole slot, no possible/actual dispatch exists, and no later generation took ownership. An expired lease or missing dispatch telemetry is never such proof. The cancelled execution must exit without fetch. An uncertain cancellation follows the D1 reread rule before any further action.

Two live requests may still overlap after a crash/pause; provider idempotency, not the lease, prevents duplicate provider acceptance inside the window. Fenced failures update only their current claim; stale failure cannot overwrite acceptance. Late validated success for the identical immutable request may monotonically mark accepted even if its claim expired. Conflicting provider IDs are an integrity alert: no further sends. No Durable Objects or long-running transaction is introduced. Required boundary: **D1 atomic mutation/batch completes → Resend request → separate D1 outcome/reconciliation mutation**.

## D1 uncertain-write recovery rule

Every correctness-critical write uses a stable operation identity (daily key, payload hash and, where applicable, unique attempt token/generation) and conditional predicates. A timeout, connection loss or missing mutation response is an unknown commit outcome, not a failed transaction. Resolve it using a primary-authoritative D1 reread, never a potentially stale replica/cache or telemetry. Use bounded rereads/conditional retries under the invocation deadline; inability to establish durable truth means no further external email side effect.

| Mutation with uncertain outcome | Authoritative reconciliation |
| --- | --- |
| Initial reservation | Read daily key and compare complete immutable identity/payload/aliases. Matching committed row is success; conflicting row wins and must enter its own recovery path. Only authoritative absence permits retrying the same conditional insert. |
| Claim acquisition | Read token, generation, lease, state and journal. Own committed claim is success; another owner or accepted state means no dispatch. If clearly not committed and predicates still hold, retry the same token conditionally. |
| Dispatch slot / first-provider timestamp | Read exact attempt token, slot, anchor and cutoff together. Matching committed intent permits continuation only after all dispatch gates; authoritative absence permits conditional retry. Never reset an existing clock, double-reserve a slot or dispatch on an unverified write. |
| Dispatch evidence / ambiguous or confirmed-failed outcome | Read the slot and durable state. Matching committed outcome is success; acceptance wins. Otherwise reapply only the same fenced transition if still legal. Unresolved state retains possible dispatch evidence and cannot release budget or prove rejection. |
| Accepted state / provider message ID | Store state, ID and acceptance time atomically. Reread and compare the exact provider ID/hash. If absent, retry persistence of the already-observed acceptance, not the email POST. Accepted with another ID is an integrity hold. Unavailable truth means stop; a later invocation follows exact-key ambiguity recovery only after a successful reread. |
| Notification repair / reconciled marker | Atomic batch inserts missing notifications and sets reconciled_at. Reread marker plus required notification rows; existing earlier notification records are valid and unchanged. If committed, succeed; if incomplete, repeat the idempotent repair batch. Unknown truth never permits resending an accepted email. |
| Slot cancellation / claim release | Reread token, generation, slots and anchor. Confirm cancellation or conditionally retry the same safe cancellation; never assume a slot was released or reset the first-attempt clock from a lost response. |

A known response still requires verifying the intended predicate/result; zero rows affected is not ownership. If a racing transition has superseded the intended write, use current durable truth rather than forcing the older state. Initial insertion/claim/write retries are local database operations, not HTTP provider dispatches. No sequence may be uncertain D1 write → assumed failure → another email without authoritative rereconciliation.

## Retry-budget semantics

At most **three provider HTTP dispatches** across invocations, at most **one per Worker invocation**, and always within the immutable recovery deadline after the first possible dispatch. No in-process provider retry loop. The window takes precedence over remaining budget.

- Admission/claim acquisition: local fenced work, zero provider dispatches and no consumed dispatch slot until the final dispatch-intent boundary.
- Actual HTTP dispatch: consumes one slot regardless of response; record dispatched evidence without inventing acceptance.
- Provider concurrency conflict: a real HTTP request occurred, so consumes one slot; outcome remains ambiguous/in_progress, never confirmed_failed.
- Local rejection before fetch: zero dispatches; no slot is consumed, or the current owner cancels its newly reserved slot with the positive no-fetch proof above.
- Uncertain D1 transition: reread first; the database operation itself consumes no dispatch budget. A committed intent left by a crashed owner has unknown external outcome and retains a capacity reservation until resolved. Report it as uncertain, not as a measured HTTP dispatch. This conservatively reduces retry capacity but cannot justify extra requests exceeding the bound.

Exactly counting external calls across a crash boundary is impossible with D1 alone. The cap therefore uses known dispatches plus unresolved possible-dispatch slots for safety while telemetry reports only observed HTTP calls. Do not claim a proven non-dispatch consumed the provider budget, refund an uncertain slot, or slide the recovery window to recover lost capacity.

## First send and recovery ordering

1. Freeze scheduled identity at the Worker boundary. Before new discovery, look up that day's ledger: an existing row goes directly to recovery/reconciliation, avoiding a second provider analysis. A read failure means no email, including error/status-only paths. Discovery may still have separate telemetry, but it cannot bypass ledger authority.
2. Opportunistically reconcile at most one older accepted/unreconciled row per invocation, at most128 aliases. No background send of an older day. Repair is bounded and does not add ledger-based alias eligibility filters.
3. If no daily row exists, run unchanged acquisition/analysis/selection. Existing notifications history alone decides cross-day notified-alias eligibility; no ledger alias uniqueness or pending exclusion is added. Frozen prepared content is the sole source of truth once inserted.
4. Persist the prepared row atomically. Re-read/verify identity, hash, metadata and current secret-derived recipient. D1 failure or unknown reservation outcome: do not dispatch until authority is positively established.
5. Acquire the claim, durably admit the dispatch slot/clock, then recheck deadline/fence using the uncertain-write protocol. Set the invocation transport guard immediately before fetch (a separate finalization-entered guard may prevent fallback reentry). Increment actual transport telemetry only when dispatch occurs. At most one Resend POST per invocation; no in-process retry or sleeping retry loop.
6. POST exact bytes with the same Idempotency-Key. Process a typed, bounded outcome, not a generic error string.
7. Valid acceptance ID → persist accepted state/provider ID first. If its outcome is uncertain, reread authoritatively and retry persistence of the same acceptance evidence when legal; if truth remains unavailable, retain possible-attempt evidence and report unknown durable acceptance. Do not fall through to status email, history-only success, or a new key.
8. Once accepted is durably established, reconcile notifications and mark reconciliation complete. Telemetry is last/best effort for delivery correctness.

| Existing record | Action |
| --- | --- |
| accepted | Zero Resend calls forever; reconcile missing history and return already_accepted |
| prepared with no possible/actual provider attempt | Safe to claim exact stored payload even after24h; no external dispatch has been admitted |
| live attempting lease | Return in_progress, no request or waiting loop |
| expired attempting / ambiguous before conservative cutoff | Same stored payload/key, one claimed attempt if total allowance remains |
| attempted at/after cutoff or attempt cap | Zero calls; recovery_required, retain payload/reconciliation evidence/tombstone |
| confirmed_failed | No automatic retry or new same-day payload; explicit failure evidence, future day may proceed |

Recovery is available on another invocation of the same scheduled event or a later separately authorized operational action carrying that exact logical date. No extra Cron, queue, public/manual recovery endpoint or automatic next-day old-email send is added. Normal daily scheduling alone may not recover an ambiguous previous-day send before expiry: this is visible recovery_required, not a hidden reliability promise. Manual adjudication/runbook is needed for stale ambiguity, but a mutation/send tool is deferred; no operator may casually reset/delete a row. Evidence of acceptance permits no-send reconciliation; absence in a search result is not proof of nonacceptance.

Crash before prepared insertion leaves no send. Crash in prepared permits exact recovery. Crash after the dispatch-intent marker but before fetch is indistinguishable from a lost accepted request: replay inside the window recovers it; outside the window fail closed. That unavoidable boundary can suppress an unsent digest, but must be surfaced, not silently called delivered. No architecture can remove it with a local DB transaction alone.

## Provider outcomes and transition authority

- Valid 2xx with a bounded nonempty provider ID: accepted; record ID <=256 characters. Provider acceptance is not delivery-to-inbox confirmation.
- Allowlisted structured 400 validation/invalid-key, 401 authentication, 403 permission/domain, 422 validation or 429 quota/rate rejection: confirmed_failed only with authoritative evidence that the provider did not accept the sole possible dispatch, the journal contains exactly that slot, and the current fence still owns the transition. Status code alone is not proof; validate the documented structured rejection class. Keep last_reason; no automatic same-day retry in v1. A later failure after an earlier ambiguous attempt cannot prove the earlier request was rejected, so retain ambiguous state and reconciliation evidence.
- 409 concurrent_idempotent_requests: ambiguous/in_progress; no same-invocation retry; later same-key replay only within cutoff.
- 409 invalid_idempotent_request: integrity conflict; ambiguous plus payload_conflict reason, automatic replay blocked pending review. Never follow the provider's generic suggestion to change the key for this logical delivery.
- Timeout, lost response, connection error, Worker termination, abort, ambiguous transport error, malformed/oversized success or unknown response, 5xx: ambiguous. Do not infer that fetch rejection means no dispatch. Unrecognized error shapes remain ambiguous; never classify by message substring.
- Pure local validation/config failure before dispatch admission: no dispatch consumed; retain prepared state or release the owned no-dispatch claim. After intent but before fetch, use the fenced proven-non-dispatch cancellation rule. A lost/failed D1 claim response produces no fetch; read-back is necessary before any later action.

Maintain current30s transport deadline across headers/body; use bounded response reading (8KiB), reject redirects with manual redirect handling, no SDK retries, no raw error bodies/addresses in diagnostics. Structured outcome type carries accepted ID, confirmed rejection class, or ambiguous class. An uncertain ambiguity-update response requires an authoritative reread: durable state may already be ambiguous or accepted; if truth is unavailable, stop and retain possible-attempt evidence. A proven uncommitted update may leave attempting, which follows the same safe recovery rules. State writers use CAS/fencing; telemetry cannot authorize transitions or sending.

## History authority and post-acceptance repair

The daily delivery ledger answers: “Has this logical daily digest already been externally delivered, attempted, or left ambiguous?” Existing `notifications` alone answers: “Has this story/article alias already been delivered by email?” Ledger aliases are bounded reconciliation evidence, never an independent history index or an eligibility authority. Remove the previously proposed alias-claim table, unique alias constraints and pending-delivery exclusion contract.

Persist existing canonical alias keys, normalized URLs and observed aliases only for the actual four-or-fewer rendered items. After durable acceptance, a bounded atomic D1 batch inserts notifications with ON CONFLICT DO NOTHING, original accepted_at and provider ID, then sets reconciled_at. Existing records remain unchanged. A known rollback can be retried; an uncertain response first follows the authoritative reread protocol. Accepted lookup repairs missing history with zero Resend calls even after the provider window expires or the renderer changes. Status-only has zero aliases and immediate reconciliation.

Example: Resend accepts → acceptance is durably recorded → notification repair fails → next execution reads accepted delivery and frozen aliases → repairs missing notifications → does not resend that daily email. Repair before ordinary selection where possible; at most one older accepted row per invocation is repaired. Do not fabricate notifications from ambiguous acceptance or make hasNotificationBeenSent return true without a notification record.

Guarantee boundary: daily-key duplicate suppression is not global cross-day story suppression before notifications are repaired. Different logical days can select the same alias while earlier delivery is ambiguous or accepted-but-unreconciled; existing history semantics cannot rule that out. This amendment intentionally removes the stronger alias-hold guarantee rather than silently adding a second authority. The acceptance test must verify unchanged history-based eligibility in that case. Stronger unresolved-story exclusion would require a separate explicit scope decision. **CROSS-SOURCE EVENT DEDUPLICATION** remains a separate future feature; no semantic/event dedupe is added here.

## Telemetry and failure policy

Keep existing emailAttempts=actual POST count0/1 and existing daily modes. Add optional versioned deliveryLedger extension with safe daily key, action (first/recovery/already_accepted/in_progress/blocked), durable state, bounded reason, known dispatch count0–3 and uncertain slot count0–3 (sum <=3), reconciliation (not_required/pending/complete/failed), and provider replay evidence (same_key_requested/unknown). Do not claim a replay was deduplicated unless provider evidence actually identifies it; same key request plus accepted ID is sufficient recovery authority, not an inbox metric. No content, recipient, aliases, payload hash, API key or raw response in logs. Cap extension1024 bytes within existing8192 snapshot cap and verify strict readers; old rows without it remain readable.

Ledger unavailable before send → no untracked email. Telemetry unavailable with a healthy ledger → may still finalize the same safe status/content delivery; telemetry failure never changes a key or resets a claim. Acceptance-write failure → unknown durability/hold; history repair failure → accepted/pending, no resend. Unknown outcome is reported unknown, correcting today's blanket failed classification. Already accepted returns emailAttempts0, not a new notification count. Existing mandatory pre-analysis checkpoints remain unchanged; this is not the separate telemetry-degraded content-continuity feature.

## Tests and implementation boundary

Required amendment regressions: delayed first dispatch uses first_provider_attempt_at +23h, not scheduledAt; preparation/claim alone starts no clock; replay never extends it; known local non-dispatch cancels only its fenced slot; crash uncertainty is not refundable; a 409 concurrency response consumes one real dispatch; budget remaining cannot bypass expiry. Inject both committed-but-response-lost and not-committed failures at every mutation in the D1 recovery table, plus reread failure and competing ownership. Assert no unverified dispatch, no double budget reservation, acceptance persistence retry without POST, atomic repair reread, and no transaction spanning network I/O.

Pure unit tests: UTC scheduled-date identity (midnight/delayed duplicate), missing identity fail-closed, stable byte serialization/hash, recipient/sender/version mismatch, exact stored content winning over regeneration, all size/alias caps, state-transition/deadline arithmetic, immutable cutoff and count limits, redaction and source-independent modes.

Mock Resend tests: first acceptance, correct header/body, identical replay returns same ID with one provider-created email, timeout-after-acceptance, malformed success/5xx, explicit rejection, both409 classes, no changed-body dispatch, no retries/redirects, full response deadline. Provider mock must retain keys for24h and actually evict them so stale-replay tests would detect a second created email if the application dispatches incorrectly.

Local D1/Miniflare/Workerd tests: atomic daily reservation; two same-day invocations with different digests; different-day overlapping aliases retain existing notification-history semantics without ledger uniqueness; CAS ownership and lease expiry; stale failure after late success; crash after prepare, after claim, after provider acceptance before accepted write; failed accepted-state write; failed/partial notification repair and repeated repair; primary-consistent reads; accepted tombstone after scrubbing; transactional rollback; migration applies after deployed schema without0004. Test two separate Worker executions/persistence restart, not only a shared in-memory context. No live API or remote D1.

Worker integration matrix pins all requested scenarios: first send; same-day duplicate suppression; acceptance/write crash; timeout ambiguity; in-window exact replay; regenerated mismatch; history failure; next execution no-send repair; concurrent invocations; unavailable ledger; rejection; normal/degraded/status-only; one-attempt guard; redaction; header; expired ambiguity no-send. Also test cross-day history-only eligibility, absent scheduled identity, telemetry initialization/finalization failure, formatter status fallback with empty aliases, late old-event replay, changed credentials, attempt exhaustion and no public monitoring/recovery endpoint. Preserve Brave/RSS/Threads, Gemini/Luna and one-finalizer regressions; Threads stays disabled and needs no credentials.

Likely future files: new `src/services/emailDeliveryLedger.ts` (contracts/state rules), `src/services/d1EmailDeliveryLedger.ts` (atomic D1 boundary), proposed0010 migration; targeted `notificationOrchestrator.ts`, `monitor.ts`, `worker.ts`, `tools/email/resend.ts`, `types/index.ts`, `monitoringTelemetry.ts`; new ledger/migration/Workerd tests plus existing dailyDigestReliability, resend, notification/history, batchMonitoring, workerConfiguration and telemetry tests. No renderer redesign or source/provider-analysis changes. Reconciliation belongs to the ledger D1 transaction, reusing existing normalization/notification insert semantics, not a parallel email pipeline.

## Rollout, rollback and approval boundary

1. Human design approval → separate implementation plan → Builder TDD → independent Analyst → explicit merge/release gates. No implementation approval is implied now.
2. Additive0010 creates only the daily delivery table/constraints/indexes; old Worker remains schema-compatible but has no idempotency protection. Apply only with explicit human D1 approval, exact DB/schema checks and ready reviewed artifact. Do not apply0004 or sweep unrelated migrations.
3. Cut over outside a scheduled execution, verify no old invocation is in flight, and activate durable delivery on the next untouched UTC logical day. If today's old Worker already sent or its outcome is uncertain, do not activate sending for that day; retain the hold until the next day or separately approved evidence-based seeding. No automatic reconstruction of historical accepted digests from partial notifications.
4. Deploy only with explicit approval, verify migration/bindings/source, then natural-cycle validation. Missing ledger must fail closed with no old transport fallback. No Threads config, Cron or provider quota change.
5. Once active, rollback only to a ledger-aware compatible Worker. An old sender can ignore the ledger and duplicate email, so schema-compatible rollback is not delivery-safe rollback. A production emergency may require separately approved sending suspension; this task does not perform it. Database restore must not discard accepted tombstones/unresolved delivery evidence; keep sending blocked until reconciled. Do not downgrade telemetry readers that reject the optional extension.

Open human decisions are approval of this design's explicit conservative policy:23h replay cutoff, maximum3 actual-or-uncertain dispatch slots across invocations with proven non-dispatches excluded, terminal first-attempt rejection, delayed/expired ambiguity hold, private bounded email-content storage, and manual adjudication remaining operational rather than a new endpoint. These are proposed defaults, not undisclosed implementation choices. The strict guarantee's provider/delay assumptions and potential unsent-but-held digest are intentional and visible.

Only this design and minimal backlog/plan status are changed for the architecture checkpoint. No runtime code, SQL migration, provider call, production read/mutation, deployment, credential or Threads configuration action. **READY FOR FINAL HUMAN DESIGN APPROVAL.**
