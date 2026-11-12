# Brave Request Timeout + Bounded Response

2026-11-11. DESIGN FOR HUMAN REVIEW; no implementation authorization. Baseline `e97440a99d918e7df905e4b22f5560c9649d6620`. This is the next proposed bounded Builder task, not a Brave accounting redesign.

## Inspected behavior

`src/tools/webSearch.ts` checks configuration/query and `checkBraveSearchUsage`, performs one POST with count=5 and optional freshness=pw, then records one usage request immediately after successful HTTP headers, before JSON parsing. Non-2xx bodies use unbounded response.text(), redact only the key and can expose provider messages; success uses unbounded response.json(). Fetch has no explicit timeout and follows redirects by default. `searchWebPage` retains the first five provider positions, including unusable positions, and `searchWeb` projects usable results. Preserve both public return shapes and rawCount semantics.

`src/services/usageGuard.ts` and `d1BraveUsageStore.ts` retain existing success-based accounting and configured 10/100/350 limits. Monitoring catches non-quota search errors and continues subsequent distinct queries; guard denial terminates discovery search. `monitor.ts` already bounds/redacts error messages, but a fixed message at the transport origin is safer than forwarding provider text. Worker wiring must retain a correctly bound native fetch wrapper. No D1/schema, quotas, telemetry schema or broad caller refactor is needed.

## Proposed limits and behavior

Source-controlled constants beside the Brave transport: deadline 5,000 ms; success response 262,144 bytes (256 KiB); unsuccessful response 16,384 bytes (16 KiB). Five requested result positions justify a conservative success allowance; the small error body is never useful to selection. These limits are deliberately new rejection boundaries, subject to human approval and later natural validation; they are not claimed empirically adequate for all live responses. No environment knob or quota increase.

Keep preflight/config/usage checks before dispatch. Start a monotonic deadline immediately before the sole fetch; use AbortController and pass signal plus redirect='manual'. No automatic redirect, retry, pagination or alternative endpoint. A 3xx is a fixed redirect error, cancel its body without following Location; API credentials never travel to a redirected host. This explicitly tightens the previous implicit-follow behavior to enforce one HTTP request.

Use one abort-aware await helper for fetch and reader.read(), not only signal delivery: a delayed/stalled promise must not hold the network path open when the timer fires. Attach rejection handlers to losing promises. Handle late header arrival by cancelling its body; never promote a timed-out operation to success. Use a correctly bound fetch call in Workers; no extracted native method invocation.

On observed 2xx headers before the deadline, initiate exactly one usage record immediately, before length rejection, decoding or parsing. Retain this record on subsequent body-limit, timeout, encoding, JSON and response-shape failure. Body reading can start while that one persistence operation settles; never return candidates until usage persistence succeeds. On persistence rejection, fail closed and cancel/abort body work. If both fail, accounting failure takes precedence over transport reporting; never attempt another record. A late-arriving successful response after the deadline is discarded, not counted as a newly successful operation.

The deadline covers dispatch, headers and all body reads/decode/parse checks; no reset between phases. Use monotonic elapsed checks immediately before and after synchronous decode/parse and reject if expired. JavaScript cannot preempt synchronous parsing: bounded input limits its work, and a post-parse check prevents late candidate admission. This is not a hard CPU preemption promise.

D1 operations are separately authoritative, not cancellable network-body work. Do not race an unfinished usage write and claim it was rolled back, or allow the cycle to continue as if no record exists. Await its actual outcome; the 5-second transport deadline aborts body work independently. An indefinitely unavailable storage operation remains the existing storage/runtime failure boundary. Do not claim that this change imposes a new cancellable D1 deadline.

## Bounded reader

Select limit from HTTP success/error class. For Content-Length, accept only a nonempty unsigned-decimal value whose numeric size is safe and within limit; invalid or oversized values fail closed as body_limit. Do not trust the header as actual length, require it, or insist on equality (content decoding can differ). Count bytes actually exposed by the response stream, including decoded transfer content; missing header receives the same streaming cap.

Never use response.text/json/arrayBuffer. Acquire one reader, sum Uint8Array byte lengths before retaining each chunk, reject on first excess, and retain at most the cap. No truncation-and-parse. Strict TextDecoder('utf-8', {fatal:true}) and JSON.parse only on complete bounded successful body; existing envelope validation, position retention and normalization follow unchanged. Empty successful body is invalid_json; a valid empty-results envelope remains success. A null error body is ordinary HTTP failure. Error bodies may be drained within their smaller bound and deadline, but are discarded without decoding/logging; malformed bytes there remain an HTTP error, not a source of diagnostic text. Oversize/timeout still get their explicit transport category.

On every exit clear timer/remove listeners. On early exit abort fetch, request stream cancellation, observe cancellation rejection and release lock when outstanding reads settle. Do not await a maliciously hanging cancel promise beyond the deadline; cleanup is best effort and bounded. On EOF release normally. Never include raw bytes, request URL/query, headers, statusText, exception message or API key in errors. No arbitrary error cause attached to a loggable object.

## Error contract and accounting limitations

Keep BraveUsageGuardDeniedError unchanged. Introduce a small typed BraveRequestError with closed reason: timeout, redirect, body_limit, transport, invalid_utf8, invalid_json, invalid_response, http, accounting. Fixed messages only; optional numeric HTTP status 100–599 is safe. Existing callers can continue handling Error; update brittle message tests explicitly rather than silently changing quota-denial handling. Provider error bodies no longer appear in output.

Success headers imply one record, even if the body is bad/too large or times out. Non-2xx, redirect, transport failure and timeout before accepted headers imply no successful-request record, as today. Provider may nevertheless have charged for a failed/ambiguous attempt: this success-based ledger is not exact provider billing and has no reservation/unknown-use mechanism. Do not write fake zero usage, change existing units, retry ambiguous attempts, or claim the cap tracks all provider charges. The new short deadline can expose more uncounted ambiguous failures, an explicit residual risk; do not compound it with retries or additional queries. Absolute attempted-query ceiling stays ten; a daily/weekly/monthly denial still stops sooner. A future accounting correction needs its own design and authorization.

## Scope, evidence and release

Likely changes after approval: `src/tools/webSearch.ts`, `test/webSearch.test.ts`, narrow assertions in `test/batchMonitoring.test.ts` / `test/workerConfiguration.test.ts`, and a local-only `test/workerd/braveRequestBounds.worker.ts`, `.test.mjs`, `.wrangler.jsonc` harness. Optional Worker wiring change only if native receiver proof requires it. Keep helper internal to Brave unless tests demonstrate a need for a small adjacent helper; do not generalize other transports. Update the relevant handoff docs with actual evidence. No production config, dependency, migration, query, accounting-store, guard, analyzer, email or RSS change.

Preserve source-health isolation: a failed query does not abort RSS or subsequent allowed distinct Brave queries, and no new analysis/send path is introduced. Candidate selection, first-five positions, quotas, HTTP health-only, scheduling, Gemini/Luna admission and email ledger remain identical.

See [sequential TDD plan](../plans/2026-11-11-brave-request-bounds.md). Independent Analyst verifies the exact diff, deadline/cleanup races, response ceilings, successful-header record timing, no private content, one request per query, no redirect egress, no quota drift and real Workerd behavior. Human approval of design/Builder scope precedes implementation; review, merge/publication and deployment approvals remain separate. If released with RSS subreasons, its compatible-reader release gate still applies. Natural-cycle evidence later checks query counts/durations/categories and delivery without live probes or manual monitoring.
