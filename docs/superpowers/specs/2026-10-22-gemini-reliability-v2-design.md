# Gemini Reliability V2 design

Date: 2026-10-22. Status: ARCHITECTURE_READY / awaiting human design review. This is not an implementation plan or release authorization. Baseline: `0df2c2399c76b4c7c518119b6a8511a300ef9aee`. Primary scope is scheduled Gemini reliability; priority 2 is a separate bounded formatter change using the same approved product direction.

## Evidence and problem

Human-supplied production handoff: Worker `6129de15-115c-4f61-9a3b-488d26baf301`, deployment `77fbd332-da4a-4862-9608-78cb963883f9`, natural Cron `2026-10-22T08:00:49.466Z`. No live production inspection was performed in this architecture task.

Row 29 reserved at `08:01:16.221Z`, settled at `08:01:22.151Z`; row 30 reserved at `08:01:23.653Z`, settled at `08:01:24.246Z` (all 2026-10-22 UTC). Both are gemini-3.8-flash, request_count=1, confirmed_zero, tokens 0/0/0. Two dispatches, approximately 1.5-second retry gap, no third dispatch, timeout, new accounting ambiguity or Worker crash. The exact 429-versus-503 classification is UNKNOWN; zero accounting does not reconstruct it.

Degraded delivery selected four fresh raw stories, zero replay, exactly one accepted email, subject `Daily digest — AI analysis unavailable`; four notification rows share message ID `01a162a1-4cbe-72e1-96c7-8aeca90c7166`. No resend. Daily delivery guarantee is COMPLETED / NATURALLY VALIDATED for this exercised path, not an absolute guarantee against platform termination or provider rejection. Coarse retry is DEPLOYED / PARTIALLY NATURALLY VALIDATED. Source outage telemetry is deployed but not fully naturally validated. Low-score and timeout fallback were not exercised in this cycle.

## Inspected boundaries and alternatives

- `src/tools/llm/gemini.ts`: scheduled batch has one shared context/deadline, maximum two attempts, 1000–1500 ms delay, durable zero settlement before retry. `isUnavailable` accepts HTTP 503 with absent status or UNAVAILABLE. `isModelSpecificQuotaFailure` requires RESOURCE_EXHAUSTED and structured QuotaFailure violations with matching model and nonempty quotaMetric/quotaId; Help/RetryInfo details do not establish a quota window.
- Existing tests use `generativelanguage.googleapis.com/generate_content_free_tier_requests` and `requests-per-model`; neither proves a minute-versus-day reset window. Do not infer temporal semantics from arbitrary message text or substrings.
- `src/worker.ts`: `runScheduledMonitoring` logs `createScheduledCycleSummary` through console.info after finalization. There is no durable summary write. This explains the persistence gap, not the exact production log-retention/export failure, which remains unverified.
- `src/services/d1GeminiUsageStore.ts` and migrations 0001/0003/0005/0006/0007 protect usage identity, intervals, zero/ambiguous transitions and admission. Discoveries, notifications, locks and usage tables have domain-specific meanings, not generic telemetry storage. Migration 0004 is intentionally unapplied.
- `src/services/discoveryEmailFormatter.ts` already supplies dark inline-CSS/table-based normal email styling. Degraded raw items currently use unstyled sections and escape snippets without removing markup.

Console-only logging cannot satisfy recoverability. Overloading accounting/notification fields would damage their contracts. Choose two small tables in existing D1 for cycle snapshots and attempt outcomes, keeping accounting authoritative. No new database service, logging vendor or provider integration.

## Closed classification and retry matrix

Classifier input is bounded already-parsed response evidence and transport outcome, never provider prose. Output enum is exactly:

| Class | Evidence | Accounting | Retry |
| --- | --- | --- | --- |
| `none` | No failure: successful response or no dispatch | Separate authoritative outcome | No |
| `unavailable_503` | Existing reviewed HTTP 503/UNAVAILABLE predicate | Only after durable confirmed_zero | Yes, within all gates |
| `resource_exhausted_429` | Existing reviewed HTTP 429/RESOURCE_EXHAUSTED model-specific QuotaFailure predicate | Only after durable confirmed_zero | No: reset window is unproven |
| `unclassified_http_error` | Other HTTP error, including malformed/unsupported 429 or 503 | Existing conservative accounting rules | No |
| `timeout` | Local deadline/abort establishes timeout | Existing timeout ambiguity | Never |
| `transport_error` | Other dispatch/body-read transport failure | Existing ambiguity | Never |
| `response_invalid` | Missing/invalid usage or invalid analysis response | Exact if trustworthy usage settled; otherwise existing ambiguity | No |
| `accounting_failure` | Admission/settlement persistence fails | Preserve actual stored state, never guess | No |

Keep HTTP status separately as integer 100–599 or null; this preserves observed HTTP distinctions even when error details are untrusted. It does not grant zero settlement or retry eligibility. Keep bounded preflight/admission reasons separately, not as fabricated provider failures. Preserve the provider failure class if later accounting fails: a separate accounting outcome/error flag captures settlement failure rather than overwriting the observed HTTP evidence.

Do not add rate_limit_exceeded_429, too_many_requests_429 or quota_exhausted_429 aliases without distinct reviewed structured evidence. In V2 all currently recognized 429 quota failures stop immediately; this includes hard quota exhaustion and avoids speculative retries. A future narrowly reviewed exact identifier/window mapping may distinguish transient rate exhaustion, but is not required or authorized here. No free-text, RetryInfo-only or arbitrary quotaMetric-based promotion to retryable. This conservative decision closes the design without inventing provider semantics.

## Dispatch and timing contract

Normally one dispatch, maximum three total, same approved model, same frozen batch. Only unavailable_503 with durable confirmed_zero may advance. No model/provider fallback. Consume the shared attempt allowance before dispatch; each attempt requires a fresh atomic quota-checked reservation and separate request count. Current global request/token ceilings remain unchanged and can stop retries early.

Use one monotonic 90-second envelope from first dispatch. Reserve its last 15 seconds for transition to fallback/finalization: all Gemini dispatch, body reading and parsing must stop by T+75 seconds; never grant a new per-attempt 90 seconds. Backoff before attempt 2 is 1500 + uniform integer jitter 0–500 ms; before attempt 3 is 3000 + jitter 0–1000 ms. This is bounded exponential base delay, at most six seconds total sleep. Inject clock/random/sleep for tests.

Retry requires at least 10 seconds left before T+75 after the sampled delay; otherwise skip immediately. Recheck admission, cancellation, remaining budget and confirmed prior settlement after sleeping. Per-attempt abort deadline is the same T+75. Any timeout/ambiguous execution ends Gemini for this cycle. The reserve provides fallback opportunity, not a hard end-to-end platform or email-delivery guarantee; do not abort or suppress the existing finalizer at T+90. No whole-cycle retry, background execution or timer-based restart.

The stricter effective Gemini cutoff is a proposed V2 behavior, not today's deployed timeout. Preserve accounting's timeout-day admission rules and all historical uncertain rows. Do not reclassify old timeouts or force stuck reservations to zero.

## Durable cycle/attempt evidence

Propose additive `migrations/0008_monitoring_cycle_observability.sql` (confirm number availability during future implementation). Human migration approval is mandatory before production application. Do not modify 0004–0007 or existing accounting transitions.

Use existing Worker DB binding and D1 persistence conventions:

1. `monitoring_cycles`: invocation UUID primary key (not date-only); scheduled UTC date/time, start/update/completion timestamps, bounded phase enum (`started`, `sources_complete`, `gemini_complete`, `email_attempting`, `completed`), nullable validated source SHA and Worker version, versioned bounded snapshot JSON, incomplete/completed state. Different invocations never overwrite each other. Missing version metadata is null, never inferred from local HEAD.
2. `monitoring_gemini_attempts`: primary key (cycle_id, ordinal 1..3), unique usage-row ID, exact approved model, start/end timestamps, observed HTTP status or null, closed failure class, authoritative accounting outcome or unresolved marker, bounded retry decision/reason. Bind to the immutable usage identity. Attempt intent exists before dispatch; no prompt, content, URL, token guesses or provider response payload.

Cycle snapshot allowlists existing Brave `healthy|degraded|unavailable|quota_blocked`, RSS `healthy|degraded|unavailable`, outage boolean, bounded candidate counters, dispatch count 0..3, delivery mode/reason, story counts 0..4, email attempts 0..1, email outcome/history outcome, and accounting aggregate. Before observation use null/unknown, never default healthy or no-outage. Reuse current summary serializer semantics; independently validate when persisting and reading. Limit snapshot to 8 KiB UTF-8; reject unsupported fields, do not truncate JSON. Closed schema version 1, no arbitrary metadata bag.

Persist source checkpoint before Gemini so later termination cannot erase source evidence. Persist validated response classification before/with settlement, independently of the final console summary. Outcome writes must preserve exact usage/ambiguity evidence as well as confirmed-zero failures; keep their original transition guards. No code path may store a provider message in place of an enum. For confirmed-zero retry candidates, use one atomic D1 batch for guarded accounting settlement and durable attempt outcome. Require exactly the expected reservation identity/status transition and matching attempt update; assert affected identity/state inside the transaction, so a zero-row compare-and-set cannot commit a false settled outcome. Replay of the same write is idempotent only for identical evidence; conflicting evidence fails. Verify real local Workerd/Miniflare transaction and meta.changes behavior rather than assuming one change when triggers are involved.

If the outcome transaction fails, do not retry Gemini; preserve uncertainty, best-effort bounded error checkpoint, continue existing degraded/status finalizer. Accounting safety takes precedence over telemetry completeness. If initial cycle/attempt storage cannot be established, skip Gemini and still finalize delivery. Couple attempt creation with reservation where possible; if an acquired reservation fails before fetch is invoked, use the existing proven pre-dispatch rejection/zero-settlement path. A failed cleanup remains unresolved and blocks further dispatch; never deliberately abandon it or manufacture transport evidence. No telemetry error may initiate another email or convert usage to zero. Existing ambiguity/reconciliation behavior remains authoritative; platform death can strand a reservation, which must stay unresolved pending existing recovery rather than be silently repaired.

Checkpoint `email_attempting` before the existing single send. This telemetry is not a new delivery ledger or resend lock. If that checkpoint fails, the existing consumed in-memory one-email guard remains authoritative and delivery still proceeds. After send/history completion, persist final bounded outcome; on failure retain incomplete/unknown, log bounded persistence failure and never resend. There is no atomic transaction across D1 and Resend: an email-attempting record is not proof of acceptance. Notification records remain success evidence.

Console summary remains supplementary. Query cycle row plus ordered attempt rows for forensic proof; an incomplete row is explicitly incomplete, not successful. No system can promise durable evidence during D1 outage/platform termination: V2 closes normal console-retention loss, gates retries on durable proof and exposes residual gaps honestly. Telemetry persistence performs no unbounded retries; failure proceeds to fallback. Retain records for this initial rollout without adding automatic deletion; retention/compaction is separate reviewed maintenance, not a hidden scheduled subsystem. Growth is bounded per invocation (one cycle, at most three attempts).

## Accounting and delivery invariants

Keep immutable reservation identity, one unresolved structured owner, monotonic accounting_through, exact/zero/ambiguous transitions, quotas, timeout-day admission, and historical rows untouched. Never dispatch after failed accounting or based solely on an HTTP integer. Durable class is diagnostic evidence, not authorization to settle zero. No double reservation for one dispatch, no duplicate attempt settlement, no retry after transport/semantic failures.

Keep the deployed finalizer: analyzed selections plus eligible replay → normal; no usable analysis → deterministic safe raw candidates plus eligible replay → degraded; no safe story payload → truthful status-only. At most four stories and one consumed email attempt, unchanged URL/history dedupe, notification semantics and low-score analyzed labels. Raw fallback never pretends to be analysis. No source acquisition/ranking redesign. Partial RSS failure remains degraded; healthy-empty is not outage; quota denial is not operational outage.

## Priority 2: degraded visual architecture

Reuse existing formatter colors (#090d16 page, #111827 card, #182235 panel, #f8fafc primary, #a8b3c7 secondary, #78a9ff accent), bounded centered table shell, typography, borders, CTA and footer. Share small rendering helpers only where necessary; no new brand, external stylesheet, script or web-layout dependency.

Header `AI AGENT RADAR — DAILY DIGEST`; badge `DEGRADED MODE`. For provider unavailability: `AI analysis was temporarily unavailable. These stories were selected directly from today's discovery results.` Keep truthful reason-specific wording for successful analysis with no selections, and identify replay slots as previously analyzed rather than claiming they came from today. Raw cards show index, original title, safe source hostname, optional cleaned snippet and styled `View source` CTA. No raw score, `It could be relevant`, or AI-summary label. Existing analyzed replay cards retain their own truthful score/low-score semantics; the raw restrictions do not erase replay provenance. Status-only shares the shell without fabricated stories.

Snippet cleanup is a small pure formatter utility: bound input before processing; remove complete script/style blocks and tag-like markup with a linear bounded scanner; convert tag boundaries to spaces; decode only amp/lt/gt/quot/apos/nbsp once; remove any decoded tag-like constructs without recursively decoding; drop controls, collapse whitespace, trim, then UTF-8 truncate to existing 768-byte snippet limit. Omit malformed/unterminated markup tails rather than expose them. Escape the resulting text at HTML interpolation; never treat cleaned text as HTML. No general HTML parser or dependency. Invalid links remain non-clickable under the existing safe HTTP(S) rule. Use the same cleaned text in useful text/plain output with explanation, numbered titles, source, snippet and URL.

## Verification and release gates

Future Builder tests must prove:

- Exact accepted 503 forms; reviewed 429 stops; mixed/malformed details, arbitrary text and unknown classes cannot retry; observed status retained without inventing class. Authentication/policy errors stay terminal. No raw provider data in records or logs.
- Fake-clock/jitter bounds, one shared deadline, max three dispatches, quota denial before every retry, no dispatch without minimum time, no timeout/network/semantic retry, independent reservations and no double counting.
- Actual local D1 migrated through supported migration order; atomic outcome/settlement rollback on any failure, zero-row CAS, duplicate/conflicting writes, process interruption boundaries, unique attempt IDs, immutable usage safeguards and original accounting regressions.
- Fresh process reads cycle/attempt evidence after console loss; source checkpoint survives later failure; known 429 versus503 remains recoverable; persistence failures stop Gemini retry but do not prevent guarded fallback or cause duplicate email; acceptance/history uncertainty remains honest.
- Existing source-health, candidate limits, replay/alias/no-resend, low-score, raw/status delivery and one-email regressions unchanged. Raw and analyzed replay mixed-card cases remain truthful.
- Formatter HTML/text tests for markup/entities/double encoding, malformed tags, malicious links, controls, multi-byte length, four cards, missing snippets and status-only; inspect generated representative HTML locally without sending email.
- Full existing offline suite/build/Worker typecheck/bundle verification after implementation, plus independent Analyst review. No production monitoring for tests.

Expected later files: Gemini adapter/types and usage-store boundary (`src/tools/llm/gemini.ts`, `src/services/d1GeminiUsageStore.ts` and its interface), new bounded D1 cycle persistence module, `src/worker.ts`, minimal Batch result plumbing, proposed 0008 and focused Gemini/accounting/Batch/Worker tests. Priority 2 separately touches `src/services/discoveryEmailFormatter.ts`, a small snippet helper if needed and formatter tests. Final implementation plan must resolve exact test-file edits from current tree; this document does not authorize implementation.

Release requires human design approval, implementation plan approval, Builder verification, independent Analyst review and human migration/deployment approval. Apply additive telemetry schema before the compatible new Worker; old Worker ignores it. Rollback must respect existing accounting safety and does not undo telemetry history. Natural validation must separately prove durable failure classes, exercised retries/backoff, source-health persistence, styled delivery, accounting and one-email outcomes. Do not claim a path was validated if it did not occur. Before next roadmap item actualize all five roadmap/state/summary/changelog files.

## Boundaries and decisions

No runtime edits in this task. No provider/model fallback, OpenRouter, background execution, RSS body_limit fix, Threads, X reactivation, legacy cleanup, new channel or ranking redesign. Background execution is only a later timeout-specific escalation; it would not solve today's fast confirmed-zero failures. No migration/application, D1 mutation, monitoring, push, merge or deployment is authorized here.

No unresolved architectural decision is required for this conservative V2 design. Human design and future migration/release approvals remain gates, not claimed approvals. Unknown production error class and exact log-loss cause remain explicitly unknown; neither blocks the proposed bounded architecture.
