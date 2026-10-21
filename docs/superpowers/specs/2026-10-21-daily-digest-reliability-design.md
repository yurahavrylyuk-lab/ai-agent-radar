# Daily digest reliability / Gemini-degraded delivery

Date: 2026-10-21. Status: ARCHITECTURE READY for human review; not implemented or deployment authority.

## 1. Goals, baseline and non-goals

A normally executing natural scheduled invocation with configured/available mail transport must reach exactly one final email attempt, whether it has analyzed stories, unanalysed discoveries, replay, or only operational status. At most four stories; no invented stories or analysis. This is an attempt guarantee per invocation, not proof of inbox delivery or global exactly-once delivery across duplicate scheduler invocations. Process termination, platform failure before finalization and missing mail configuration remain explicit limitations. No new scheduler, durable daily lock, queue or delivery retry is proposed.

Inspected source/main baseline: `4fad7003c6619aa1fdee2b27c0f9cae219a9aa60`. Human-confirmed current Worker: `fb6b4691-938e-4c17-8dbd-5cb62d865d35`. No Cloudflare query was performed. Current production includes Brave/RSS, shared canonical/history dedupe, one Gemini batch dispatch, 50 candidates/32 KiB prompt, four-story/one-email ceilings, low-score delivery with explicit labelling, replay and source-health telemetry. X is disabled/deprecated; 0004 stays unapplied.

Non-goals: RSS limit fixes, Threads, X cleanup, relevance redesign, feedback, model fallback, second provider/ranker/email, quota increases, background execution, new D1 schema or changes to historical accounting rows. Existing HTTP remains health-only.

## 2. Failure evidence and inspected seams

Human-supplied natural invocation `2026-10-21T08:00:49.466Z` ran source `f53acb06642c7880c62f3c9457562c9d42e61b24`: 42 candidates, approximately 22,367 prompt bytes, one gemini-3.8-flash dispatch, 90-second timeout, row 28 `transport_ambiguous / timeout`, zero selections, zero eligible replay, no email. This is not a natural-cycle proof of the later current deployment's multi-source telemetry.

`runBatchMonitoringCycle` currently catches Gemini errors, then only invokes `notifyBatchDeliveryDigest` when delivery candidates exist. That notifier also returns without sending an empty digest. History failures can escape before delivery. `generateBatchWithGemini` consumes one cycle context; batch policy permits one attempt. Existing reviewed failure classification is created only after confirmed-zero settlement. These are the bounded modification seams.

## 3. Target state machine and convergence

`START -> COLLECT/DEDUPE -> ANALYZE (optional eligible retry) -> PREPARE_DELIVERY -> FINALIZE_ONCE -> RECORD_OUTCOME -> END`.

Prepare a small discriminated delivery value: `normal` (analyzed fresh/replay), `degraded` (unanalysed fresh, optionally replay), or `status` (no stories). Never fabricate an AgentAnalysis/relevance score for raw items. A delivery item is either an existing analyzed candidate or a raw candidate carrying original title/URL/snippet/provenance; source labels come from validated origin/hostname, never generated claims.

Refactor selection/rendering out of the scheduled notifier's send operation. One scheduled finalizer owns the only sendWithResend call. Source/Gemini/history/preparation errors are caught before that boundary and converted into safe delivery decisions. A minimal static text+HTML status template is available if richer rendering fails. Do not wrap the send in a catch that attempts a fallback email.

Consume a cycle-local `emailAttempted` flag synchronously immediately before invoking mail transport; repeated/concurrent finalizer calls cannot send again. Provider rejection, timeout, ambiguous acceptance, or notification persistence failure ends the send path. Never resend, replace, or send a second status email. Retain the existing onAccepted boundary before notification writes. A configured mail transport is independent of discovery/Gemini dependency initialization so a non-mail initialization error can still produce status.

## 4. Normal, degraded and status selection

Normal: retain valid persisted Gemini selections, including current scores 1–10 and `It could be relevant` for scores below 7. Preserve existing fresh-first order and eligible replay ordering (score, firstSeenAt, URL), shared four-slot cap and double notification-history checks. Do not restore the superseded score >=7-only batch policy.

Degraded is allowed when Gemini is blocked, times out, fails, preparation fails, or returns a valid empty selection. A valid empty selection is labelled accurately as no usable AI selection, not as a provider outage. If any normal fresh selections remain deliverable, use normal+replay; do not fill spare slots with raw items. If none remain, use deterministic raw candidates and then eligible replay for remaining slots. If no raw items survive, use replay first; if no replay survives, use status. If valid model selections fail persistence, do not reclassify those failed selections as raw fallback to bypass a persistence error; conservatively use safe replay or status.

Raw fallback takes the first up to four eligible items from the existing prepared pool's deterministic candidate order, before prompt byte tail truncation (at most 50). It performs no new ranking, search, article fetch, analysis, trust score, or model request. Candidates already excluded as known/notified never return. Recheck all observed canonical aliases against authoritative notification history immediately before the cap, so removals can be filled from the same bounded pool. Keep original URL/title binding, URL safety and homepage rules. Do not strip new tracking parameters or change durable normalization.

When the shared pool cannot be prepared safely because discovery/history evidence is unavailable, do not use unchecked raw observations. When notification history is unreadable, suppress ALL stories and send status only. Replay lookup failure also yields status rather than guessing replay eligibility. A failure to read histories must not suppress the status email, which needs no story history.

Degraded heading: `Daily digest — AI analysis unavailable`. Explain: `These stories were selected directly from today's discovery results; AI analysis was unavailable.` For validated empty selections use `Daily digest — discovery highlights` and explain that AI returned no usable selections. Show original title, safe source hostname, HTTP(S) link and bounded existing snippet (maximum 768 UTF-8 bytes); no score, fabricated summary, why-it-matters, technologies or recommendation. Annotate any replay subsection as previously analyzed, not fresh. Escape text/attributes and render plain text too.

Status heading: `Daily digest — status update`. Include UTC scheduled date and bounded truthful reason(s): no new eligible stories, AI unavailable, discovery unavailable/degraded, history unavailable, or preparation unavailable. Distinguish successful empty discovery from outage and Brave quota blocking. Never claim there was no news when the system could not determine that.

## 5. Replay, notification history and persistence

Preserve existing replay window, cutoff, scan bound, ordering and low-score eligibility only with existing Batch provenance. Fresh/replay/raw share canonical alias grouping and four slots. No new replay lane for raw items.

After provider acceptance, record raw story notifications through existing normalized-URL/email history for the representative and observed aliases, using the same semantics as analyzed delivery. Do not create a discovery/analysis row or fake batchSelectionProvenance for raw stories. Future shared pool preparation already checks notification history and excludes these items. Raw fallback not accepted by the mail provider has no success record and may reappear through future discovery; it is not durable replay.

Status email writes no fake story notification. Accepted-email/history-write failure remains the existing duplicate-risk window; report accepted/persistence_failed and never send again in this invocation. This architecture does not promise a distributed transaction with Resend.

## 6. Gemini bounded retry and accounting

Implement this AFTER daily-delivery fallback is independently working. One logical Gemini batch, same primary model and exact same prepared prompt; at most two dispatches, with a single shared cycle context and frozen allowance. Do not call generateBatchWithGemini twice or reset batchStarted.

Attempt 2 is eligible ONLY when attempt 1's existing structured classifier yields `resource_exhausted_429` or `unavailable_503` AND its own durable reservation successfully settles to confirmed_zero. HTTP status alone, log metrics, string matching, malformed 429/503 bodies, and uncertainty are insufficient. Retain the accepted classification predicates; do not broaden 429 to arbitrary account/shared quota failures. Quota rejection before reservation is not a retryable provider response.

Use one bounded delay `1000 + floor(random * 501)` milliseconds (1000–1500 ms, injectable RNG/sleep for tests). Never sleep for unbounded provider Retry-After. Retain a TOTAL 90,000 ms Gemini execution budget from first dispatch through all response reading/parsing and retry backoff; attempt 2 uses only the remainder. If backoff cannot fit, skip retry and degrade. Do not reset to another 90 seconds. All current source bounds remain unchanged; no discovery rerun. A timed-out second attempt follows the same ambiguity handling as the first.

Before attempt 2: recheck global request/token/day/week/month admission, unresolved ownership, UTC windows, frozen remaining request allowance, available time and same-cycle dispatch count. A denied check skips retry and delivers degraded/status; never clear the latch or increase quotas. Keep original prepared data immutable across attempts.

Each dispatch has a DISTINCT reservation and request_count=1. Attempt 1 confirmed_zero keeps its row/identity/interval and zero tokens, still counting as one request. Attempt 2 independently settles exact, confirmed_zero or transport_ambiguous. Failure to record attempt 1's zero prevents attempt 2; settlement errors never authorize retry. Counters distinguish reservationAttempts/reservations/providerDispatches and must not equate them. Existing schema/transitions suffice; no accounting migration is proposed. Update only batch policy ceilings and sanitized metric ranges from 1 to 2; keep legacy retry policy isolated.

No retry for timeout, network error, unreadable body/usage, transport ambiguity, auth/permission/policy/request errors, malformed output, or semantic validation failure. Valid provider usage on unusable model output remains recorded; deterministic delivery does not change it. Row 28 stays historical timeout ambiguity with unknown tokens; fallback never resolves it or implies zero usage.

## 7. Timeout alternatives

Choose synchronous bounded Gemini plus deterministic fallback. Today's single 22,367-byte sample is insufficient to justify new prompt compaction or a larger timeout; preserve the 50-candidate/32 KiB preparation policy. Collect bounded prompt-size/latency/outcome evidence first. Background Gemini would require a queue, later reconciliation and a decision about delayed/second emails; defer it. No extra Worker lifetime or arbitrary timeout extension is required for retry because both attempts share the existing 90-second budget.

Mail transport also needs its existing 30-second bound to cover response-body reading/parsing, not just response headers: current sendWithResend clears its timer before reading the body. Include this directly related bounded completion fix; no mail retry is introduced. Platform termination still cannot be converted into a guaranteed email.

## 8. Observability, security and privacy

Extend the existing one cycle summary with deliveryMode (normal/degraded/status), closed deliveryReason, raw/replay/analyzed story counts, emailAttempts (0/1), emailOutcome (accepted/failed/unknown/not_attempted), historyOutcome and finalizationReached. Do not treat a call attempt as provider acceptance or acceptance as inbox delivery. Keep source-health/outage signals unchanged. Both-source outage can still end in replay/status email.

Gemini diagnostics: at most two fixed attempt summaries with ordinal, reviewed failure class when available, accounting outcome, bounded duration, retryEligible/retryAttempted/retrySkipReason, total dispatch count and total elapsed budget. Preserve prompt byte/candidate counts without content. Sanitize all fields with allowlists. Never log feed/article URLs, titles/snippets, prompt/body, recipient, secrets, headers or raw exceptions. Degraded content is untrusted text; no HTML execution, crawling or generated destination URLs.

## 9. Acceptance and focused verification

Offline TDD with fake clocks/RNG and injected providers/history:

- Normal, low-score, raw-only, raw+replay, replay-only, valid-empty AI, zero discovery and full source outage each reach exactly one final attempt; selection cap four and source integrity preserved.
- Timeout matching row-28 incident yields raw/status email with ONE Gemini dispatch and immutable ambiguity; no retry/provider accounting repair.
- Safe 429/503 + durable zero allows exactly one same-prompt retry; second success/zero/timeout all represented by separate rows; third dispatch impossible. Failed zero settlement, arbitrary 429, malformed responses, auth and network ambiguity forbid retry.
- Total 90-second boundary covers first/second bodies and backoff; injected delay stays 1000–1500 ms; quota/UTC-boundary checks can reject retry. Frozen allowance 1 admits no second request.
- Empty/known/notified pools, alias collisions, changed notification evidence, unavailable histories and replay failure select safe replay/status, never unchecked stories. Raw acceptance records notification aliases without fabricated analysis and prevents future resends.
- Render failure before send uses status; concurrent/repeated finalization, provider rejection/timeout/body stall and post-acceptance persistence failure never produce another send. Email body deadline remains 30 seconds total.
- Injection/unsafe URLs and logs stay sanitized; normal/replay policies and source health remain unchanged. No X/0004/schema/config changes.

Likely implementation seams: services/monitor.ts, notificationOrchestrator.ts, discoveryEmailFormatter.ts, types/index.ts, worker.ts, tools/llm/gemini.ts and tools/email/resend.ts, plus corresponding existing tests. Reuse history adapters. If persistence changes appear necessary, return for scoped review rather than silently extending schemas. This is a design, not an implementation plan.

## 10. Rollout and natural validation

Phase A: daily finalization/fallback and offline end-to-end tests while Gemini stays one-dispatch. Independent review, human release approval, deploy, then observe natural Cron only. Validate at least normal, degraded and status paths offline; mark each naturally exercised path separately, never induce production failures/provider calls.

Phase B: bounded retry after Phase A acceptance; offline accounting/timeout tests and full build/test/Worker bundle checks, independent review and human release approval. Naturally observed safe transient + retry is required before claiming NATURALLY VALIDATED retry; if none occurs, retain DEPLOYED / NOT YET NATURALLY EXERCISED.

Phase C: correlate natural invocation, deployed SHA/Worker, source health, mail attempt/outcome and accounting rows with read-only evidence when authorized. Current 4fad700 telemetry is deployed but has no supplied natural validation. Never merge that claim with the earlier f53acb failure.

Then proceed through the authoritative roadmap in backlog.md. Preserve the permanent Backlog/Plan Actualization Checkpoint. No unresolved product decisions; implementation must prove these bounds. Architecture acceptance is not deployment authority.
