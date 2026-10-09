# Architect Plan

## Gemini hotfix integration into P6 main — 2026-10-09

This integration branch converges the accepted P6 source lineage at `313a21319f0252e29651a477d3e9584512696692` with the accepted and already deployed Gemini hotfix at `366d7ea6370e6297818ec7ae9489a78b99edd3e8`. Both migrations remain source-controlled under their approved names: `0004_x_discovery.sql` and `0005_gemini_ambiguity_accounting.sql`.

Verified production remains on Worker version `6ad65e76-9728-4a2d-aece-15903028ad01`, sourced from the Gemini hotfix. Production has applied `0001`, `0002`, `0003`, and `0005`; `0004` is not applied, P6/X is not deployed or enabled, `usage_unknown=1`, and row 17 remains preserved as `legacy`. Gemini recovery remains forbidden before `2026-11-01T00:00:00Z` and still requires fresh state verification plus separate human authorization. Before recovery, old P5 is only a blocked-safe emergency fallback while the latch remains `1`; after recovery, P5 is not an allowed rollback target, and the deployed hotfix or a later compatible version is the minimum rollback target.

## P6 — X.com Source Integration: architecture revision 1

Status: HUMAN-APPROVED for source implementation and REVIEW. The exact five-account identity registry was approved by the human on 2026-10-08. Production activation, migration application, credentials, paid credits, configuration and deployment remain unauthorized. Date of documentation research: 2026-10-07.

### Baseline and current integration points

Local HEAD and cached origin/main both equal `01ef0787cad02c49d453f781e1b106a247b7e5d7`, initially clean. The human reports P5 deployed at this SHA, Worker version `7e38341d-71a1-4a3e-ad8a-e73d39811514`, 100% traffic; this task did not independently query Cloudflare. Historical Builder summaries still say REVIEW; preserve them as historical handoffs and attach later closure evidence without inventing Analyst results.

The inspected pipeline loads replay, checks Gemini availability, runs the ten P5 descriptors with pw, normalizes/deduplicates, applies selectPreAnalysisCandidates, analyzes at most four, stores completed analysis, and invokes one merged digest. P3 reserves up to two preferred opportunities; P5 reserves one non-P3 official opportunity. D1 currently requires stored normalized_url to equal normalized analysis.sourceUrl. Preserve that identity relation rather than introducing a parallel notification key or alias graph.

### Current X products: verified facts and boundaries

- [Pricing](https://docs.x.com/x-api/getting-started/pricing): public documentation now describes prepaid pay-per-use, no subscription/minimum spend, Post reads $0.005/resource, User reads $0.010/resource, and a 3-million-Post monthly ceiling. Repeated-read billing dedup is only a soft, within-UTC-day guarantee. Console spending limits are available; balances may go slightly negative. Rates can change. Do not budget using legacy Free/Basic/Pro subscription prices or owned-read discounts for other publishers' posts.
- [Recent search](https://docs.x.com/x-api/posts/search/introduction): `/2/tweets/search/recent` covers seven days and supports from/keyword filters; documented as available to all developers. Access does not mean zero-cost reads.
- [Account timeline](https://docs.x.com/x-api/users/get-posts): `/2/users/{id}/tweets` supports bounded max_results (5–100), time bounds, since_id and excluding replies/retweets. Use the current documented field-parameter spelling from this endpoint (`post.fields` at inspection); do not silently fall back to older parameter names with extra calls. Builder must lock the request contract to reviewed documentation/fixtures.
- [Rate limits](https://docs.x.com/x-api/fundamentals/rate-limits): published app-only timeline ceiling 10,000/15 minutes, recent search 450/15 minutes (user-context limits differ). These are provider ceilings, not application targets. Console entitlement and response rate headers can be more restrictive.
- [Access](https://docs.x.com/x-api/getting-started/getting-access) and [app-only authentication](https://docs.x.com/fundamentals/authentication/oauth-2-0/bearer-tokens): developer account and registered App, app-only Bearer Token for public reads. Provision the Project/App arrangement required by the current console; no end-user OAuth flow is needed. Account-specific availability, billing and terms acceptance have NOT been verified here.

Comparison: A) selected-account timelines give deterministic immutable-author coverage, independent per-account limits and manageable noise; recommended. B) bounded recent search can combine authors into fewer HTTP requests, but charges still depend on returned posts, busy accounts compete for results, and handle-based filters need maintenance. Unrestricted keywords introduce unnecessary noise. C) hybrid adds costs/duplicate observations and another allocation policy without a demonstrated benefit; defer. D) no X API means retain P5 at $0 incremental X cost. Official publisher feeds could be a separate future design; no scraping/login-cookie automation, unofficial mirror dependency or extra Brave queries. Preserve the approved P5 allocation rather than quietly replacing it with site:x.com searches.

Streams/webhooks are unnecessary for once-daily discovery: they require persistent delivery/subscriptions or an inbound endpoint, conflict with the health-only HTTP design, and make cost bounds harder. No streaming, full archive, user lookup, media, engagement, count or search endpoint in recommended v1.

### Recommendation, account registry and approval

Recommend a bounded, opt-in five-account pilot using one timeline request/account/day, ten returned posts/request, no pagination/retries. It is affordable at current published rates, but incremental value is uncertain with only four total analyses. Proceed only if the human approves a small paid discovery experiment; otherwise defer P6 and keep P5 unchanged.

Proposed source-controlled `src/config/xSources.ts`: `{version, enabledPolicy, accounts: [{userId, approvedHandle, label, category}], pricing: {verifiedAt, expiresAt, postReadMicroUsd}, limits}`. Maximum five entries initially: one human-selected official OpenAI account, one Anthropic account, one Google AI/DeepMind account, one GitHub account and one Microsoft developer/AI account. These are categories, NOT an approved list of handles/IDs. HUMAN_APPROVAL_REQUIRED: provide exact verified decimal user IDs, current handles, public-official identity evidence, fixed order and approval date before Builder populates the registry. No invented IDs, auto-following, badges-as-trust or arbitrary maintainer additions. Additional accounts replace an approved slot only through review; they do not increase limits implicitly.

Identity is decimal user ID, never handle. Keep IDs as validated strings/BigInt comparisons, never JS Number. Poll by ID; a renamed handle does not transfer trust to a replacement account using the old handle. No runtime user expansion/lookup to refresh display names. Use the human-approved publisher label and mark stored handle as an approval-time label, not verified current identity. Human reviews renames/ownership concerns and can disable entries. Discovery permission is neither truth assurance nor P4 publisher trust.

### Acquisition, freshness, cursor and backlog

After successful Gemini preflight, run the unchanged Brave loop FIRST. Preserve actual all-Brave-failed rejection and do not spend X credits on a cycle that will reject there. If Brave succeeds, returns legitimate empty results, or stops through its existing quota-denial path, poll X sequentially in approved account order if enabled/healthy. Finish all bounded acquisition before selection. No extra calls when Gemini preflight blocks; pending X candidates also remain unanalysed in that replay-only cycle.

Request: GET fixed `https://api.x.com/2/users/{approvedId}/tweets`, `max_results=10`, `exclude=replies,retweets`, `start_time=T-7 days`, `end_time=T` using API-supported UTC precision/boundaries, plus persisted since_id when present. Request only id, author_id, created_at, text, entities, referenced_tweets and edit-history IDs; no expansions, profiles, metrics or media. Validate returned dates locally within the same seven-day bound and author against the requested ID. Preserve the literal request contract in offline tests. One page/account, never follow next_token.

On a structurally valid page, atomically persist normalized usable posts into a small pending inbox and advance that account's high-water ID to the highest safely validated returned ID (BigInt ordering). Persist before cursor advance so selected-out posts are not lost solely because four analysis slots were occupied. Valid filtered replies/reposts/quotes can advance the cursor; a malformed identity/page prevents cursor advancement. A next_token sets truncation=true; choosing the latest ten and advancing explicitly drops older unseen overflow rather than attempting unbounded backfill. No completeness claim. Empty pages retain since_id. API/malformed-page/storage failure never advances it. Missing since_id uses only the seven-day start bound.

Pending payload expiry is createdAt + seven days, not fetch time; retain at most 350 pending post payloads (5*10*7), evict oldest deterministically by createdAt then ID, report truncation. Old pending posts may be retried for normal analysis on a later cycle, still subject to the four-analysis/provider ceilings. No immediate additional analysis on failure. After successful ordinary discovery persistence, discard raw post payload, retain compact post-ID -> story-URL metadata for identity/restart safety. No analyzed-post payload cache or social profile database. Inbox failure disables X inputs this cycle; Brave remains usable. Ordinary discoveries and notification-history failures retain their existing authoritative failure semantics.

### Normalization, deterministic filtering and identity

Normalize ephemeral XPost `{id, authorId, approvedLabel, approvedHandle, createdAt, text, canonicalPostUrl, outboundUrl?, referencedIds, editIds}`. Validate decimal nonzero IDs against documented length, timestamps, object shapes, expected author and bounded text/URL counts. Canonical X URL is `https://x.com/i/web/status/{id}` so handles are not identity. Map x.com/twitter.com /<handle>/status/<id> and /i/web/status/<id> to the same ID for X candidate matching; never rewrite all other web URLs. For edit-history IDs, treat the first validated history ID as the post identity when available, map variants in the inbox, and freeze the first chosen story key. No reanalysis simply because text/handle changed.

V1 admits original public text posts only. Drop replies (including thread continuations), reposts, quotes, withheld/sensitive/unusable content and media-only/empty text. Defensively inspect referenced_tweets even when API excludes replies/reposts. Quote posts are excluded rather than recursively fetching or incorrectly treating the quoted author as approved. Threads contribute only an original root; no conversation fetch. This sacrifices some unique announcements to keep the first version bounded and avoid duplicate amplification.

Use exactly ONE distinct safe external link from supplied URL entities as the story identity when present. Prefer supplied fully expanded destination if valid; otherwise expanded_url. Do not resolve t.co/other shorteners over the network. Reject posts whose only link remains unresolved or whose multiple distinct external destinations make story identity ambiguous; do not create one analysis per link. Media/internal X links are not external article identities. No URL from text regexes, model output or display_url overrides structured entities.

Safe external URLs: absolute HTTP(S), no credentials, IP literals/private/loopback/single-label hosts, non-default ports, control characters or excessive length (2,048 characters). Parse/validate without DNS/fetch, then use EXISTING normalizeDiscoveryUrl for key equality; no fuzzy dedup or global removal of query parameters. A trusted-looking hostname in username/path/query is not trust. Short-link/UTM/cross-domain variants without exact canonical evidence may remain distinct; disclose this rather than claim semantic deduplication.

### Brave/X deduplication, provenance and P4 boundary

For a linked X-only candidate, SearchResult.url is the normalized external article URL; for an unlinked post, it is the canonical X URL. Thus the existing discovery and notification tables remain keyed by analysis.sourceUrl, and two accounts linking the same URL or a later Brave article hit the SAME durable key. Keep the immutable post-ID -> story URL mapping in X inbox metadata. Before merging, exclude known stored story keys using current history. Merge Brave first; its result/prompt and P5 official signal win exact URL collisions. X-only collisions use approved-account order then createdAt descending and post ID ascending. Never mix extra X text into a retained Brave result or give X a P5 official flag.

Cross-cycle success under an article key suppresses later analysis/delivery of that key regardless of acquisition source. An X-only observation is not evidence that the linked article was fetched: the prompt explicitly says it contains an X announcement linking to the URL, not article contents. sourceTitle identifies `X announcement — {approved label}`; the snippet contains bounded post text and labelled source metadata, all untrusted reference material. Preserve prompt-injection protections, normal Gemini relevance and original URL/title checks. No fabricated article title or content.

Before merging a Brave result whose URL is itself an X status URL, consult the bounded post-ID mapping from loaded inbox metadata/point lookup. If known, coalesce with that post's frozen story key and retain X provenance (a Brave search result pointing at X is not an independently observed article). If unknown, canonicalize only its post ID URL and do not invent an external article relation. If X metadata is unavailable, omit X-status observations from the P6 merge rather than guessing aliases; unrelated Brave articles remain fully usable. Different URLs with no observed linking evidence cannot be guaranteed duplicate-free. No change to general Brave article normalization is authorized.

Add optional application-owned `sourceProvenance: {kind: "x", postId, authorId, postUrl, label}` to stored analysis metadata, NOT fields requested from Gemini. Copy it from the validated adapter after analysis validation; a Gemini-returned provenance field must be ignored/rejected. Update copy/validation paths so JSON/D1 round trips and replay preserve it. Missing metadata on legacy non-X rows retains legacy behavior; malformed X metadata fails closed. Existing analysis_json can hold it, with no discoveries column change.

CRITICAL: an X-derived analysis is ineligible for P4 fallback EVEN when sourceUrl points at a P4-approved article hostname. In notifyDeliveryDigest's fallback filter, require existing source trust AND no X provenance. This preserves all pre-existing P4 behavior and prevents the new ingestion path from extending it through links. X-only normal relevance >=7 remains eligible. Do not add x.com/twitter.com or account handles to P4 registry. Provenance must survive replay and cannot be removed when a later duplicate Brave URL is touched. Independent Analyst must test this explicitly.

Email uses the same digest and send/history path. For linked observations, primary link is the article identity, visibly labelled as an announcement reported on X; include a secondary canonical post link and approved publisher label. For no-link posts, the canonical X URL is primary. Escape labels/text and validate links identically in HTML/plain text. No follower/engagement metrics. Delivery is still one email and at most four stories; sending provider acceptance is not guaranteed inbox delivery.

### Four-slot policy: no new reserved lane

Brave candidates retain P5 ordering and provenance. Append pending/new X candidates after Brave, with stable registry-order/date/ID ordering. Run the existing selectPreAnalysisCandidates once over the unified unseen pool: up to two P3 preferred, one P5 official NON-P3 observed through a matching Brave descriptor, then normal remaining non-preferred, then remaining preferred. X gets NO additional reserved slot and cannot acquire P5 priority from its account registry. X Codex/Claude Code content uses the existing P3 detector and can compete there; normal X can fill space when Brave has fewer candidates. This is the minimal policy preserving P3/P5 and max four. X starvation in a full Brave pool is an explicit pilot risk; a new fair-share lane requires separate approval, not an implicit fourth reservation.

### Hard X admission and cost bounds

Proposed app limits: 5 requests/cycle, 5/day UTC, 35/ISO week UTC, 155/calendar month UTC; 10 resources/request; conservatively charge local budget for 10 possible Post reads per dispatched request even on empty/error responses (never refund). Monthly reserved resource cap 1,550; local approved-price ceiling 8,000,000 microUSD ($8). Freeze per-cycle allowance so midnight cannot replenish it. Before every call, atomically reserve the request and ten-resource worst-case charge in existing D1 under X-specific state. Count failures/timeouts and crashes after reservation conservatively; no retries, no pagination or hidden user lookups. Conditional atomic admission must prevent overlapping executions from exceeding caps.

Only GET account timelines is allowed; no resource expansions avoids unbudgeted user/post reads. A missing/unreadable guard, unapproved account/price, expired price approval, missing token or inconsistent response fails closed for X, not Brave. A page over ten posts/unrequested billable expansions indicates contract drift: stop X and require reconciliation, do not assume application truncation reverses charges. Timeouts are capped at 10 seconds including body read; response body max 256 KiB, post text max 8,000 characters; no automatic HTTP redirects or SDK retries. Bound once-daily polling to five accounts even when some fail.

Activation requires human-confirmed Console endpoint access, current price, an $8/billing-cycle provider spending limit, auto-recharge OFF and dedicated app/credit use without unrelated workloads. App-local guard is NOT a guarantee against an unannounced provider price increase; the provider-side spending cap is essential. Registry price approval expires after at most 31 days and disables further X calls until reapproved. Never infer a new price/raise budgets automatically; low credits just disable X. No API calls merely to check billing. Account-level cap/credits may have small provider overshoot; do not advertise mathematically exact zero overrun beyond the documented provider contract.

### Minimal persistence change and rollback

Migration required: proposed `migrations/0004_x_discovery.sql`, additive X-only tables in existing D1, no new binding:

- `x_poll_state(author_id TEXT PRIMARY KEY, since_id TEXT NULL, last_success_at TEXT NULL, disabled_reason TEXT NULL)`: immutable author cursors and bounded auth/account holds.
- `x_inbox(post_id TEXT PRIMARY KEY, author_id TEXT NOT NULL, story_url TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NULL, state TEXT NOT NULL, edit_ids_json TEXT NOT NULL)`: normalized bounded payload while pending; compact key/identity after successful analysis or terminal filtering. State enum pending/processed/filtered/expired. Unique post identity, pending-date index; no counts/social profile fields.
- `x_request_usage(id INTEGER PRIMARY KEY, reserved_at TEXT NOT NULL, author_id TEXT NOT NULL, reserved_posts INTEGER NOT NULL CHECK(reserved_posts=10), reserved_micro_usd INTEGER NOT NULL, outcome TEXT NOT NULL)`: durable reservations count all attempts; atomic sum/check/insert across current day/week/month. Outcome reserved/success/error/unknown is diagnostic only and never refunds budget. Invalid/missing table blocks X.

Cursor/page insertion is transactional and only follows durable request admission; network execution is outside DB transactions. A failure after request reservation consumes that allowance; a failure before cursor commit can refetch next day within the caps. Before analysis, durable story lookup resolves inbox rows already stored after a crash; do not reanalyze. Retain only compact dedup metadata after expiry; cap queried pending candidates at 350 and clean expired payloads locally during the next authorized cycle, never through a new Cron. No change to existing discovery firstSeenAt, 72-hour replay or notification schema. SourceProvenance is optional JSON metadata with strict validation/copying.

Add Worker-neutral XStore interface with D1 and local JSON implementations; local JSON remains outside the Worker bundle and uses exclusive/atomic writes for parity. Do not force X tables/credentials to exist when X is disabled. Rollback: disable X first, retain additive tables and usage evidence; deploy a P6-aware disabled build so X provenance still prevents P4 fallback for stored/replay rows. Rolling all the way back to pre-P6 code can lose that provenance gate and is NOT safe without a separate reviewed data/replay containment plan. No destructive rollback/drop or automatic ledger/cursor reset.

### Failure isolation and bounded observability

Auth/permission failure: stop X for the cycle and hold it for human correction. 429/budget/credit exhaustion: stop further X calls without sleeping/retry; respect the later provider reset on subsequent cycles, still within app caps. Removed/suspended account: hold that ID; do not look up/reassign the old handle. Per-account timeout/5xx/malformed page: bounded error, no cursor advancement; other accounts can continue within caps. One bad post is filtered without corrupting valid siblings if their envelope identities are valid. Full X outage, missing X schema, local-state read/write failure or registry failure leaves Brave selection/delivery intact; no X candidates are admitted from unverifiable state. Never downgrade an ordinary discovery/notification-history failure to an X-only warning.

Persist auth/permission hold as an app-wide interpretation of the recorded disabled reason: any unresolved auth hold disables all X account polling until separately approved repair. A suspended-account hold remains account-specific. Do not reinterpret an unknown 403 as merely a suspended account and continue probing other accounts. No automatic credential rotation or reset.

Add only bounded aggregate summary fields: xRequestsAttempted, xPostsReceived, xCandidatesAdmitted, xDuplicates, xAccountsFailed, xTruncated, and optional xBlockedReason enum (disabled/config/auth/rate_limit/budget/state_unavailable/price_expired/contract_drift). At most five account-ordinal failure records with enum reason; no handles, post text, URLs, raw provider error, bearer token or billing data in logs. Append token to existing redaction list. X failures need not fabricate Brave searchFailures or per-story analysis failures. Gemini preflight block takes precedence and yields zero X activity, including inbox fresh-analysis work; ordinary replay remains available.

### Costs and human go/no-go

At the reviewed $0.005/Post rate: maximum 5*10*31 = 1,550 returned posts/month -> $7.75; 155 HTTP requests. For a planning scenario of 1–5 new posts/account/day, 155–775 resources -> $0.775–$3.875/month. These are arithmetic scenarios, not measured posting rates; filtering after retrieval does not save billed reads. A 30-day maximum is $7.50. No charged user expansions/lookups, no owned-read discount or repeat-read billing credit assumed. Add any applicable taxes; console price/access must be rechecked before activation. Local reservations deliberately consume the worst-case budget even when actual cost is lower.

Cheapest documented workable offering is pay-per-use, not a legacy Basic subscription. No subscription purchase is proposed, but enabling paid credits is still a separate human financial decision. Do not enable promotional auto-recharge just to obtain credits. Polling is more predictable per author than search, not inherently cheaper per returned post; grouped search can use fewer requests but can obscure quieter authors. Recommend the <=$8 opt-in pilot only if the human values X-first announcements enough to justify the code/data-security scope. For a strict $0 additional-provider policy, recommend no X API integration now; retain P5. Do not substitute scraping.

### Exact Builder scope after approval

New files: `src/config/xSources.ts`; `src/tools/x/readAccountPosts.ts`; `src/services/xDiscovery.ts` (normalization/filtering/poll orchestration); `src/services/xUsageGuard.ts`; `src/services/xStore.ts`, `d1XStore.ts`, `localJsonXStore.ts`; the single additive migration. Keep interfaces small and Worker-safe, no SDK/dependency added.

Existing files: `src/services/monitor.ts` and `src/worker.ts` for gated collection/shared selection/summary; `src/services/radarRuntimeConfiguration.ts` for optional disabled-by-default X readiness; `src/types/index.ts`, `src/services/discoveryProcessor.ts`, `analysisAgent.ts` and discovery history core/JSON/D1 copy/validation paths for application-owned provenance; `notificationOrchestrator.ts` for X-only P4 exclusion; `discoveryEmailFormatter.ts` for explicit X attribution. Do not change Gemini prompt schema except the labelled untrusted X source envelope, model/retry logic, P5 query config or quota values. Add small normalizer helpers only if needed; no global URL identity rewrite.

Docs after approval: README, PROJECT_STATE runbook/limits/source-provenance/rollback, role-owned plan/summary/changelog and independent Analyst review. AGENTS provider invariants need explicit human-approved addition of X limits and discovery-only account policy. No P7 implementation. Production activation will require one new Worker secret `X_BEARER_TOKEN`, one optional nonsecret `X_DISCOVERY_ENABLED` flag (default false), the additive migration, registered X developer App and prepaid credit/console limit setup. No new Cloudflare binding, resource, public route or Cron. This architecture authorizes NONE of those production actions.

### Exact offline acceptance tests

1. Registry max five, exact approved IDs, duplicate/invalid ID rejection, fixed order and expiry; empty/unapproved/disabled configuration makes zero calls. Same ID with renamed handle retains identity; old handle reassignment does not confer access.
2. Exact GET timeline path/params/fields/exclusions, seven-day boundary, since_id, max_results ten, no expansions/pagination/retries/redirects; response/body/time limits. Only injected fake fetch is used.
3. Caps 5/cycle, 5/day, 35/week, 155/month, 1,550 reserved reads/$8: concurrent reservation race, boundary rollover, restart, empty responses, timeout/error and failed writes all fail safely without refunds. Expired price or unknown schema disables X without disabling Brave.
4. Decimal IDs beyond Number precision, canonical x.com/twitter.com variants, edit-history mapping, author mismatch, malformed timestamps, URL spoofing/private hosts/multiple destinations/unresolved short URLs. Missing external link yields stable post identity; no redirect network requests.
5. Duplicate post, same outbound URL across accounts and Brave, broad/targeted collision, known stored/history-sent key and crash after analysis persistence each produce at most one logical analysis/notification identity. Preserve Brave source/title/provenance on same-cycle collision. No claim for tracking-parameter/different-URL semantic equivalents.
6. Reposts/replies/quote posts are filtered, no referenced-post fetch; only thread root. Cursor advances atomically with inbox, never loses unselected stored payload; API/storage failure does not advance; pagination truncation is reported; seven-day payload expiry does not alter replay's 72 hours.
7. Two P3 preferred and one P5 official opportunity are preserved, no X fifth slot, total <=4; X official flag is always false. Full Brave pool can starve X and this is an expected test outcome; sparse Brave/P3-matching X can reach analysis normally.
8. X-derived linked trusted-domain analysis below 7 is excluded from P4 both fresh and replay; same-source Brave analysis retains existing P4 behavior. Provenance cannot come from Gemini, disappear on copy/touch or be silently ignored when malformed. Normal X >=7 feeds existing digest, attribution/link escaping correct, one-email maximum and no duplicate resend.
9. Partial/full X failures, auth stop, rate-limit stop, suspended account and one bad post leave successful Brave behavior intact. Actual all-Brave-failed still rejects before X. Gemini-blocked cycle makes zero Brave/X/Gemini fresh calls while replay can send. Healthy-X inputs do not mask unreadable ordinary history.
10. Migration empty/legacy DB, optional metadata compatibility, disabled X without tables, JSON/D1 parity, rollback-to-disabled build, source retention and exact log redaction. Existing replay/provider-limit/Worker-bundle/health-only/Cron/P3-P5 tests stay passing.
11. After separate Builder authorization: inspect scripts, run npm ci/build/test/worker:typecheck and diff checks, then independent Analyst on exact commit. No live credential tests, provider calls, subscription or deployment during verification. Production use additionally requires human review of current X developer terms for storage, deleted-post handling and third-party inference; do not assume API access alone settles those obligations.

### Approval decisions and residual risks

Required human approval: exact account IDs/labels, paid <=$8 pilot and provider-side cap, pricing review/expiry, token/setup, additive persistence and provenance/P4 exclusion, minimal retention/deletion handling under current terms, and eventual separate deployment. Account identity/entitlement evidence is not yet supplied; implementation must wait, but the architecture is concrete for approval.

Principal risks: quiet-account selection versus noisy feeds; latest-ten truncation; no guaranteed X opportunity in four slots; dates/deletions/edits and account compromise; a linked post may be a poor proxy for article content; exact-URL dedup misses semantic variants; source-provenance rollback must remain safe; price changes require provider enforcement plus bounded local usage. No active credentials, account list, paid entitlement or deployment are claimed verified by this task.

### Builder handoff — 2026-10-08

- Implemented the human-approved immutable five-ID selected-account registry, disabled-by-default timeline reader, conservative usage reservation, Worker-neutral D1/local state, additive migration `0004`, strict post/link normalization, shared four-slot integration, application-owned provenance, P4 exclusion, digest attribution, and bounded secret-free observability on `codex/p6-x-source-integration` from `01ef0787cad02c49d453f781e1b106a247b7e5d7`.
- Human approval covered the registry identities/order and source implementation. No credential, X request, paid credit, production migration, Cloudflare/D1 mutation, deployment, or provider cycle occurred. Activation remains blocked on the separately protected prerequisites documented above.
- Builder validation and exact commit/PR evidence are recorded in the role-owned summary after the final offline suite. Independent Analyst review is still required.
## Gemini ambiguity-accounting hotfix — approved Builder scope

Implementation is isolated from deployed production commit `01ef0787cad02c49d453f781e1b106a247b7e5d7`; P6 and its `0004_x_discovery.sql` migration are intentionally absent. The approved hotfix adds explicit UTC accounting, durable `legacy` / `reserved` / `exact` / `confirmed_zero` / `transport_ambiguous` / `retired_outside_accounting_windows` states, D1-fenced admission, exact settlement, fail-closed transport ambiguity, and operator-only retirement without token estimates. Migration `0005_gemini_ambiguity_accounting.sql`, deployment, and every production recovery remain separate human approvals.

Legacy row 17 at `2026-10-08T08:02:03.393Z` remains historical unknown usage with unchanged `0/0/0` placeholders. It is active through its UTC day, Monday-start week, and calendar month; its first safe retirement boundary is `2026-11-01T00:00:00Z`. The incident-specific procedure may eventually change only `gemini_usage_state.usage_unknown` from `1` to `0` after exact proof and separate authorization. See `GEMINI_ACCOUNTING_RECOVERY.md`.

Analyst fixup: every structured request now has a durable `accounting_through` anchor. An unresolved reservation blocks globally; a terminal or ambiguous transition extends the interval through the authoritative transition time, and request/exact-token accounting applies to every UTC window overlapped by that interval. This closes the final check-to-fetch race without a timing margin or token estimate. A stranded `reserved` row has a separate operator-only, exact-identity CAS reconciliation to `transport_ambiguous` with reason `abandoned_reservation`; it still requires ordinary window-safe retirement afterward.

---

## P5 — Discovery Reliability: architecture revision 1

Architecture status: HUMAN-APPROVED; implementation is at REVIEW. P5 here means Discovery Reliability under the current roadmap, not the old user-feedback proposal (now P7).

### Verified baseline and current pipeline

Human-supplied authoritative main and locally recorded origin/main: `46a69af998399b1b15ea0718c210d3a786da462c`. Inspection checkout is `docs/roadmap-p5-p7` at `da90cf038b67b10630d62c12b03c109a7a521610`, initially clean. Source/tests/migrations/AGENTS/PROJECT_STATE show no differences from origin/main. No fetch or live production verification was performed. Existing historical REVIEW records are preserved; they are not a new independent review of P5.

Local main is stale at `f21676125f3b3c5f9dab2a8389e141e5ff35886f`; it was not moved. Builder must reverify the human-approved authoritative baseline before implementation rather than starting from that stale local branch.

Current exact integration points:

- `src/services/monitor.ts`: MONITORING_QUERIES contains ten broad strings. runMonitoringCycle first loads bounded replay and runs read-only Gemini preflight; only allowed cycles execute the sequential query loop. Custom query replaces the ten with one. Preserve that ordering.
- `src/tools/webSearch.ts`: searchWeb POSTs to the existing web-search endpoint with `{q: query.trim(), count: 5}`; no freshness is supplied. It maps page_age to SearchResult.publishedAt, and performs the current Brave guard/accounting. Worker composition in `src/worker.ts` supplies D1-backed search; monitor's local default supplies JSON-backed search.
- Monitor Phase 1 uses normalizeDiscoveryUrl from `discoveryHistoryCore.ts`, firstCandidateByUrl and durable history before analysis selection. Known URLs consume no analysis slot; duplicate normalized URLs are not independently analyzed. Current normalization retains queries/fragments and normalizes trailing path slashes; do not introduce semantic-story/canonical-link deduplication.
- `src/services/discoveryPriority.ts` identifies Codex/Claude Code candidates. Monitor selects up to two preferred candidates, fills with non-preferred candidates in discovery order, then uses remaining preferred candidates if space remains; maximum four. Phase 2 processes selected items in stable discovery order. Gemini availability/request guards can still prevent selected stories from receiving a completed analysis.
- Completed analyses and durable replay join the existing notification pipeline. P3 digest comparator, threshold 7, P4 trust/label, four-story digest, one-email ceiling and notification history are downstream and unchanged.

### Freshness contract

Official Brave [POST Web Search reference](https://api-dashboard.search.brave.com/api-reference/web/search/post), consulted 2026-10-07, defines `pw` as pages aged seven days or less. Its age can reflect publication OR last modification, so this is not proof that an article was first published within seven days. [Search operator documentation](https://api-dashboard.search.brave.com/documentation/resources/search-operators) documents site targeting, uppercase OR and inclusion of subdomains; it also warns operator behavior can change.

Add optional `freshness?: "pw"` to SearchWebDependencies and to the injected search call's small options type. Scheduled/default monitoring explicitly passes `{ freshness: "pw" }` on ALL ten queries. Authorized local custom runMonitoringCycle(query) uses the same weekly freshness and still only one search; a direct standalone searchWeb caller that omits this optional field retains existing behavior. No new manual/HTTP endpoint. Forward the option through Worker and local composition; do not apply it only in a test/mock or embed it in q. Payload is `{ q, count: 5, freshness: "pw" }` for monitoring; existing method/endpoint/auth/count stay fixed.

On freshness rejection or other request failure, use the existing query-failure handling; never retry with the filter removed, expand to another time range, paginate or allocate a replacement query. Silent provider semantic drift cannot be fully detected locally. Parsed page_age outside the local seven-day interval earns no official priority, but remains an ordinary candidate to avoid silently redesigning general eligibility. Missing/invalid dates similarly get no official-priority claim. The monitoring target is seven-day discovery, not a guaranteed publication-date gate. No article fetch, date inference by LLM or date scraping is introduced.

### Ten fixed queries, five official and five broad

Create `src/config/discoveryQueries.ts` with exactly ten immutable descriptors `{id, query, kind, officialHostnames?}` and freshness constant `"pw"`. Keep a compatibility MONITORING_QUERIES export derived from descriptors if callers/tests import it; never maintain two independent query lists. Execute in this exact order, once each, sequentially, subject to unchanged preflight and quota guards:

1. `official_openai`: `site:openai.com`
2. `broad_codex`: `Codex AI coding assistant developer features releases workflows`
3. `official_anthropic`: `site:anthropic.com`
4. `broad_claude_code`: `Claude Code AI coding assistant developer features releases workflows`
5. `official_google`: `site:blog.google OR site:ai.google.dev`
6. `broad_ai`: `AI news model releases open-source agents frameworks SDK MCP developer tools`
7. `official_github`: `site:github.blog`
8. `broad_programming`: `programming language compiler standard library IDE CLI CI/CD code review releases`
9. `official_microsoft`: `site:devblogs.microsoft.com OR site:learn.microsoft.com`
10. `broad_infrastructure`: `cloud DevOps Kubernetes networking security advisories developer productivity tutorials`

Broad topics consolidate existing coverage: AI/models/agents/frameworks/API ecosystems, programming, infrastructure/security, developer tools/workflows, and dedicated Codex/Claude Code slots remain. Five broad queries instead of ten necessarily trade some query diversity for guaranteed query allocation to the five named publishers. This is an explicit trade-off, not a claim of lossless recall. Interleaving brings P3 discovery earlier while ensuring an OpenAI query is attempted even with only one remaining search allowance. Later sources can be skipped on quota exhaustion; no per-publisher outcome guarantee.

Official queries deliberately omit mandatory product/release keywords so a launch titled “Introducing ...” or an unforeseen product can be found. Group only related publisher hosts for Google/Microsoft. Five returned results per query remain; no host-per-query expansion from the P4 registry. GitHub uses github.blog rather than the very broad user-generated github.com host. AWS, Google Cloud, Azure, Kubernetes and language-project sites remain discoverable through broad topic queries; dedicated coverage for them is deferred rather than exceeding ten or removing the core five.

Descriptors' exact official-priority host sets (discovery policy, NOT additions to P4 trust): OpenAI = openai.com, www.openai.com, developers.openai.com, platform.openai.com; Anthropic = anthropic.com, www.anthropic.com, docs.anthropic.com; Google = blog.google, ai.google.dev; GitHub = github.blog; Microsoft = devblogs.microsoft.com, learn.microsoft.com. Some result hosts selected by Brave's parent-domain operator may lie outside these sets; they remain ordinary candidates and gain no reserved priority. Search targeting never grants fallback delivery trust. Humans approve these query/priority policies through this plan; no runtime additions or generated queries.

### Candidate identity, provenance and bounded selection

Keep query provenance only in cycle memory: the query descriptor/ordinal and a bounded official-priority flag alongside each result. Never trust a provider-returned source label or candidate-supplied query ID. Compute priority from the actual preserved URL and that result's targeted descriptor, not from a hostname string inside a title/path/snippet.

An official-priority observation must (a) come from one of the five targeted queries, (b) have HTTP(S) URL without credentials/non-default port and exact canonical hostname in that descriptor's set, and (c) have an unambiguous valid page_age within `[cycleStartedAt - 7*24h, cycleStartedAt]`. Lowercase parsed ASCII hostname, remove one terminal DNS dot; no inferred subdomain/www trust. Accept canonical YYYY-MM-DD as UTC midnight or ISO date-time with explicit timezone; reject invalid/calendar-overflow, relative-age strings and timezone-less date-times for priority. This timestamp is a provider recency signal, not verified first publication.

Deduplicate using the EXISTING normalized URL before assigning slots. Retain the first SearchResult/prompt/source title/URL; union the locally computed official flag from duplicate observations, so a broad-first duplicate does not lose targeted discovery evidence. Keep only bounded per-URL metadata, with a stable first-seen ordinal. Known persisted URLs retain ordinary touch/no-analysis behavior. Notification-history identity and stored analysis schema do not change. Different URLs covering the same story are a known residual limitation, not grounds to merge records heuristically.

Select unseen unique candidates deterministically:

1. Reserve up to two slots for the existing P3 preferred candidates in existing order; use unchanged getPreAnalysisCandidatePriority.
2. From remaining NON-P3 candidates, reserve at most ONE slot for an official-priority candidate, in first-discovery order. This is a limited opportunity to be analyzed, not a “major release” classifier, trust score or relevance bonus.
3. Fill remaining slots with remaining non-preferred candidates in existing discovery order, excluding already selected URLs; fill any residual space with remaining preferred candidates as before. Total selected <= 4. Empty official slot is immediately reusable, not withheld.
4. Preserve Phase 2 processing order and per-story failure behavior; no replacement analysis after a selected story fails. Do not reorder dispatch solely to force the fixture through an exhausted Gemini budget.

With two P3 stories and ordinary generic competition, a recent targeted official story gets one of the other two slots while one remains available to generic coverage. If there are no P3 stories, more ordinary/official stories can fill the unused slots through normal order. When no eligible official-priority candidate exists, selection is identical to P3's current algorithm. No relevance score, Gemini prompt, normal eligibility, digest comparator or P4 predicate changes. Local custom-query results use ordinary P3 selection; no arbitrary user-written site query becomes an approved descriptor automatically.

### GPT-6.1 Sol deterministic acceptance fixture

Treat the named missed release as the human-provided motivating example, not a newly verified live publication. Freeze the test clock; use a SYNTHETIC fixture titled “Introducing GPT-6.1 Sol” at `https://openai.com/index/test-gpt-6-1-sol/`, published two days before the clock. This path is a test input, not a claim that a real page exists. Broad fixtures never return it. Only official_openai returns it, after four other fresh unseen non-P3 results with no qualifying official recency (e.g. missing dates); other broad results include two P3 candidates and generic competitors.

Assert the exact targeted query runs with pw; Sol appears once in the normalized candidate pool and occupies the one official-priority slot alongside both P3 candidates, with total selected <= 4. Under the previous fill order the two ordinary non-P3 slots would be consumed before Sol. Inject sufficient allowed local budget and successful mocked analyses to assert the Sol analysis call actually occurs once. Do not require sending: relevance/notification policy still decides. Separately return Sol's URL from a broad fixture first and the targeted fixture later; provenance union still gives one priority candidate and one analysis. Add known/history-notified variants proving no reanalysis/resend. No live search, fetch of the synthetic URL or Gemini call.

### Failure and quota behavior

- Each descriptor is attempted at most once; at most ten default Brave dispatches per cycle, or one custom dispatch. No retries, additional fallback queries, pagination or second search pass for duplicate-heavy/empty results. Preserve daily/weekly/monthly guard values 10/100/350 and existing stop-on-quota semantics.
- Partial source or broad query failure is recorded by existing bounded ordinal/error reporting; other queries continue. Actual all-search-failed/no-usable-result handling still rejects as Proposal 2 specifies. Legitimate zero-result searches remain normal, not failures. Do not convert all-search failure to replay success.
- Duplicate-heavy results can produce fewer than four new analyses; do not compensate with more queries or reanalysis. Selection bypasses known URLs exactly as before.
- Gemini blocked preflight performs zero Brave/new Gemini calls, with replay-only behavior and reason observability unchanged. A later request guard failure remains authoritative. Preserve Gemini requests 5/20/50, tokens 10000/30000/100000, approved model order, max four logical analyses and all reservation/fallback semantics.
- Existing Brave persistence records successful HTTP requests, not all failed dispatches. This task does not redesign that accounting or claim to fix cross-cycle undercount after errors. The fixed ten-iteration/no-retry bound still applies to this cycle; retain existing guards and disclose this pre-existing limitation.

### Builder scope and deployment implications

Expected source changes: new `src/config/discoveryQueries.ts`; `src/services/monitor.ts` for descriptor/provenance wiring and the bounded slot selection; `src/tools/webSearch.ts` for optional pw serialization; `src/worker.ts` for passing search options. Put the small pure official-priority/selection helpers in `src/services/discoveryPriority.ts`, keeping its digest functions unchanged. No persistence, AgentAnalysis, trust registry or Gemini implementation change should be necessary. A shared small search-options type can live with webSearch and be imported type-only; avoid broad type refactoring.

Tests: `test/webSearch.test.ts`, `test/monitor.test.ts`, `test/discoveryPriority.test.ts`, `test/workerConfiguration.test.ts`; optional focused `test/discoveryQueries.test.ts`. Documentation after implementation authorization: this plan, README, PROJECT_STATE and role-owned summary/changelog/review. This architecture task modifies only ARCHITECT_PLAN.md; do not rewrite historical reviews or implement roadmap entries. No new dependencies/infrastructure.

After independent review and separate human release approval, P5 requires only a Worker code deployment. No environment variables, quota values, secrets, D1 migration or Cloudflare resources/Cron changes are required. No deployment is authorized now. Production remains Cron-only with health-only HTTP; X.com, feedback/P7, P6, model changes, provider probes and all quota increases are excluded.

### Exact offline acceptance criteria

1. Query config has exactly the ten ordered descriptors above, five official/five broad; scheduled execution makes <= 10 requests and custom <= 1. No retry or expansion after any result/error mix. All monitoring payloads contain count 5 and freshness pw; direct omitted-option behavior stays compatible. Worker/local options propagation is tested, not only the low-level client.
2. Rejected freshness is an ordinary failed query, never an unfiltered retry. Partial/all-failed/quota/zero-result semantics remain unchanged. Query IDs/ordinals map deterministically to the static list.
3. All five official publishers have one allocated query; returned off-host/credentialed/unsupported/port-spoofed URLs and fake source labels cannot gain official priority. Invalid, missing, future, just-too-old dates gain no priority; exact seven-day boundary is included. No new global rejection of normal candidates.
4. The Sol fixture is absent from broad results but selected/analyzed once through targeted coverage under sufficient mocked budget. Include the competing two-P3-plus-generic scenario described above; compare expected old/new selection explicitly. Test broad-first/targeted-later normalized duplicates, title preservation and historical known URL handling.
5. Two existing P3 reservations are preserved; one official reservation at most; remaining slots backfill deterministically with no duplicates and <= 4 analyses. Without official candidates, selection is unchanged. More than one official source, all preferred, all official, empty lanes and missing-date results exercise stable order and bounded capacity.
6. Gemini preflight denied => zero searches/analyses and eligible replay can still send; successful preflight followed by dispatch denial fails closed. No extra Gemini provider allowance. All existing P0/P3/fallback-accounting tests remain passing.
7. Official status never bypasses normal relevance analysis/threshold or expands P4 registry. Test low-scoring official analysis with existing P4 policy, unknown normal source >=7, sent-history exclusion, current-trust replay, one email/four-story cap and unchanged digest ordering. Replay never enters discovery selection or Gemini again.
8. Full offline tests/build/Worker typecheck and diff checks pass after inspecting scripts; use mocked search/analysis/email exclusively. Inspect final diff for unchanged quotas/model pool/HTTP/Cron/schema/secrets. Tests prove algorithmic coverage and limits, not real-world indexing or release recall.

### Risks, unresolved limits and next decision

Brave may not index a release, may omit it from the top five, may expose no useful date, or may apply changed site/freshness semantics. Date age can reflect an update. Static first-source order can favor OpenAI, and a single official slot cannot guarantee every important release. Five broad calls preserve topic representation but reduce broad-query variety; grouped Google/Microsoft queries can skew toward one host. Cross-URL duplicate stories and provider/accounting outages remain. These are disclosed trade-offs, not hidden claims of complete discovery reliability.

Human approval covers the exact 5+5 allocation, source-priority host sets and one-slot policy. The Builder implementation retains the normal Builder -> independent Analyst -> Architect -> human release flow. No provider call or production mutation was performed to establish this design.

### Builder handoff — 2026-10-07

- Implemented the approved descriptor configuration, weekly Brave freshness option, ephemeral targeted-official provenance, and bounded pre-analysis selector on `codex/p5-discovery-reliability` from baseline `46a69af998399b1b15ea0718c210d3a786da462c`.
- Added offline coverage for the exact 5+5 order, freshness payloads and failure behavior, official-host/date boundaries, P3/P5 allocation, a synthetic GPT-6.1 Sol fixture, cross-query provenance union, and Worker freshness propagation.
- Validation: `npm ci`, `npm run build`, `npm test` (244/244), `npm run worker:typecheck`, and `git diff --check` passed. No provider call, deployment, Cloudflare/D1 mutation, migration, secret/configuration change, or production merge occurred.

---

## Gemini availability preflight / blocked state — architecture revision 1

Date: 2026-10-07. Architecture: GEMINI_PREFLIGHT_ARCHITECTURE_READY. Design only; no implementation cycle, recovery action, provider execution or release is authorized by this entry.

### Baseline and inspected behavior

Local HEAD and cached origin/main both equal the human-supplied authoritative baseline `f21676125f3b3c5f9dab2a8389e141e5ff35886f`; checkout is main, initially clean. No fetch or production-state query was performed in this task. Read current operating contract, Architect guide, PROJECT_STATE, existing plan/review/summary/changelog, monitor/Worker composition, runtime configuration, Gemini client and accounting interfaces/adapters, and relevant tests/scripts. Only this architecture document changes; backlog.md and plan.md remain untouched.

Current monitor performs searches before loading replay. checkGeminiUsage collapses all blocked conditions to `{ allowed: false }`. The Worker composition also validates Gemini limits and key eagerly, so invalid Gemini configuration currently prevents entry into replay processing. Actual Gemini dispatch already rechecks usage, reserves and settles exact-model requests, and preserves unknown state on ambiguous outcomes. Keep that authoritative dispatch path.

Historical multi-model and replay handoffs still show REVIEW, while this authoritative source includes their implementation; the latest checked-in Analyst review is historical GOV-001. Do not invent later review outcomes or rewrite historical evidence. Reconcile closure evidence before initiating a new implementation cycle. This design is grounded in the supplied current baseline, not an assertion of a newly verified deployment.

### Shared availability API

Keep quota truth in `src/services/geminiUsageGuard.ts`. Introduce these exported types/signatures (declarations specify architecture, not an implementation):

```ts
type GeminiBlockedReason =
  | "usage_unknown"
  | "daily_request_limit" | "weekly_request_limit" | "monthly_request_limit"
  | "daily_token_limit" | "weekly_token_limit" | "monthly_token_limit"
  | "usage_state_unavailable" | "invalid_configuration";

type GeminiAvailability =
  | { allowed: true; counts: GeminiUsageCounts; limits: GeminiUsageLimits }
  | { allowed: false; reason: GeminiBlockedReason };

type GeminiUsageReader = Pick<GeminiUsageStore, "getUsageData">;

function inspectGeminiAvailability(
  reader: GeminiUsageReader,
  environment: RuntimeEnvironment,
  now?: Date,
): Promise<GeminiAvailability>;

function checkGeminiUsage(
  tracker: GeminiUsageStore,
  environment?: RuntimeEnvironment,
  now?: Date,
): Promise<GeminiAvailability>;
```

`inspectGeminiAvailability` is read-only and quiet: configuration validation, one getUsageData call, validated records and existing window/count logic only. No fetch, model probing, reservation, settlement, state mutation, new persistence/cache, filesystem creation, auto-clear or cycle-budget mutation. The reader's type intentionally exposes no write methods. Available means local admission appears possible at this snapshot, not that Google's service/key/quota is verified remotely.

Use a single pure evaluator for validated usage/limits and one typed limit discriminator. Preserve daily/weekly/monthly request checks followed by daily/weekly/monthly token checks. If callers/tests depend on reachedGeminiLimit's current human-readable string, derive it from a fixed enum-to-label map; do not retain a second set of comparisons. checkGeminiUsage delegates to the inspector and supplies existing allowed/blocked logging with enum-derived, secret-free messages. Actual dispatch still calls that wrapper before every request and retains atomic reservation and frozen-cycle allowance checks. No new fallback branch or model-selection rule.

Deterministic precedence: (1) invalid Gemini configuration, (2) usage read/shape/count failure, (3) valid state with usageUnknown true, (4) first reached limit in the existing order, (5) available. Invalid configuration covers malformed/missing Gemini limits and absent/blank GEMINI_API_KEY, using shared validation with dispatch; it cannot identify a remotely invalid nonempty key without a prohibited probe. Invalid/missing persisted state, malformed record/timestamp, unusable totals, thrown reads or invalid evaluation clock map to usage_state_unavailable. Never echo the error or raw state. Validate safe finite aggregated counts; no NaN/overflow may result in permission. Preserve current time-window semantics, historical unknown-model rows and local JSON's existing missing-file behavior; do not introduce new storage policy here.

### Composition and configuration boundary

Add `geminiPreflight?: (now: Date) => Promise<GeminiAvailability>` to MonitoringCycleDependencies. Worker composition always supplies it, closing over the SAME D1GeminiUsageStore and copied environment used for dispatch. The default local composition creates one LocalJsonGeminiUsageStore and shares it between preflight and analysis. A missing injected callback uses that real local default, never an implicit allowed result. Mock-only tests must explicitly inject a preflight fixture; custom search/process dependencies do not disable preflight. Catch an unexpected preflight rejection or invalid result as usage_state_unavailable without serializing its payload.

Add a narrowly named `createMonitoringRuntimeConfiguration(source)` alongside the existing strict `createRadarRuntimeConfiguration(source)`. Factor their existing environment copy and non-Gemini validation into shared helpers. The new monitoring composition validates current non-Gemini requirements exactly as before (Brave configuration, Resend and notification bindings) but defers only Gemini key/limit validation to the inspector. Keep the old strict factory for other callers. This is not a general ignore-validation flag. Worker uses the new factory; local default preflight/dispatch must share the same environment snapshot. Missing Resend/notification prerequisites do not become permission to deliver; no secrets are changed or exposed.

This isolates a broken Gemini configuration or usage table while preserving healthy discovery/notification persistence. A whole D1 outage still aborts on replay/history reads; replay must never bypass unreadable deduplication/notification state. No adapter behavior, reservation protocol or schema migration is required.

### Exact control flow

1. Capture and validate cycleStartedAt; create a fresh GeminiCycleContext and empty result before any search. Compose dependencies without executing providers.
2. Compute the existing replay window from cycleStartedAt and perform the existing single bounded replay lookup (skip lookup only when existing window policy says so). Preserve the 72-hour window, cutoff, 100-row cap/order and trust recheck. Replay read failure aborts before search or notification; do not hide it as a Gemini block.
3. Run the read-only Gemini preflight once using a current timestamp from the injected clock. The replay boundary remains cycleStartedAt. Do not seed/decrement remainingRequests from this snapshot: the existing first actual request still initializes its frozen allowance and every dispatch revalidates current state. Avoid changing rollover or budget semantics in this improvement.
4. If allowed, run the current Brave query loop and discovery/analysis phases unchanged, including custom-query behavior. Keep Proposal 2 partial non-quota tolerance, quota-denial behavior and all-search-failed rejection. Loading replay earlier does NOT turn an actually all-search-failed cycle into successful replay-only delivery.
5. If blocked, set geminiBlockedReason, perform zero Brave calls, zero new analysis/process calls and zero Gemini writes/dispatches. Do not touch known URLs' lastSeenAt, fabricate candidates or retry preflight within this cycle. An intentional skip is not a Brave failure. A latch cleared externally during this cycle does not resume discovery mid-cycle; the next cycle can reassess.
6. Both paths converge on the existing single merged delivery path. With discovery skipped, its fresh list is empty and replay candidates go through unchanged notification-history filtering, normal threshold/ranking, P4 fallback, current trusted-host registry and four-story/one-email limits. Replay selection/analysis adds no Brave/Gemini call; an actual replay email still uses the existing Resend call and ordinary notification-history write.
7. Return the result and emit the existing single scheduled completion summary. Gemini block alone is a completed replay-only/no-op cycle with a blocked-health field. Other history/send errors retain existing rejection/failure behavior; do not synthesize a success summary for a rejected cycle. No new log sink, Cloudflare change, retry, endpoint or scheduler.

### Reasons, counters and race semantics

Add `geminiBlockedReason?: GeminiBlockedReason` to both MonitoringCycleResult and ScheduledCycleSummary. Define it narrowly as the cycle's PRE-DISCOVERY preflight outcome; absence means that preflight allowed discovery, not a claim of continuing provider health. Do not overwrite it after dispatch-time failures. Those retain existing bounded error/counter reporting. This avoids misleadingly reporting that search was skipped when a race actually occurred after search.

Omit newDiscoverySkippedForGeminiBlock: with this definition it is exactly equivalent to reason presence and would create redundant state. Serialize only the allowlisted enum; reject/map malformed injected values to usage_state_unavailable before use. No health-field secrets, URLs, provider bodies, raw D1 values or free-text errors. Existing summary redaction remains intact.

On blocked discovery: searchResultsReceived, resultsProcessed, newDiscoveries, duplicates, analysesAttempted, geminiProviderAttempts, geminiFallbacks, analysesUsingFallbackModel, all per-model attempt counts and freshStoriesSent are zero; stoppedByAnalysisCap is false; searchFailures is empty. No synthetic discovery outcomes or counted processing failure. The configured query description remains a description, not proof of execution. Replay counts/truncation and notification counts retain their real meanings; failures remains zero unless actual replay delivery/processing fails under current rules. Previously sent/ineligible replay is filtered normally. No replay candidates means no notification call/email and a clean summary with the exact blocked reason.

An unavailable Gemini store permits replay-only operation if independent replay and notification persistence/configuration are healthy. Unknown usage, any reached limit and invalid Gemini configuration behave the same way operationally, with distinct enums. The preflight cannot predict reservation races or remote outages. If usage becomes unknown/capped/unreadable after preflight, the real guard blocks before dispatch; a subsequent reservation race still fails closed. Some Brave requests may already have been spent in that race, which is an accepted limit of this one-snapshot optimization. No attempt to reserve capacity early, bypass a guard, auto-clear a latch or redesign concurrency is allowed.

### Operator runbook text for later PROJECT_STATE update

“Gemini blocked health describes why new discovery was skipped at preflight. Eligible stored replay can still be delivered while Gemini is blocked. A completed cycle is not proof of Gemini availability.

For a request/token limit, inspect the recorded usage and existing window/configuration; wait for the normal applicable window reset. Do not raise limits, switch projects/keys, delete history or clear usage_unknown to evade a limit. For invalid_configuration, verify the named binding/limit definitions without printing values; correction requires the normal separate approval. For usage_state_unavailable, investigate access, schema and data integrity read-only; never substitute empty usage or recreate/reset state automatically.

For usage_unknown, preserve the latch. Identify the affected execution and whether a request or settlement could still be active. Do not interfere with a live reservation. Under a separately approved recovery procedure, prevent concurrent dispatch during reconciliation, preserve evidence and correlate bounded logs with reservation IDs, timestamps, exact model/request rows and settlement evidence. Zero-token reservation data is not proof the provider did no work.

Determine whether the request may have executed. Reconcile request and token consumption from authoritative evidence; retain the existing request reservation and avoid counting it twice. Include thinking tokens and relevant quota windows. If exact consumption cannot be established, a conservative documented upper bound must be justified and human-approved; if no safe bound/evidence exists, remain blocked. Passage of time, absence of an error, or an empty dashboard alone does not justify clearing the latch.

Only after reconciliation, verification that no active request can race recovery, and explicit human approval of an exact correction may a separate controlled operation update accounting and clear the specific latch. Review and record before/after evidence without secrets, then run a read-only availability check. Re-enable ordinary scheduled execution only within that approval. This runbook grants no mutation authority and supplies no blind latch-reset SQL. No automatic recovery, scheduled clearing, deletion of usage history or provider call merely to test the account is permitted.”

### Later Builder file scope

- `src/services/geminiUsageGuard.ts`: typed reasons, shared evaluator, read-only inspector and logging wrapper; existing thresholds/windows unchanged.
- `src/services/radarRuntimeConfiguration.ts`: narrow monitoring configuration preparation and shared validation; retain strict factory contract.
- `src/services/monitor.ts`: replay-first ordering, preflight injection/default wiring, conditional discovery and result initialization; reuse delivery path.
- `src/worker.ts`: bind read-only D1 preflight to the same usage store/environment; add the one summary field; preserve HTTP/Cron and logging behavior.
- `src/types/index.ts`: type-only GeminiBlockedReason reference and optional result field. No runtime dependency on local persistence through the types.
- `src/tools/llm/gemini.ts`: only minimal shared config validation/type adaptation if necessary; no retry/fallback/reservation rewrite. No production adapter/schema changes expected.
- Tests: `test/geminiUsageGuard.test.ts`, `test/monitor.test.ts`, `test/workerConfiguration.test.ts`; focused D1/JSON read-only tests in `test/d1Adapters.test.ts` / `test/localJsonUsageStores.test.ts` if required. Update injected monitor fixtures explicitly rather than granting availability by default.
- Documentation after implementation authorization: PROJECT_STATE.md runbook/control flow/health meaning, README.md operator explanation, this plan and role-owned DAILY_SUMMARY/CHANGELOG. Analyst owns review records. No AGENTS governance change is needed: stricter discovery admission stays within existing maxima. Do not modify backlog.md or plan.md.

### Required offline acceptance tests

1. Allowed preflight preserves normal Brave, analysis, dedup and digest behavior. Assert ordering replay-read -> preflight -> search -> analysis -> delivery and shared usage-store/environment wiring in Worker and local composition.
2. Parameterize all nine reasons. Each blocks every Brave call and new Gemini/processor call. Independently reach each of the six limits with other counters below limits, and test equality/below-boundary and multiple-limit precedence. Validate malformed limits, missing Gemini key, unreadable/malformed usage, unknown state and unexpected rejected preflight.
3. Blocked unknown/read-error/invalid-configuration paths can deliver an eligible replay normally with healthy history; verify single send/history and zero fresh/provider counts. Include current-trust P4, already-notified replay, empty replay and expired/pre-cutoff replay. No replay/blocked yields zero email and clean bounded summary.
4. Replay/history failure aborts without search/send; notification-history failure never sends. A shared D1 outage is not misreported as recoverable Gemini-only failure. Real replay-send failure preserves existing failure behavior and blocked-health field when returning a result.
5. Read-only spies make every write/reserve/settle/markUnknown/fetch throw; inspector never invokes them. Durable snapshot before/after is equal, and cycle context/allowance is unchanged. Validate D1 read path and local missing-file read without file/directory creation.
6. For identical environment, usage and clock, inspector and request wrapper agree on allowed/reason. Change state between allowed preflight and actual guard to unknown, reached limit or read failure: no Gemini dispatch/reservation; existing per-story behavior remains. Existing reservation-race and frozen-budget tests still pass; no automatic mid-cycle preflight retry.
7. Monitoring-specific config allows Gemini-invalid replay-only operation; strict factory still rejects invalid Gemini settings. Other missing secrets/invalid Brave config retain existing startup rejection. Worker never substitutes local JSON storage.
8. When Brave runs, preserve partial-search tolerance, actual all-search-failed rejection, quota-denial semantics and custom-query behavior. When deliberately skipped, searchFailures remains empty and no synthetic failure is counted.
9. Summary contains each exact enum and omits it when preflight passes. No second boolean, free-text health payload or secret leak. Inject hostile read errors and malformed dependency results; verify whitelist/redaction, one completion summary and correct counters for both replay-only and no-op completion.
10. Full Gemini multi-model/P0, P1-P4, Proposals 1-3, four-analysis/one-email limits, unchanged provider ceilings and zero-Gemini stored replay regressions pass. No P5/P6/P7, query-set, pool, fallback, trust, replay-window or migration changes.

### Builder validation, risks and next handoff

After separate implementation authorization, require `npm ci`, `npm run build`, `npm test`, `npm run worker:typecheck`, `git diff --check`, `git diff --exit-code`, and green GitHub CI on the exact reviewed commit. Inspect scripts first; tests use fixtures/mocks only. Do not run monitor/gemini/email/e2e provider scripts. Interpret git diff --exit-code as the final clean-tree reproducibility check after the separately authorized checkpoint: before that, inspect the intentional implementation diff instead of deleting/stashing changes to force exit zero. Also inspect staged changes/status; plain git diff does not prove absence of staged or untracked work. Current task authorizes no checkpoint, push or CI-triggering publication.

No migration is needed. Residual risks: preflight is a snapshot rather than a provider-health guarantee; a Gemini block intentionally forfeits even potentially useful Brave discovery/lastSeenAt refresh; healthy replay still depends on Resend and authoritative notification history. Configuration separation must be narrowly Gemini-specific, and tests must not accidentally fall back to real local usage files. Existing history-write-after-send ambiguity and token admission semantics remain unchanged. Historical review/closure gaps must be reconciled before activating another cycle; no runtime policy is inferred from those stale labels.

Next handoff: human implementation approval and closure reconciliation -> bounded Builder -> independent Analyst -> Architect disposition -> human release decision. No recovery operation, provider call, quota increase, deployment or main integration is implied by architecture readiness.

---

## Gemini multi-model free-tier fallback — architecture revision 1

Architecture status: ARCHITECTURE_READY. Implementation status: REVIEW. Human approval supplied on 2026-10-06 for the exact ordered pool `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, with project-specific Google AI Studio Free-tier evidence (3.8/3.6: 5 RPM, 250K TPM, 20 RPD; 3.5 Flash Lite: 15 RPM, 250K TPM, 500 RPD). These volatile provider figures are approval evidence only and are not production constants. Builder implementation is ready for independent Analyst review; no merge, deployment, migration application, or provider execution occurred.

### Baseline and evidence reconciliation

- On 2026-10-06, fetched origin successfully and verified `origin/main == 86c80e6516f18ab07fff0ee732dc1b0e5732677f` exactly.
- Checkout: `codex/replay-unnotified-discoveries`, HEAD `c1f72604bef8fa250a00495d21848338cc44e85c`; working tree initially clean. Inspected source, tests, migrations, AGENTS.md, plan.md and PROJECT_STATE.md have no difference from fetched main. No branch switch is authorized or needed for this plan.
- Read the role/governance records, Gemini client, usage interface/guard/D1/JSON stores, runtime configuration, analysis and monitor composition, Worker wiring, relevant tests and both existing migrations. The older replay section below still says REVIEW although the supplied authoritative main includes replay; preserve its historical handoff, do not invent a missing final Analyst/Architect review. Reconcile that closure before opening an implementation cycle; this proposal is design-only.
- `plan.md` P0 currently treats all non-503 errors as terminal. This proposal expressly changes only the documented model-fallback exceptions below; it preserves same-model retries as 503-only. The existing plan must be amended after human approval, not silently reinterpreted.
- Only this architecture plan changes in this task. No live provider call, runtime/configuration change, migration, branch creation, commit, PR or deployment.

### Current implementation and gaps

`src/tools/llm/gemini.ts` sends `{ model, input }` to the existing Interactions endpoint using one GEMINI_API_KEY and an environment-selected GEMINI_MODEL (repository setting: `gemini-3.6-flash`). P0 uses an initial attempt plus at most three same-model HTTP-503 retries, fixed 5-second delays and a 30-second fetch timeout. No retry for 429, 500, authentication, network or timeout failures. No fallback currently exists.

The guard runs once BEFORE the retry loop, not before each request. Every completed HTTP error records one request with zero tokens; successful responses record validated, thinking-inclusive totals. Transport failures currently record no request. Invalid success JSON/usage marks usage unknown; recording failures throw but do not reliably leave durable unknown state. These gaps must not be multiplied by fallback.

Usage has no model field; operation is currently `minimal-test`. D1 and JSON aggregate all records. Current global request ceilings are daily 5 / weekly 20 / monthly 50; token admission ceilings are 10,000 / 30,000 / 100,000. Preserve their values and existing time-window semantics. They are application limits, not authoritative Google quota measurements.

`analysisAgent.ts` validates the same AgentAnalysis for every response and preserves original title/URL; discovery processing stores only a completed valid analysis. Monitor counts logical unseen stories before processing (maximum four), catches bounded per-story failures, and keeps stored replay outside analysis. Preserve all these boundaries.

### Official documentation and conditional pool

Official sources checked on 2026-10-06:

- [Models](https://ai.google.dev/gemini-api/docs/models) and [lifecycle](https://ai.google.dev/gemini-api/docs/deprecations): the three candidates below are stable, with no announced shutdown date at inspection.
- [Interactions support](https://ai.google.dev/gemini-api/docs/interactions-overview): all three are listed for the existing API. No endpoint or SDK migration is proposed.
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing): standard input/output free-tier pricing is listed for these candidates. This is not project-specific entitlement evidence.
- [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits): quotas are project-scoped, vary by model, and current active limits must be checked in AI Studio. App counters do not measure all usage by other clients of the project.
- [Troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting): provider retry guidance is broader than P0; this proposal deliberately preserves the narrower approved same-model retry policy.

Human-approved ordered model pool:

1. `gemini-3.8-flash`
2. `gemini-3.6-flash`
3. `gemini-3.5-flash-lite`

Human approval recorded on 2026-10-06: the existing project's Google AI Studio dashboard showed current Free-tier access for all three exact standard-text models and approved this ordering and quality trade-off. Reported limits were 5 RPM / 250K TPM / 20 RPD for 3.8 and 3.6, and 15 RPM / 250K TPM / 500 RPD for 3.5 Flash Lite. These values are approval evidence, not hardcoded capacity or a guarantee about future provider state. No key, project credential, billing identifier, or secret is recorded here; no paid fallback is authorized.

An unavailable candidate requires an explicit revised human-approved pool, never automatic substitution. Reconfirm entitlement before deployment and after billing/model changes; this implementation task does not query billing or make model-probe calls.

### Configuration and selection

Use one reviewed Worker-compatible `src/config/geminiModels.ts` constant with a version and a readonly ordered list of approved exact IDs, maximum three, unique and nonempty. Production list is populated only from human approval. No regex family expansion, dynamic discovery, remote list, runtime model-management endpoint, env fallback chain or provider-generated selection.

The static list is the sole selection authority. Retire GEMINI_MODEL as a selector in runtime configuration; document the existing environment variable as deprecated/ignored rather than silently using it as another fallback or requiring a Cloudflare edit in this task. Tests must prove environment input cannot add/reorder/select models. Human approval of replacing the existing model-selection policy is required. No keys, projects, identities or providers are rotated. No Pro, preview, legacy 2.5, paid-only, image/audio/live, batch, grounding, tool or paid service-tier additions.

### Exact fallback classification

- HTTP 503 with absent status or matching UNAVAILABLE: same model, up to three retries with fixed 5-second waits; after its fourth 503, advance one model. A contradictory structured error or explicit auth/policy condition fails closed.
- HTTP 429 with RESOURCE_EXHAUSTED: no same-model retry. Advance only when validated structured quota evidence unambiguously identifies a model-specific quota for the attempted model and no shared/project-wide, billing, permission or policy violation. Every reported violation must be recognized and model-scoped. Never infer scope from an English message containing a model name. Missing, malformed, unknown or contradictory quota details => terminal quota failure, no fallback. Project-scoped quotas with a model dimension can be model-specific; project association alone does not establish independence.
- Explicit model-not-served: immediate advance, without same-model retry, only for a documented structured provider reason identifying this exact configured model as unavailable for this endpoint. Bare 404/NOT_FOUND, resource-not-found, permission-denied, typo-like messages or string heuristics are insufficient. Builder must supply a documentation-backed, fixture-tested reason allowlist; if no such machine-readable discriminator is documented, keep this category disabled and fail terminally. Do not invent a Google reason code.
- Always terminal: invalid prompt/request/schema, 400, 401, 402, 403, 500, safety/policy refusal, authentication/key/permission failures, unknown errors, transport failure/timeout, accounting uncertainty and usage denial. No generic SDK retry layer.
- A successful HTTP response ends provider fallback. JSON/usage/AgentAnalysis/source-integrity failure is semantic/accounting failure, never permission to ask another model. Explicit safety-block responses are terminal even when HTTP is successful.

Builder must implement a pure bounded classifier with offline fixtures. Unknown error structures fail closed. HTTP-503 status alone preserves existing P0 compatibility; 429 and model-not-served exceptions require stronger evidence as above. Do not sleep through a shared quota limit or return to a previously abandoned model.

### Retry/fallback state machine and bounds

`validate approved configuration -> start logical analysis at primary -> check global and cycle budget -> check model guard -> begin accounted attempt -> dispatch -> settle usage -> classify -> same-model retry / advance / return response / terminal failure`.

Before EVERY actual request, including retries and transitions, check durable usage and remaining cycle budget. Only 503 increments the same-model retry index; each model gets at most four total attempts. A new model starts at attempt one; indices only move forward. A locally denied model may be skipped only for a positively identified model-only guard; a global or uncertain denial terminates the chain. Stop after the first HTTP success and run unchanged semantic validation; no later model is contacted on its failure. Exhaustion raises one bounded per-story error. No partial discovery, fabricated score, recursive cycle retry or repeated Brave/dedup work.

Structural bounds for three models: 12 provider attempts per logical analysis, 48 across four logical analyses. These are algorithmic ceilings, NOT additional production budgets. Add an immutable per-cycle remaining-request allowance captured from the existing global guard at cycle start and decremented on dispatch, never replenished at a calendar rollover. With current daily limit 5, the effective maximum is 5 requests for one story or the ENTIRE four-story cycle, often fewer due to previous daily/weekly/monthly consumption, token gates, or model limits. For example, four primary 503 attempts can leave only one secondary attempt; tertiary need not be reached. No promise of increased daily application allowance.

Keep fresh usage checks on every attempt as well as the frozen cycle allowance. Non-monitor callers receive the same per-invocation budget snapshot and guard checks. Sequential execution only; concurrent writers must not bypass durable accounting admission. No change to `analysesAttempted`: a story trying three models is still one logical attempt; maximum four remains. Replay always performs zero Gemini calls.

### Accounting, uncertainty and smallest migration

Add nullable `model` to historical records and require exact nonempty approved `model` on all new production attempts. New operation: `analysis`; never encode model identity in operation. Preserve old operation strings and do not relabel history. Store model attribution even for HTTP failures and dispatched transport failures. Provider-attempt observability counts fetch dispatches, not locally rejected attempts.

Proposed sole schema migration `migrations/0003_gemini_usage_model.sql`:

```sql
ALTER TABLE gemini_usage ADD COLUMN model TEXT;
```

Existing rows remain NULL = unknown historical model; never assume they used 3.6. Aggregate them normally against every global ceiling. Per-model reporting has an explicit unknown-history bucket. If approved model-specific local ceilings are later supplied, conservatively include unknown historical usage in each model's relevant window for admission, without duplicating it in global totals or reporting it as factual model attribution. Missing/invalid data is not zero usage.

Extend the usage-store API narrowly for durable attempt admission/settlement. Before dispatch, durably acquire the existing usage-state flag (known -> unknown/pending) and reserve exactly one model-attributed request row with provisional zero tokens. The state acquisition and reservation must be atomic and conditional; only one request can hold it. Return an opaque reservation handle. Dispatch only after success. On a completed HTTP failure, settle once using the existing zero-token failure convention; on valid successful usage, update that same row with validated thinking-inclusive totals. Settlement and restoring known state must be atomic, tied to that reservation, with no append/double-count. Do not expose a general clear-unknown operation.

For network ambiguity, crash, malformed success JSON/usage, failed persistence, interrupted settlement or invalid reservation, leave usage unknown and stop all subsequent Gemini attempts, including later stories/cycles. Never clear a pre-existing unknown flag automatically; recovery requires separate human-reviewed evidence. A crash after reservation but before fetch may conservatively overcount one request; label this as a reservation, not verified provider execution. This small admission change prevents a failed usage write from enabling another model or a later cycle. Builder must prove atomic ownership/settlement with D1 and JSON tests; inability to do so within these interfaces requires scope clarification, not a weakened guarantee.

D1 continues to use the existing singleton state and row IDs; no new quota table or discovery migration. JSON accepts old missing/null model as legacy, writes model on new records, preserves history and uses atomic replacement plus exclusive admission for reservation/settlement; a storage-local opaque reservation ID may be used for parity with D1 IDs. Do not include Node filesystem code in Worker bundles. Malformed model metadata fails closed; do not reject valid historical IDs solely because they were removed from the current pool.

Apply migration before new code in a separately approved release; old code's explicit column lists remain compatible with the added nullable column. New code with missing schema blocks before fetch. Rollback retains the column/history and must not run older writers concurrently with pending reservations or unknown state. Do not downgrade during an in-flight request, delete usage, erase uncertainty, or automatically drop the column. Test old rows, old writes, schema absence, preservation, and rollback compatibility offline.

### Quota guard policy and limits of guarantees

Keep global app ceilings unchanged and count ALL models, errors, retries and fallback attempts together. Add per-model counters for attribution, not invented available capacity. No hardcoded Google RPM/RPD/TPM values and no division/multiplication of global budgets by model count. Provider rejection remains authoritative; other clients' usage cannot be inferred locally.

The minimal release has no new numeric model-specific local ceilings unless the human explicitly approves supplied values and window semantics. If such a guard is configured, only a model-specific denial can advance to another approved model, with global budget still available. Global-cap or unknown-state denial never advances. Missing required model-limit data must not imply unlimited permission.

Existing token limits are pre-request admission checks against recorded consumption; the next response's exact tokens are unknown. Preserve those values and checks, including thinking totals, and stop further attempts when any is reached. Do not claim this is a hard pre-generation token reservation: one successful response can cross a token threshold, a pre-existing limitation. Strict total-token preallocation/output budgeting would require a separate explicitly approved design. Zero tokens for completed HTTP errors remains the existing accounting convention, not proof that Google charged none. The zero-dollar requirement relies on verified Free-tier project controls, not these counters.

### Observability and error surface

Keep Proposal 3 redaction and log-size bounds. Add cycle fields `geminiModelAttempts` (actual dispatch count), `geminiFallbacks` (forward transitions, including approved model-only skips), `analysesUsingFallbackModel` (validated analyses produced by a non-primary model), and `geminiRequestsByModel` (at most three approved keys and dispatch counts). Count attempts on failure as well as success; avoid process-global accumulators and reset all counters for each cycle. A typed callback/context from Worker/local composition carries events; observer failure must not cause a retry or duplicate provider call.

Final per-story diagnostic: at most three records `{model, attempts, reason, httpStatus?}` plus one terminal reason; enums only for reasons, maximum serialized error 1,000 characters before existing scheduled-summary redaction/truncation. Distinguish unavailable, model quota, shared/unknown quota, not-served, local-global cap, local-model cap, semantic failure and accounting uncertainty. Never copy raw provider responses/messages, prompts, snippets, output, keys or email addresses into these fields. Approved model IDs are safe. No per-URL metrics or new endpoint.

### Bounded Builder scope after approval

1. Reverify baseline/cleanliness and recorded human approval; resolve historical replay closure without rewriting Analyst evidence. Follow the existing experimental-branch governance; this task creates no branch.
2. Add static `src/config/geminiModels.ts`; implement the forward-only loop and pure classifier in `src/tools/llm/gemini.ts` (a small sibling classifier only if needed). Preserve endpoint, input/prompt, schema and one key.
3. Update `src/services/geminiUsageTracker.ts`, `geminiUsageGuard.ts`, `d1GeminiUsageStore.ts`, `localJsonGeminiUsageStore.ts`, and the single proposed migration for model attribution and safe admission/settlement. Do not touch discovery/notification tables.
4. Update `src/services/radarRuntimeConfiguration.ts`, `src/services/monitor.ts`, `src/worker.ts`, `src/types/index.ts`, and only if needed `src/tools/llm/types.ts` / `src/services/analysisAgent.ts` for cycle context and successful-model metadata. No prompt/validation weakening, ranking or replay changes.
5. Tests: `test/geminiUsageGuard.test.ts`, `test/d1Adapters.test.ts`, `test/localJsonUsageStores.test.ts`, `test/analysisAgent.test.ts`, `test/monitor.test.ts`, `test/workerConfiguration.test.ts`; small new classifier/config tests as needed. Update fixtures for the added usage field and settlement interface.
6. Documentation after approval: AGENTS.md provider invariant (explicit governance approval), PROJECT_STATE.md, README.md, plan.md P0 model-fallback exceptions, this plan and Builder-owned DAILY_SUMMARY/CHANGELOG. Analyst owns the independent review. Describe deprecated GEMINI_MODEL in operator docs; no Cloudflare variables/quotas changed by implementation. Local example configuration may be updated to remove that obsolete selector after approval.
7. Run inspected offline test/build/Worker typecheck scripts and diff checks. No live test scripts, remote migration, production configuration, secret changes, deployment, push/merge, P5, SDK/provider replacement, key rotation or new dependencies are authorized by this architecture.

### Acceptance and Analyst focus

1. Primary succeeds: exactly one dispatch, same valid AgentAnalysis, no secondary. Secondary/tertiary success retains original source identity and all validators; first success stops the chain.
2. A fixture with confirmed model-specific 429 advances once, with no same-model retry. Bare/ambiguous/shared/billing/mixed 429 stops. Unknown quota dimensions and raw-message spoofing cannot grant fallback.
3. 503 retries exactly three times after the initial attempt, fixed 5-second delays when budget permits, then advances; budget denial interrupts before another fetch. No backward transition or reset. Contradictory/auth/policy metadata fails terminally.
4. Documented exact-model-not-served reason advances only if its allowlist is justified; bare 404, typo, permissions or unrecognized reasons stop.
5. Auth/key/permission/request/schema/safety errors, 500, timeout and network ambiguity never hop models. Successful malformed JSON, invalid usage, empty output, invalid relevance or invalid analysis fails once with no stored partial discovery and no semantic retry. Original title/URL preservation remains identical for every model.
6. All-model availability exhaustion produces one logical story failure; monitoring proceeds through its current per-story semantics without a full-cycle retry. Test structural 12/48 bounds with isolated synthetic high-budget fixtures, and separately prove current production limits allow at most five total attempts, including rollover and prior consumption. Never change production ceilings to reach a test path.
7. `analysesAttempted` counts stories, maximum four, irrespective of provider attempts; provider counters include failed dispatches and exclude local denials/reservations not dispatched.
8. Every admitted dispatched request has one model-attributed reservation; settlement cannot duplicate it. Test HTTP failure zero-token convention, thinking-inclusive success totals, per-model aggregation, legacy NULL/absent model, invalid rows and unknown-history conservative guards.
9. Inject failures before reservation, after reservation, during fetch, during settlement and during uncertainty writes; no later dispatch can occur with uncertain state. Race two admissions; only one proceeds. Crash/restart preserves the unknown latch. D1/JSON agree; rollback does not erase evidence. New code against unmigrated DB makes zero calls.
10. Global request/token limits cannot be evaded by switching models. Model-only local denial may advance only if explicitly configured/approved; global/unknown denial stops. No automatic clearing of usage state or fabricated per-model capacity.
11. Production selection rejects unapproved IDs; env values cannot select paid/preview/Pro/legacy models or another project. Missing approval blocks implementation/release. Tests verify the selection gate, not a claim that a mock proves real billing state.
12. Stored replay and known discovery paths produce zero Gemini calls. Fresh/replay ranking, normal threshold 7, P4 trust and label, deduplication, notification history, four-story digest and one email remain unchanged.
13. Full P0/P1/P2/P3/P4 and Proposals 1–3 regressions pass offline. Assert unchanged Brave/Resend call counts and zero OpenAI calls. Log tests inject hostile error bodies/secrets and verify bounded enum diagnostics and per-cycle reset.
14. Build, full offline tests, Worker typecheck, bundle-boundary inspection and diff checks pass; document all skipped checks. Independent Analyst reviews exact implementation, migration, approval provenance, caps and accounting before Architect disposition. No live deployment evidence may be inferred from tests.

### Remaining risks and approval boundary

Global request limit five sharply limits the practical reach of a three-model chain. P0 remains an upper retry budget subject to safety guards, not an entitlement to four calls. Multiple models can share an outage or quota. Availability, pricing and project entitlements can change; generic 429 bodies may yield no safe fallback. Model quality may differ despite identical validation. Existing token admission checks do not predict future token totals. Durable uncertainty intentionally sacrifices availability after ambiguous outcomes; recovery is not automatic. The previous replay REVIEW marker requires durable closure reconciliation before implementation. No claim is made that production is deployed at the fetched source commit.

Architect recommendation: approve this bounded design conditionally, obtain the explicit project/model and governance approval above, then issue one Builder task. Architecture readiness does not mean implementation readiness or permission to call any provider.

---

## Self-improvement Proposal 1 — bounded durable notification replay

Architecture status: REVIEW. The human approved the 72-hour window, immutable activation cutoff `2026-10-06T16:00:00Z`, broader recent-unnotified semantics, and current-policy P4 replay. Builder implementation is ready for independent review; GOV-001 below remains completed historical evidence.

### Verified baseline and architecture-only scope

- On 2026-10-06, `git fetch origin` succeeded and freshly fetched `origin/main` was exactly `e4606faef42e6aff1ba66313c1c0f97d7fc31df2`, as required. No advanced main was found.
- During the architecture-only phase, the checkout was `codex/partial-brave-search-failures` at `7416cb551d08b2444f3aac952dfcbce752695bac`; inspected source, tests, migrations, `plan.md`, and PROJECT_STATE had no diff from that authoritative main. The later human-authorized Builder phase created the Proposal 1 branch recorded below.
- Read the operating contract, role guide, completed governance plan/review, project state, P0–P5 plan, monitoring/notification flows, D1/JSON history adapters, types, migrations, and relevant existing tests. The governance review is historical GOV-001 evidence, not a review of this proposal. Proposal 2 partial-search failure handling and Proposal 3 bounded scheduled summaries are present in the inspected source.
- During that architecture-only phase, only this plan changed. The later human approval authorized the bounded implementation and documentation changes recorded in the Builder handoff; it did not authorize a migration, production configuration/secret change, merge, deployment, or provider execution.

### Root cause and durable eligibility

`recordDiscovery()` stores a validated completed analysis before notification. `notifyDigest()` filters to `status === "new"`; subsequent discovery of the same URL returns `duplicate`. Monitor Phase 3 also runs only when current search processing produced items. Thus an analyzed discovery with no successful email record can be stranded permanently.

Use durable stored analysis plus absence of normalized-URL/email notification history, not rediscovery or a fabricated `new` status. A new delivery-candidate type separates delivery origin from discovery processing:

```ts
type DeliveryCandidate = {
  discovery: StoredDiscovery;
  origin: "fresh" | "replay";
};
```

Keep DiscoveryProcessingResult's existing new/duplicate meanings. An ordinary duplicate does not automatically become deliverable. Only a bounded durable replay lookup admits a prior discovery, and duplicate search results do not cause re-analysis.

### Product approval: window and activation cutoff

Preferred replay window: **72 hours** from immutable `firstSeenAt`, which the current adapters write only when a completed analysis is first inserted. Cron is daily at 08:00 UTC. This normally allows at least two subsequent daily opportunities despite modest timing drift, without retaining a week's backlog. A 48-hour alternative favors freshness but offers fewer recovery opportunities around scheduling delays.

Do not use `lastSeenAt`, which is refreshed on rediscovery; do not reset expiry after failed sends. Do not claim firstSeenAt is a separate analysis-completion column: it is the existing persistence timestamp used as that boundary. Future reanalysis is outside this design.

Capture a single cycle-start UTC instant T before searches. Define cutoff = max(T minus approved window, replayNotBefore). Query **cutoff <= firstSeenAt < T**. Lower bound is inclusive; upper bound is exclusive. Canonical UTC ISO strings are required, with adapter validation and injected clocks in offline tests. Invalid/future timestamps are not eligible and invalid persistence must not silently produce an empty-success result.

Require an explicit immutable UTC `replayNotBefore` approved with activation, stored in reviewed provider-neutral application policy, not recomputed at startup and not based on lastSeenAt. This excludes discoveries from before activation even if they otherwise fit the window. The trade-off is intentional: this first release does not recover historical pre-activation failures. Any backfill needs separate approval.

Approval must cover: 72h (or explicitly selected 48h), exact activation cutoff, normal and P4 replay, and delivery of recent unnotified items regardless of whether they were previously attempted or merely lost a digest slot. Existing data cannot distinguish these cases; do not claim "failed-send-only" selection.

Suggested human approval:

```text
PROPOSAL_1_REPLAY_POLICY
status: APPROVED
windowHours: 72
replayNotBefore: <explicit UTC ISO timestamp>
includeUnattemptedRecentUnnotified: true
allowCurrentPolicyP4Replay: true
acceptedAmbiguity: provider acceptance without persisted history may duplicate delivery
approvedBy: <human owner>
```

Placeholders are not activation values. Missing/invalid policy disables replay, not normal fresh delivery. Builder implementation waits for this product/governance approval; architecture readiness does not activate it.

### Persistence interface and bounded lookup

Prefer extending the existing discovery interface with a bounded recent query, followed by the existing provider-neutral notification lookup. Do not introduce a retry table, delivery-attempt table, or provider-specific state.

```ts
listRecentDiscoveries(options: {
  fromInclusive: string;
  beforeExclusive: string;
  limit: number;
}): Promise<{ discoveries: StoredDiscovery[]; truncated: boolean }>;
```

- Use a fixed replay scan limit of **100**, enforced by adapters (valid limit range 1..100), and no pagination/refill loop within a cycle. The application policy supplies a finite positive interval no larger than the approved window.
- Sort by firstSeenAt DESC, then normalizedUrl ASC using deterministic binary/lexical ordering. Return defensive copies of validated complete analyses.
- D1 uses bound parameters: `WHERE first_seen_at >= ?1 AND first_seen_at < ?2 ORDER BY first_seen_at DESC, normalized_url ASC LIMIT ?3`, with limit + 1 capped at 101 to detect truncation. Do not call the existing unbounded listDiscoveries() in production replay.
- For each returned normalized URL, use getNotificationRecord(url, "email") and exclude any existing record; each point query is keyed by the existing composite primary key. Recheck notification history for the final candidate pool immediately before selection/send. Total checks are bounded by the 100-row replay pool plus at most four fresh analyses; no bulk notification-history load is needed in D1.
- JSON implements the same timestamp filtering, ordering, limits, truncation, copying and validation using its existing whole-file persistence model. Return size is bounded; JSON file parsing itself is not constant-space or a bounded database scan. It remains a local adapter, not the Worker persistence backend. Do not claim a LIMIT bounds storage scan cost.
- A D1 NOT EXISTS join could exclude sent items before LIMIT, but it couples discovery lookup to notification storage. Defer it: at four analyses per daily cycle, 72h is normally about twelve records, comfortably below 100. If the cap is reached, report truncation; do not fetch unlimited history. Delivery guarantees are conditional on scan/slot bounds, not eventual delivery of every imported record.
- Existing discoveries and notifications columns/primary keys suffice. **No D1 schema migration required.** There is no first_seen_at index today, so D1 may scan/sort the table even with bounded output. An index is a separately measured optimization, not a prerequisite or hidden migration.

### Monitoring and notification integration

1. Capture T once. Load replay candidates from durable discovery state, apply time/activation bounds, and exclude successful email history. This requires no Brave result and no Gemini call. Persistence read failure aborts the cycle safely rather than bypassing history; missing production persistence is not treated as empty history.
2. Preserve existing search and analysis behavior: up to ten guarded Brave requests, up to four new analyses, P0 retry rules, P2 quota behavior, and current pre-analysis P3 ordering. Replay does not enter discoveryProcessor/analyzeSearchResult or consume an analysis slot.
3. At monitor Phase 3, merge fresh completed analyses and replay discoveries by normalizeDiscoveryUrl identity. Prefer the fresh-origin representation when both exist; otherwise repeated replay/duplicate occurrences count once. Do not relabel old discoveries as `new` or count them as new discoveries/results processed.
4. Invoke the one digest selection path even when there are no fresh processed items but replay candidates exist. Recovery works with successful empty Brave results, quota-stopped discovery, and partial-search failures that otherwise allow the cycle to reach notification. Preserve Proposal 2's all-search-failed/no-usable-results abort and fatal persistence aborts: these cycles do not deliver replay. This proposal does not turn failed cycles into notification-only runs or add full-cycle retries.
5. Recheck durable notification history and discard already-sent candidates. Candidate age/provenance is admitted by the monitoring delivery boundary; normal relevance is a separate pure score >= 7 check. Adapt the digest API explicitly for DeliveryCandidate; preserve the legacy single-story API's restrictions unless deliberately routed through the same validated boundary. Do not simply remove every status check from isNotificationEligible().
6. All eligible fresh and replay normal candidates share one pool, ranked by existing compareDiscoveryPriority() without changing stored relevance or P3 bonuses. Fresh candidates precede replay only as stable input order when the comparator ties; retain current fresh order and deterministic replay order. Take at most four. No replay slot reservation or extra email.
7. Any eligible normal replay candidate suppresses P4 fallback just like a fresh normal candidate. If the combined normal pool is empty, consider below-threshold fresh/replay candidates passing the CURRENT exact-host source-trust policy. Rank with the same comparator, take up to four, and preserve the `It could be relevant` label. Do not cache trust approval on the discovery; removal from the registry blocks later fallback replay. Do not pad a normal digest with fallback items.
8. Use the existing single-send/per-story recording path. One failed send ends that cycle's delivery attempt; no same-cycle retry, next-candidate send, or second digest. Candidates remain in durable discovery state for a later scheduled cycle within the window.

### Delivery guarantee and ambiguity

- Recovery does not depend on Brave rediscovering the URL. It depends on a later scheduled cycle reaching delivery while the discovery is in-window, inside the bounded scan, policy-eligible, and selected among four slots.
- A normalized URL + email record always excludes the story, for normal and fallback delivery. Successful replay writes the ordinary notification record. Do not create separate replay notification identity.
- Provider acceptance is not confirmed inbox delivery. A successful provider response followed by history-write failure can leave no durable record; replay can then duplicate an already accepted email. The existing schema cannot distinguish this from genuine failure or an unattempted story. Preserve and explicitly disclose the accepted send-before-record ambiguity, including partial per-story recording. Do not advertise exactly-once delivery, rollback accepted email, or retry immediately.
- Provider errors with ambiguous acceptance carry the same residual risk. Concurrent cycles may also race between history checking and sending; this task adds no new locks/idempotency system and does not claim to solve that pre-existing race.
- Permanently failing candidates age out by firstSeenAt. Higher-ranked items may repeatedly occupy slots and lower-ranked items may expire unsent; preserve P3 ordering rather than introducing retry fairness, attempt counters or backoff.

### Minimal observability

Extend MonitoringCycleResult and the existing bounded scheduled summary with aggregate counts for replay candidates considered, replay candidates policy-eligible, fresh stories sent, replay stories sent, and a boolean replayLookupTruncated. Define considered as the loaded in-window rows; expired/out-of-range rows are excluded in persistence and are not counted by extra scan queries. No claim of a known number of truncated rows.

Count delivery candidates once by normalized identity, not once per duplicate search result. Preserve existing search/analysis/outcome fields and their semantics; notification totals must include replay-only sends. Count a story as sent only when the existing success/recording path confirms it; on post-send persistence failure report the bounded failure and do not invent sent counts. Do not add URL/content, publisher names, credentials, or unbounded error arrays to scheduled logs. Preserve Proposal 3 redaction and caps. No new endpoint or monitoring service.

### Likely later Builder files

- `src/services/discoveryHistoryCore.ts`, `discoveryHistory.ts`, `d1DiscoveryHistory.ts`: bounded query contract/adapters.
- New `src/config/notificationReplay.ts`: approved window, activation cutoff, scan bound; no secret or Cloudflare variable.
- `src/services/monitor.ts`, `notificationEligibility.ts`, `notificationOrchestrator.ts`: explicit delivery candidates, shared pool, current P4 policy, single send.
- `src/types/index.ts`, `src/worker.ts`: delivery-origin types, replay counters and bounded scheduled summary. No route/Cron change.
- Tests: discoveryHistory, d1Adapters, notificationEligibility, notificationOrchestrator, monitor, workerConfiguration; new replay-policy tests if useful. Use local fixtures/mocks only.
- Existing notification-history interfaces/adapters should remain unchanged: normalized point lookup and successful record APIs already suffice. Update mocks if needed; do not change their semantics.
- After explicit human approval, update `AGENTS.md` to replace NEW-only notification eligibility with fresh-or-bounded-replay eligibility and make normal replay suppress P4; update `docs/self-improvement/PROJECT_STATE.md`, `plan.md` P1/P4 descriptions, `README.md`, and role-owned plan/summary/changelog/review records. No historical record rewriting. This architecture task changes only ARCHITECT_PLAN.md.

### Builder acceptance tests

1. Persist a completed score >= 7 analysis; fail mocked send; verify discovery remains and no success record is added. Advance to next scheduled day, return no matching Brave URL (including empty successful searches), deliver stored content, and assert no additional Gemini call for replay.
2. Successful replay creates the ordinary normalized-URL/email history record; later cycles and rediscovery never resend it.
3. Verify inclusive cutoff/exclusive T, 72h age, activation floor, invalid timestamps, and unchanged expiry after lastSeenAt touch. An old backlog cannot enter; a pre-activation story cannot replay. Freeze clocks in tests, not operational code.
4. Fresh and replay share four slots and P3 ranking; normalized URL variants cannot appear twice. Fresh-only behavior remains unchanged. A recent unattempted, previously displaced eligible story may replay as explicitly approved.
5. Normal replay suppresses all fallback; below-threshold replay needs current exact-host trust, retains original score and visible fallback label, and is excluded when trust is removed. Unknown normal sources at score >= 7 remain normally eligible.
6. Repeated failed sends produce at most one email attempt per cycle and expire; no second send to replacement candidates. Preserve the accepted provider-accepted/history-write-failed ambiguity in an explicit test without claiming exactly-once behavior.
7. Replay lookup and notification read failures abort safely. No silent fresh-send fallback after unreadable authoritative history. Missing required dependency fails clearly. More than 100 recent rows returns a bounded deterministic pool plus truncation, with no follow-up pagination.
8. D1 and JSON agree on canonical UTC boundary/order semantics and normalized identity. Verify query LIMIT and bounded point lookups. Existing tests/mocks must implement the new method rather than silently omitting replay capability.
9. P0, four-analysis cap, P2 Brave request/usage behavior, P3 ranking and P4 source integrity remain unchanged. Replay adds no Brave queries or Gemini calls. Preserve Proposal 2 all-search-failed rejection and partial-search behavior.
10. Replay-only cycles have accurate notification counts; logs remain capped and secret-free. Tests use mocked send/provider functions, never live monitoring/email calls. Run repository offline tests/build/type checks after inspecting scripts; no deployment or production migration.

### Decision and next-role boundary

The required product decisions were explicitly approved by the human owner. Builder implemented the bounded proposal from authoritative main `e4606faef42e6aff1ba66313c1c0f97d7fc31df2` on `codex/replay-unnotified-discoveries` and returns it for independent Analyst review. No P5, Gemini model fallback, Brave retries, full-cycle retries, provider replacement, quota change, production mutation, or deployment is included.

### Builder implementation handoff

- Added provider-neutral `DeliveryCandidate` origin, a canonical bounded recent-discovery query in JSON and D1, and reviewed replay policy constants: 72 hours, cutoff `2026-10-06T16:00:00.000Z`, maximum scan 100.
- The monitor captures one cycle-start instant, loads replay independently of Brave URL rediscovery, merges fresh and replay candidates by normalized URL, and invokes one existing digest path. Stored replay never invokes Gemini.
- Normal fresh/replay candidates share P3 ranking and four slots. A normal replay suppresses fallback; below-threshold replay rechecks the current exact-host P4 registry and retains the existing label.
- Successful ordinary notification history excludes later replay. Send failure writes no success record. The accepted provider-accepted/history-write-failed ambiguity remains unchanged.
- Worker composition explicitly supplies D1 discovery history for replay. Scheduled summaries add aggregate replay counts only and continue to exclude URLs, titles, content, email bodies, and secrets.
- No schema migration, retry table, provider call, quota change, Cloudflare change, deployment, P5 work, or production merge occurred. Validation evidence and final commit are recorded in the Builder-owned daily summary.

## Active Cycle

- Cycle ID: `GOV-001`
- Revision: `2`
- Status: `COMPLETE`
- Revision-2 baseline: `846392643d039f5304e118d7c87fb91c2a1aaed1`
- Original governance baseline: `3a6946fe07ea3838488c789cba4c69718b2ed328`

Valid plan statuses: EMPTY / READY / IN_PROGRESS / REVIEW / COMPLETE / BLOCKED.

`BLOCKED` means work is stopped because of an unresolved obstacle, rejection, or required human decision.

## Revision 1 History

- Builder commit: `71751da70ac15767fe1356dece3d719ee7f460a4`
- Commit message: `docs: define self-improvement handoff protocol`
- Branch: `self-improvement`
- Original baseline: `3a6946fe07ea3838488c789cba4c69718b2ed328`
- Analyst checkpoint: `846392643d039f5304e118d7c87fb91c2a1aaed1`
- Analyst result: `REVISE`
- Architect decision: `REVISE`

The completed revision-1 Builder and human handoff records that the push and validation succeeded; exactly the nine authorized governance documents changed; tests/build/typecheck were `not run — documentation-only scope`; and there were no production code/configuration, Cloudflare, Cron, provider-limit, deployment, provider-call, merge, or production-behavior changes. These execution facts are attributed to that handoff, not inferred from Git alone.

Revision-1 changed files:

- `AGENTS.md`
- `docs/self-improvement/PROJECT_STATE.md`
- `docs/self-improvement/ARCHITECT.md`
- `docs/self-improvement/BUILDER.md`
- `docs/self-improvement/ANALYST.md`
- `docs/self-improvement/ARCHITECT_PLAN.md`
- `docs/self-improvement/ANALYST_REVIEW.md`
- `docs/self-improvement/DAILY_SUMMARY.md`
- `docs/self-improvement/CHANGELOG.md`

The Analyst observed that `Без назви.md` was absent during review. The human owner later clarified that, after the revision-1 Builder handoff, they intentionally deleted it because it was empty and unrelated. Its absence is not a Builder failure, and there is no current or future preservation, checksum, or recreation requirement.

## Revision 2 Completed Correction

### Motivation

Resolve revision-1 governance evidence gaps without changing production behavior or broadening role authority.

### Current Problem

Revision 1 omitted `BLOCKED` from one valid-status declaration, retained completed-work placeholders, did not reconcile the later human deletion clarification, and did not distinguish historical revision-1 evidence from active revision-2 work.

### Proposed Correction

Correct the status declaration and durable handoff evidence in the five approved governance documents while leaving the Analyst checkpoint unchanged.

### Allowed Files

- `docs/self-improvement/ARCHITECT.md`
- `docs/self-improvement/ARCHITECT_PLAN.md`
- `docs/self-improvement/PROJECT_STATE.md`
- `docs/self-improvement/DAILY_SUMMARY.md`
- `docs/self-improvement/CHANGELOG.md`

### Out of Scope

`ANALYST_REVIEW.md`, all other files, production code/configuration, Cloudflare, Cron, provider limits, secrets, deployments, provider calls, merges, branches, history rewriting, and recreation of the deleted unrelated file.

### Risks

Conflating revisions could allow stale evidence to approve later work; incomplete states could make a blocked cycle appear actionable.

### Safety Constraints

Keep both historical commits separate, preserve role authority and production invariants, and make documentation-only changes on `self-improvement`.

### Required Validation

Inspect full and staged diffs; run `git diff --check` and `git diff --cached --check`; verify only the five allowed paths changed; verify `ANALYST_REVIEW.md` is byte-identical to the revision-2 baseline; check status declarations, revision separation, secrets, and production boundaries. Tests/build/typecheck: `not run — documentation-only scope`.

### Acceptance Criteria

All revision-2 requirements are recorded accurately, the reviewed Builder commit is accepted, no contradictory current statement remains, and no unauthorized file or operational action occurs.

### Builder Instructions

Implement only this correction at the stated baseline. Record the Architect transition REVIEW → READY and Builder transitions READY → IN_PROGRESS → REVIEW. Commit and push normally without rewriting either prior commit.

### Analyst Focus Areas

Verify the exact revision-2 commit and baseline, complete status list, revision separation, historical evidence attribution, deleted-file clarification, allowed paths, unchanged Analyst checkpoint, and absence of production effects.

### Human Approval

Explicitly approved for this bounded documentation-only revision-2 correction.

### Lifecycle and Decisions

- Architect-authorized revision-2 transition: REVIEW → READY.
- Builder transitions: READY → IN_PROGRESS → REVIEW.
- Historical Builder-side status: REVIEW.
- Revision-2 Builder commit: `ab23e28d6d7e8c3a2d55ded8f81a5ce53e4d7744`.
- Revision-2 Analyst checkpoint: `5137631f44f8888fd4690cad368592110bb396c1`.
- Revision-2 Analyst result: `PASS`.
- Final Architect decision: `ACCEPT`.
- Architect-authorized closure transition: REVIEW → COMPLETE.
- Final cycle status: COMPLETE.
- No further implementation, deployment, merge, or new cycle is authorized by this closure.

## Revision 2 Builder Handoff

- Changed files: the five allowed governance documents listed above.
- Validation: full/staged diff inspection, allowlist and Analyst-checkpoint verification, whitespace and secret checks passed; tests/build/typecheck: `not run — documentation-only scope`.
- Deviations: none.
- Blockers: none.
- Review target: `ab23e28d6d7e8c3a2d55ded8f81a5ce53e4d7744`; independently reviewed as PASS at `5137631f44f8888fd4690cad368592110bb396c1`.
