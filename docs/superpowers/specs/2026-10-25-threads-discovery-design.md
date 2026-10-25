# Threads discovery

Date: 2026-10-25. Status: **DESIGN READY / AWAITING HUMAN APPROVAL**.
Architecture only; no implementation or implementation plan is included.

## Authority and scope

Design base: local governance main `aed8263256fd38689ac1febea39f76689df4d035`; local `origin/main` and recorded production source `bd2a3220611e5992b226e6cf7c0f9ec0b92c18ac`. Production Worker `6a1dcef4-e5cc-414a-aa89-6bf194fa5b60`, deployment `f0dbb968-a9b0-4719-9614-035571b1e917`, is recorded as DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION. This task did not inspect production. Migration 0009 is recorded applied; 0004 remains unapplied; X remains disabled; Cron remains `0 8 * * *`.

Threads is the next roadmap feature. Natural Gemini Latency, RSS BODY_LIMIT and cross-provider failover validation continues independently. Historical multi-model/retry descriptions in older governance records do not override the current V2 implementation: one logical Batch, existing bounded Gemini attempts, then at most one Luna request under its exact exhausted three-attempt unavailable_503/confirmed_zero gate. No new inference lane, admission exception, or cost allowance is introduced.

## Existing flow and chosen change

`monitor.ts` collects Brave and RSS before `prepareBatchCandidates`; `batchCandidates.ts` validates observations, groups normalized URL aliases, checks discovery/notification history, touches known URLs, interleaves sources, and bounds the raw pool to 50 candidates. `batchCandidateSelection.ts` selects at most 24 with query/feed rotation and a soft hostname preference. `batchPrompt.ts` compacts to at most 12,288 UTF-8 bytes. The same PreparedBatch feeds Gemini and, only when eligible, Luna. The full retained raw pool remains available to deterministic degraded rendering and the existing one-email finalizer.

Repository discrepancy: older roadmap prose says the raw pool is bounded to 32 KiB. The inspected `batchCandidates.ts` enforces 50 candidates but no aggregate raw-pool byte ceiling; 32,768 remains in a legacy telemetry sanitizer, not a raw-pool enforcement boundary. Preserve actual behavior here; do not introduce an unrelated new pool budget or claim one exists. The enforced submitted prompt limit is 12,288 bytes.

Add one optional `collectThreads` call after RSS and before shared dedupe. Append its BatchObservations to the same observations array. Extend the two source-aware selection stages and bounded telemetry explicitly to three sources. Do not make a generic discovery framework. Existing discovery/history persistence remains source-neutral.

Alternatives:

| Approach | Decision |
| --- | --- |
| Dedicated official keyword collector → BatchObservation | Choose: bounded, explicit provenance, existing shared pipeline. |
| Threads search through Brave | Reject: cannot establish the approved official public-search contract; couples source health and quotas. Brave may independently return Threads URLs. |
| Separate Threads analyzer/digest | Reject: violates one shared Batch, cost and email invariants. |

## Official API evidence

Official documentation was read on 2026-10-25. Documentation access only; no authenticated API, post search, or provider execution occurred. These are documentation facts, not proof that this project's app has access.

- [Keyword and Topic Tag Search](https://developers.facebook.com/documentation/threads/keyword-search) documents `GET https://graph.threads.com/v1.0/keyword_search`, a Threads user token, and `threads_basic` plus `threads_keyword_search`. Before approval for the latter, results are limited to the user's own posts; approved apps may search public posts. Therefore successful HTTP/empty results alone do not establish public access.
- The same reference specifies required `q`; `search_type=RECENT` means newest, whereas TOP is popularity-oriented and the default; `search_mode=KEYWORD` is default, TAG searches topic tags. `since`/`until` accept Unix timestamps, with since before until and until no later than current time. Limit defaults to 25 and has maximum 100. Fields shown include `id,text,permalink,timestamp,username,media_type,is_reply,is_quote_post`. The app user's posts are excluded from public results. Keyword search has a separate 2,200-query/user rolling-24-hour limit across apps; repeated queries count, while empty-result queries are described as not counting. The application counts every attempted request regardless.
- [Overview](https://developers.facebook.com/documentation/threads/overview) says both `graph.threads.com` and `graph.threads.net` are supported. Use the documented `.com/v1.0/keyword_search` endpoint as a fixed constant; no host fallback or redirect. General app/user call and CPU/time limits also exist and can reject even a small request. Do not substitute publishing quotas for keyword-search limits.
- The keyword reference does not establish a pagination guarantee on which this feature depends. Use only the first response page, ignore any `paging`/cursor/next URL, and never follow it. No cursor storage is needed.
- [Long-lived tokens](https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens): short-lived tokens last one hour; long-lived tokens last 60 days. Exchange uses `https://graph.threads.com/access_token` with `th_exchange_token` and an app secret server-side. Refresh uses `https://graph.threads.com/refresh_access_token` with `th_refresh_token`; token must be at least 24 hours old and unexpired, with threads_basic. Expired tokens need a new authorization. Use actual returned expiry, not an assumed 60-day date.
- [Troubleshooting](https://developers.facebook.com/documentation/threads/troubleshooting) chiefly covers publishing and its quotas; it does not establish an exhaustive keyword-search error/subcode table. This design therefore does not invent one. HTTP auth/permission/rate failures are classified conservatively below; an unrecognized Graph error is terminal for that query, never retried or interpreted as success. The [official Graph error guide](https://developers.facebook.com/docs/graph-api/guides/error-handling), also verified, documents the common error envelope and codes: 102/190 authentication, 10 and 200–299 permission, 4/17 throttling, 341 application limit, and 368 policy block. Use these bounded mappings when present; this is a common Graph taxonomy, not a claim that every keyword failure uses these codes. Unknown codes remain api_error and stop further Threads queries.

The endpoint-specific public-search documentation governs this feature, rather than interpreting the overview's older own-post display introduction as public-search authorization. Meta approval for the actual app/use case remains an external release dependency.

## Queries and freshness

Choose a dedicated source-controlled registry in `src/config/threadsSources.ts`:

| Fixed order / queryId | Exact q |
| --- | --- |
| 1 / ai_agents | AI agents |
| 2 / claude_code | Claude Code |
| 3 / codex | Codex |

Three complementary seed queries target agent news and the project's coding-tool priorities. This is a proposed registry approved with this design, not evidence of provider access. Reusing all ten Brave strings wastes calls and carries web-search syntax assumptions; deriving queries from descriptors adds transformation/maintenance logic without a v1 need. No configurable user query strings, Boolean expansion, author lookup, or tag pass.

At collection start freeze `until = floor(nowUTC / 1000)` and `since = until - 259200` (72 hours) once for all queries. Send RECENT/KEYWORD, limit 5, and only `id,text,permalink,timestamp` fields. Validate item timestamps independently against the inclusive [since, until] interval. Reject missing, unparseable or future timestamps. Normalize accepted timestamps to ISO UTC. Overlap absorbs delayed/missed daily runs; existing URL/history dedupe prevents repeated analysis/delivery. Gaps over 72 hours intentionally lose coverage: no backfill or persisted cursor. Wall-clock collection time, rather than an old scheduled timestamp, prevents an accidental historical query after a delayed run.

## Collector and hard bounds

Minimal contract: `collectThreads({ enabled, publicSearchApproved, accessToken, tokenExpiresAt, now, fetchImpl })` returns `{ observations: BatchObservation[], metrics: ThreadsCycleMetrics }`. Production uses native Worker fetch; tests inject fake fetch/time. Config resolution occurs at the Worker boundary; neither tokens nor configuration objects enter Batch candidates. No dependencies or SDK.

| Bound | Value / enforcement |
| --- | --- |
| Requests | At most 3 per cycle, one per registry entry, sequential |
| Results | First 5 array positions/query; at most 15 observations; invalid positions still consume the allowance |
| Timeout | 3,000 ms/request covering dispatch and complete body consumption; check elapsed time after synchronous parse before accepting |
| Collector budget | 9,000 ms total; no next dispatch without remaining budget; each request uses the smaller remaining deadline |
| Success response | 128 KiB decoded body bytes; streaming count, cancel on overflow; Content-Length is an early rejection hint only |
| Error response | 8 KiB; cancel on overflow; never serialize raw errors |
| Pagination/retries | Zero; no redirects; no secondary profile, media, link, permissions or quota fetch |
| Input fields | URL 2,048 UTF-8 bytes; text 8,192; decimal-string id 1–64 characters |
| Output fields | Title 256 UTF-8 bytes, snippet 768; existing shared pool/prompt caps still apply |
| Outcomes | At most three fixed queryId records, bounded integers/enums only |

AbortController and stream cancellation must cover body reads, not just receipt of headers. Reject truncated JSON, a non-object envelope, a Graph `error` envelope even on HTTP 200, or non-array `data`. A valid empty array is a successful empty search. Only inspect first five positions, with null-result observations for invalid positions; never refill them from later positions. Extra positions/paging set truncation flags without additional requests. Full JSON is parsed only inside the body bound. No synchronous CPU deadline is promised beyond the small input bound and elapsed-time acceptance check.

The extra acquisition time is at most nine seconds, not a nine-second increase to analyzer/cycle deadlines. Existing timing/admission gates remain authoritative; Threads can reduce time available for inference or Luna. The later implementation must exercise worst-case source time against those unchanged gates and retain the current 110-second total-cycle target; no budget extension is authorized.

## Normalization, provenance and dedupe

For each valid item, normalize whitespace/control characters as untrusted text; title is the first bounded text, snippet is bounded text, `source = "threads"`, URL is the verified post permalink, and publishedAt is validated ISO UTC. Empty text is rejected (no media OCR/caption request or invented title). Render through the existing escaping/link boundaries; never trust HTML or instructions in a post.

Permalinks must parse as HTTPS without userinfo or non-default port, with exact hostname in `threads.com`, `www.threads.com`, `threads.net`, `www.threads.net`, and a post-shaped `/@<username>/post/<code>` path with no extra path segment. Require nonempty safe username/code segments; reject encoded separators, control characters and homepage/profile URLs. Apply the existing canonical URL/alias helper rather than inventing another generic normalizer. Preserve original valid aliases for history checks. Do not dereference links, expand shorteners, fetch media, extract outbound articles as substitute sources, or rewrite `.net` URLs to `.com` without evidence: cross-host event equivalence is deferred. Thus exact normalized URL/alias duplicates across Brave/RSS/Threads merge; different permalink domains are not falsely promised to dedupe as the same event.

Extend DiscoveryProvenance with `{ kind: "threads", queryId, postId, resultOrdinal }`; queryId is the fixed registry enum, postId the bounded decimal string, ordinal 1–5. Only a null-result invalid observation may use postId=null; it still consumes its query/position and can never become a candidate. No username or body is required. Validate provenance before aggregation; duplicate query/position cannot create extra capacity. Preserve all valid provenance on a merged candidate and all observed aliases, including those outside the retained raw pool. History and notification checks/touches remain before inference. IDs are candidate evidence only: telemetry uses queryId/ordinal/counts, not raw postId or author data.

## Fairness at both bounded stages

Ownership for scheduling a deduplicated candidate is Brave if any Brave provenance, otherwise RSS if any RSS provenance, otherwise Threads. This single ownership prevents double slot consumption; all provenance remains available for source-attribution counts. Healthy but empty/duplicate-only sources have no unique candidate representation to guarantee.

1. Raw pool: extend current Brave/RSS interleaving to round-robin Brave, RSS, Threads among nonempty owned queues before the unchanged 50-candidate bound. Within Threads rotate query queues in registry order, preserving result order. Borrow absent/exhausted lanes. No candidate appears twice. Retain current behavior exactly when Threads has no owned candidates.
2. Analyzer subset: when Threads has candidates, repeat `[brave, rss, brave, threads]` up to 24. With sufficient candidates this gives 12/6/6. For an empty requested lane, borrow in fixed Brave → RSS → Threads order, skipping empties. Keep existing Brave query/RSS feed rotation; Threads rotates its three queries. Preserve the current 3:1 Brave/RSS pattern when Threads has no owned candidates.
3. Hostname diversity remains a preference, not a hard cap. First seek a candidate below the existing soft hostname limit in the requested lane; if none, relax that preference in that same lane before borrowing. All Threads posts share a host, so a global hard cap of two would defeat its representation. Do not change relevance scores to enforce source quotas.
4. Keep source slots early: the first four candidates represent all three eligible lanes. Existing bounded UTF-8 compaction and tail removal remain authoritative. Test adversarial maximum-size candidates to ensure at least one from each nonempty lane survives the existing minimum prompt representation; if the unchanged prompt format cannot guarantee that, report a scope conflict before implementation rather than raising caps or silently promising representation.

All retained candidates, not only the submitted subset, remain available to existing deterministic raw fallback. Its existing ranking, replay, notification history, max four stories and single email attempt are unchanged. Threads content gains no trusted-source status automatically. No P4 trust-registry expansion, source-specific scoring, separate raw digest, invented analysis, or LLM HTML. Source-independent Batch relevance/labels remain authoritative.

## Configuration, public access and token operations

Manual long-lived token management is the smallest option for three daily reads. Automatic refresh would add credential writes, app-secret exposure, scheduling and failure state without improving discovery logic; defer it.

- Secret: `THREADS_ACCESS_TOKEN`, only a Cloudflare secret. Never source code, vars, D1, URLs in logs or thrown diagnostics.
- Non-secret: `THREADS_DISCOVERY_ENABLED` defaults false; only explicit true enables. `THREADS_PUBLIC_SEARCH_APPROVED` defaults false and represents a recorded operator attestation for this app/use case. `THREADS_TOKEN_EXPIRES_AT` is the actual ISO UTC expiry returned during operator token provisioning. All three must validate before a request; limits remain constants.
- Required external evidence before setting public approval: Meta app identity, approved public keyword-search access, granted scopes on the actual token/app, permitted news-discovery use case, and confirmation that it is not own-account-only access. Store only non-secret approval evidence in the release record. No runtime switch may infer this from results or fall back to account-only mode.
- Use the documented user-token request authentication, confined to the fixed HTTPS endpoint. If using its documented access_token query parameter, construct it only at dispatch and never log the request URL/Request/error object; redact before all diagnostics. No redirect may forward credentials. Use the documented query-token form in v1; a bearer-header alternative is not required for implementation and must not be guessed.
- Expiry metadata absent/invalid/expired means unavailable, zero requests. Seven days before expiry emit bounded `rotationDue=true`; continue until actual expiry if otherwise authorized. Revocation can occur sooner and must fail isolated. Never claim local expiry metadata proves authentication.
- Operator rotation: disable Threads; verify current app approval and scopes, obtain/refresh a token through the authorized server-side flow, update secret plus actual expiry metadata, record non-secret evidence, then explicitly re-enable. No app secret in the Worker and no automatic refresh call. If expired, reauthorize. A failed rotation leaves Threads disabled and Brave/RSS operational.

Attestation is not an online proof. Meta can silently change access to own-post-only without an explicit error; the documented keyword response does not provide a reliable public-access assertion. Do not claim automatic detection. Operator approval/revocation monitoring and disabling on lost/uncertain approval is a production prerequisite; if the human requires cryptographic/runtime proof of public scope on every request, this minimal no-extra-call design is insufficient and requires an explicit amendment.

## Failure isolation and health

Disabled → `disabled`, no call. Enabled but missing token/expiry/approval → `unavailable` with `configuration`, `expired` or `public_permission_unapproved`, no call. HTTP 401 → `auth`; 403 → `permission_or_policy`; 429 → `rate_limit`; redirects → `redirect`; other non-2xx → `http`; network error → `transport`; abort → `timeout`; overflow → `body_limit`; invalid JSON/envelope → `malformed`; valid Graph error not otherwise proven → `api_error`. For a bounded valid Graph error envelope, map 102/190 to auth, 10 or 200–299 to permission_or_policy, 4/17/341 to rate_limit, and 368 to permission_or_policy, including HTTP 400 or 200 envelopes. Known error-code evidence takes precedence over generic HTTP class; otherwise use the HTTP classes above. Do not classify by message substrings or assume OAuthException alone identifies the cause. Numeric code/subcode can remain internal; no raw error text or secrets.

Auth, permission, rate-limit, or an unclassified Graph error stops remaining Threads queries for this cycle; no speculative retry. Other per-query failures may proceed to the next fixed query within the collector budget. Preserve earlier valid candidates on partial failure. A top-level collector exception becomes bounded unavailable evidence without aborting Brave/RSS. Query success with rejected items remains success with rejection counters; schema failure is not empty success.

All three scheduled queries successful → healthy, including empty results. At least one successful query plus failed/skipped query → degraded. No successful query → unavailable. Authenticated evidence is `unknown` before any successful authenticated response, `accepted` after one, or `rejected` on explicit auth rejection; accepted never asserts public approval. Permission/rate telemetry uses observed evidence, not guessed causes for generic API errors.

Combined discovery outage means no enabled source completed a valid discovery response. A valid empty response is available, not an outage. Disabled Threads does not count as success or failure; missing configuration for enabled Threads counts unavailable. Quota-blocked Brave with no successful Brave query supplies no available source. Use one shared calculation for monitor, Worker summaries and persisted telemetry, replacing current duplicated two-source checks; do not let each layer reinterpret outage. Outage describes acquisition, not whether replay/raw candidates permit content delivery. The current finalizer decides content/status, always at most one email attempt. No source failure clears analyzer accounting latches or bypasses existing preflight.

## Telemetry and persistence

Add an optional bounded Threads telemetry extension following the existing optional-extension approach; do not change core telemetry schema/version or D1 tables. Existing rows without it remain readable. Readers on an older release may reject an extended row: require compatible-reader rollback review before release, not a schema migration as a shortcut.

Validate aggregate observation positions against 90 (50 Brave + maximum 25 RSS + 15 Threads; the current four-feed registry yields at most 85). Keep retained/submitted limits 50/24. Update source-aware sanitizer position limits deliberately rather than truncating Threads behind the old two-source limit; selected telemetry can use the bounded query/ordinal projection without post IDs.

Record enabled/configured/publicApprovalAttested, health, authentication evidence, rotationDue, attempted/succeeded/failed/skipped queries, observed positions <=15, valid observations <=15, rejected positions <=15, duplicate observations <=15, retained unique Threads-owned candidates <=15, and separate counts of candidates carrying Threads provenance. Record submitted/selected/delivered attribution from existing pipeline checkpoints; selected/delivered counts refer to the single combined digest and are not independent sends. Delivered means the existing provider-accepted/history semantics, not proof of inbox receipt.

At most three outcomes: fixed queryId, status enum, HTTP status or null, elapsedMs bounded to 9,000, observedPositions <=5, item/paging/body truncation flags. Received means examined positions, not total matching public posts; explicitly name it `observedPositions`. No unbounded total-result claim. `duplicates` means valid observations merged into an existing alias group, not rejected items. Sum-attribution may exceed unique total because a candidate can have several provenances; ownership counts must not.

No raw URLs, token, full post bodies, usernames, provider error text, prompts or arbitrary labels in telemetry. Extend strict Worker sanitizer/allowlists, monitoringTelemetry validator and provenance summaries together. Bound the optional extension to 1,536 UTF-8 bytes and the complete serialized cycle snapshot to the existing 8,192-byte limit; worst-case three-query plus maximum analyzer evidence fixture must fit. Preserve existing mandatory checkpoint failure behavior; do not implement the deferred telemetry-degraded continuity feature. Optional console-summary failure must not abort content processing.

No D1 migration: existing discovery/history and bounded JSON cycle payloads suffice. Do not use an X inbox, query cursor, new source ledger, or migration 0004. No cross-cycle API quota guarantee is claimed beyond the existing daily scheduler and three-request per-cycle cap; duplicate platform invocation protections remain unchanged.

## Expected future file scope

Runtime additions: `src/config/threadsSources.ts`, `src/services/threadsDiscovery.ts`.

Targeted edits: `src/types/index.ts` (provenance/metrics), `src/services/monitor.ts` (one collector/shared pool/outage/attribution), `src/services/batchCandidates.ts` (validation/three-source pool), `src/services/batchCandidateSelection.ts` (three-source selection), `src/worker.ts` (native fetch/config injection/sanitizers), `src/services/monitoringTelemetry.ts` (bounded optional extension), `wrangler.jsonc` (disabled defaults only, no secret). `README.md` for manual setup/rotation and release gate. Generated Worker binding types only if the existing build requires them. No changes expected to batchPrompt, renderer, analyzer adapters, storage schema, Brave or RSS acquisition, or existing discovery queries. If those require behavioral changes, seek a bounded amendment.

Tests: new `test/threadsDiscovery.test.ts`; targeted `test/batchCandidates.test.ts`, `test/batchCandidateSelection.test.ts`, `test/batchPrompt.test.ts`, `test/batchMonitoring.test.ts`, `test/batchAnalyzerFailover.test.ts`, `test/workerConfiguration.test.ts`, `test/monitoringTelemetry.test.ts`; new local `test/workerd/threadsDiscovery.worker.ts`, `test/workerd/threadsDiscovery.test.mjs`, `test/workerd/threadsDiscovery.wrangler.jsonc`, and an offline package script if needed. No tests are created by this design task.

## Acceptance and verification strategy

- Disabled/missing token/missing or false public approval/invalid expiry: zero fetches; safe metrics. Rotation warning, expired/revoked token, changed approval and invalid flags fail correctly.
- Exact fixed endpoint, parameters, fields, request order and frozen window; RECENT first-page behavior. Valid empty response succeeds. Timestamp boundaries, future/old/missing dates, invalid IDs/permalinks/userinfo/ports/encoded separators and empty/oversized text are deterministic.
- HTTP, auth, permission, rate, Graph-error-on-200, malformed body, transport, redirects, oversized declared and streamed bodies, stalled headers/body, reader cancellation, partial failures and collector exceptions. No retry, paging, redirect, secondary fetch or late dispatch; <=3 requests, <=5 positions/query, <=15 observations even with invalid positions and duplicate responses.
- Canonical same-URL overlap across all sources merges once, preserves provenance/aliases, and consults history/notifications before inference. Known URLs touch history without analysis. Source URLs remain untrusted and renderer escaping holds. Separate `.com`/`.net` URLs are not silently claimed equivalent.
- Saturated pool and prompt-byte bounds, each absent source, duplicate-only source, query rotation, ties, adversarial long URLs/text, shared Threads hostname, 12/6/6 and borrowing, no-Threads regression parity. <=50 retained; <=24 submitted /12,288 bytes; early source representation survives compaction. Full retained pool still supports degraded fallback.
- Exactly one PreparedBatch; unchanged Gemini attempts and Luna admission matrix; no source-specific inference or fifth story; normal threshold/labels and notification/replay rules unchanged; one email attempt for all success/degraded/status combinations. Threads raw content can enter the existing deterministic degraded selection without invented scores or HTML.
- Health/outage table across enabled/disabled/failed/empty/quota-blocked sources agrees at every telemetry layer. No claim of successful public access solely from HTTP 200. Auth status and unknown failures stay truthful.
- Worst-case telemetry size/redaction/old-row reading/compatible rollback readers; no credentials in serialized errors, fetch URL logs, provenance or summaries. Thread counts reflect dedupe and finalization stages, not assumed delivery.
- Local Workerd test with network confined to fixture service bindings: native bound fetch, streamed overflow/cancel, body abort, redirect denial, disabled secret wiring and combined-source continuation. Existing local D1 checkpoint fixtures can exercise optional JSON telemetry without schema changes; no remote D1/provider access.
- Later Builder full offline suite, TypeScript build/Worker typecheck, local Workerd gate, Wrangler dry-run bundle inspection, diff/secret/scope checks. Inspect scripts first. No live test commands. This document claims no test execution.

## Release gates and dependencies

1. Human approves this design; then a separate small TDD implementation plan and offline Builder work may be authorized. No runtime implementation is authorized by this commit alone.
2. One independent final Analyst review of the exact implementation/evidence; Architect disposition and human release decision.
3. Separately authorized push/PR/CI/merge. Preserve compatible telemetry-reader rollback target; design commit itself stays local now.
4. External Meta app/use-case and public keyword-search approval, granted scopes, permitted usage review, manually managed long-lived token and known expiry; separately authorized Cloudflare secret/config provisioning. No proof or credentials assumed present. App-review denial blocks enablement, not Brave/RSS release continuity.
5. Separately authorized undeployed Worker version: verify exact source/bindings, disabled/default-safe behavior and reviewed limits. This is not deployment approval.
6. Explicit production deployment approval; no migration. Enable only with recorded public-search evidence and valid credentials. Disable Threads to recover from source problems; do not revive X or alter Cron.
7. Natural scheduled Brave + RSS + Threads proof: verify exact Worker, query/outcome/health evidence, caps, candidate provenance/submission, unchanged analyzer admission, finalizer and one email. Empty valid results demonstrate availability, not useful Threads contribution; wait for natural nonempty candidates to claim contribution. Do not force provider failures or manual monitoring to manufacture evidence. Record observed outcome without claiming Luna-path proof unless naturally exercised.

Open external dependencies: human design approval; Meta public-search/use-case approval and token/scopes; operator rotation ownership; later release permissions and natural evidence. No external setup was performed. No unresolved internal architectural choice is delegated to Builder; unsupported external assumptions must block enablement or return for amendment.

## Non-goals and design checkpoint

No scraping, Threads-site automation, unofficial API, author crawling, media analysis, X revival, migration 0004, database migration, automatic token refresh, persistent cursor, generic source framework, cross-source semantic event dedupe, Compact Analyzer Contract, email/token optimization, new retry, quota increase, manual monitoring endpoint or deployment. Existing security/accounting/notification boundaries remain authoritative.

This checkpoint changes only this spec and minimal backlog/plan status. Protected untracked `docs/superpowers/specs/2026-10-12-batch-gemini-daily-radar-design.md` must remain untouched and excluded; expected SHA-256 `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`. No implementation plan is created. Design approval is still pending.
