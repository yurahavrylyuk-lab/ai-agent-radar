# Email Feedback MVP — final security and implementation decisions

## Final architecture checkpoint — 2026-11-12

The human finalization request confirms the approved architecture, including signed tokens only in existing immutable frozen email payloads, digest-only feedback tables, strict-origin and exact-origin confirmation, and the stated learning/retention limits. This supersedes the design-approval-pending language in the original review below; that language is preserved as review history. The documented expired-token/backup retention and forwarded-link limitations remain explicit.

Architecture is finalized for the upcoming Builder handoff. This request authorizes one local documentation commit only, not execution of the six-task implementation plan. The exact deployment origin, Builder execution authorization, migration/allowlist and secret provisioning, platform query-log privacy proof, compatible rollback validation, independent implementation review and human release approvals remain separate gates. No production activation is authorized.

## Original review record

2026-11-12. Architect disposition: **HUMAN REVIEW — security decisions ready; Builder NOT authorized**. This focused record supplements the [design](../superpowers/specs/2026-11-11-email-feedback-preferences-design.md) and [six-task TDD plan](../superpowers/plans/2026-11-11-email-feedback-preferences.md); it does not redesign the feature or approve activation.

## 1. Baseline and compatibility

Verified local main, origin/main and live GitHub main: `9518c26d4224cf6c7d2e4ca1b6e4b8ba0d13e15b`. Initial tracked tree/index clean; no Git operation; sole untracked item is the protected historical specification. SHA-256 matches `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`. New local documentation branch: `codex/email-feedback-security-decisions`.

Brave approval/publication/CI success and unchanged Cloudflare production are supplied human release evidence. Publication head was independently verified; [CI run 43180898849](https://github.com/yurahavrylyuk-lab/ai-agent-radar/actions/runs/43180898849) could not be retrieved by the web reader, so CI success is not independently re-certified here. Older governance review-pending labels are historical, not evidence against the human release update. The historical GOV-001 Analyst review is not this feature's review.

Inspected current notificationOrchestrator preparation/recovery, emailDeliveryLedger freeze/restore, d1EmailDeliveryLedger reserve/reads, 0010 constraints, Worker fetch/scheduled separation, Wrangler config and migration inventory. Brave changed its transport, not these delivery integration points. Six tasks remain compatible: (1) capability primitives, (2) atomic D1 persistence, (3) frozen rendering, (4) confirmation routes, (5) deterministic preferences, (6) integrated verification. Only the browser-policy defect below needs a small plan/spec amendment.

## 2. Frozen-token exception — recommended, NOT approved

Permit raw signed links only inside existing immutable frozen HTML/text required for exact Resend recovery. Feedback tables retain capability digests, not tokens; no separate archive, duplicate HTML, analytics or log copy. Generate before freeze; retry/recovery uses stored bytes and original payload hash/key without re-signing, re-ranking or changing expiry. Concurrent preparation must use the winning stored reservation. This preserves current exact-payload and idempotency guarantees.

Residual risk: a reader of the database/frozen payload, its authorized backup/export, forwarded email or mailbox can obtain a bearer link usable until expiry. Current 0010 triggers prohibit changing non-null content_json and deleting delivery evidence: **30-day token expiry and 180-day feedback-table retention do not erase tokens from the immutable ledger or its backups**. Expired tokens lose authority but remain bytes. Approval must explicitly accept this existing-ledger retention consequence; do not promise automatic token erasure or change immutable ledger retention here. No recipient authentication is added. A deliberate actor able to submit the valid form can vote; scanner-safe GET is not a CAPTCHA or identity check.

## 3. Public endpoint and origin decision

Keep the existing Worker. GET/HEAD `/feedback` are read-only (including no pruning, last-seen writes or vote creation); POST `/feedback/confirm` is the sole feedback mutation. Unsupported methods on feedback paths fail; existing health behavior elsewhere and scheduled monitoring remain separate. No public handler calls a provider, sends mail or invokes monitoring.

Human must designate one stable HTTPS origin. Recommend existing Worker HTTPS origin if operationally suitable; no domain is invented. Require exact configured origin in signing audience, request URL and POST Origin; reject missing/null/cross-origin values, aliases/preview hosts and alternate ports. Never trust forwarded headers as authority. Origin is browser CSRF defense, not bearer authentication: a non-browser caller can forge it and must still prove both signatures and binding.

Retain HMAC-SHA-256 capabilities (30 days from immutable scheduled time), fixed keys/claims, ≤1,024-byte token, ≤2,048-byte URL, ≤4 KiB form body, 5-second body deadline and ≤16 KiB response. Retain ten-minute purpose-separated confirmation nonce bound to capability digest/rating/current revision; nonce expiry must not outlive capability validity. Require explicit form submission. No redirects, third-party resources, JavaScript auto-submit, CORS, arbitrary URLs or loggable request objects. Require no-store, nosniff and restrictive CSP including form-action 'self', frame-ancestors 'none' and base-uri 'none'. All token and nonce validity checks run again at POST.

**Narrow corrective decision:** use `Referrer-Policy: strict-origin` on confirmation responses instead of `no-referrer`. Fetch's non-CORS POST algorithm can serialize Origin as null under no-referrer, breaking the required ordinary form. strict-origin preserves same-origin HTTPS form Origin and strips path/query from Referer. Keep null-Origin rejection; do not weaken it as a workaround. Require an actual browser form test with synthetic tokens, inspecting Origin and Referer, not merely a Node request with manually fabricated headers. Privacy extensions that suppress Origin remain fail-closed with a clear retry-in-standard-browser message. See [Fetch Origin algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header) and [Referrer Policy strict-origin](https://w3c.github.io/webappsec-referrer-policy/#referrer-policy-strict-origin).

## 4. Logging/privacy gate before any live link

Source config enables persisted logs at sampling 1 and disables traces; it does not set query redaction. Installed Wrangler 4.135.0 schema supports `observability.redact_query_string` with default false. Cloudflare documents URL-bearing invocation logs and an option to redact query strings from logs/traces. Thus application error redaction alone is insufficient. Sources: [Workers invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs), [Worker observability API fields](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/).

Propose an explicitly approved future config change to `observability.redact_query_string: true`; retain useful scheduled diagnostics. Do not assume it covers every account/zone sink or all arbitrary console text. Disabling invocation logs alone is not proof of privacy either. No configuration is changed by this review.

Before activation, operator/Analyst must:

1. Inventory effective deployed observability, invocation logs, Issues/error reporting, tail consumers/live tail, trace exporters, Workers Logpush, zone HTTP logs/Logpush, security/WAF event records and any proxy/analytics integration for the chosen origin. Record applicable/inapplicable sinks, configured fields, retention and readers. Inspect dashboard/API overrides, not just source JSON.
2. Independently verify deployed query redaction and absence of request URL/body/Referer/token logging in application/error handlers. Preserve scheduled observability. Any sink storing full query or POST body must be redacted/excluded through supported controls or block activation.
3. Under separate authorization, use a non-authorizing unique canary in query and POST body on a representative isolated deployed fixture, then an approved harmless invalid-token probe on the exact production configuration before link issuance. No real capability, accepted-delivery fixture, vote, provider or email is used. Exercise GET/HEAD/POST, validation errors and applicable edge errors. Include a harmless control event proving each inspected sink actually received the test window; sampling/no-hit alone is not proof.
4. After documented ingestion delays, inspect raw exports/structured fields plus rendered messages in every applicable sink. No canary/query/nonce/body content may be retained. Keep only sanitized evidence, configuration/version identity and pass/fail, not copied request data. Re-test after observability/routing changes.

Unknown coverage or retained canary means **NO ACTIVATION** and a bounded privacy amendment; it is not permission to disable all monitoring or claim universal protection from one setting. Email clients and scanners still receive the original bearer link; no server policy can erase that exposure. No Cloudflare account query or canary probe was performed here.

## 5. D1, secret and atomicity requirements

0011 remains the next available migration number. Recheck before creation. Three proposed tables (immutable delivered-story bindings, current votes, bounded audit events) remain sufficient. Extend explicit migration allowlist only under future implementation approval; isolated history tests must select 0011 and exclude 0004/future unlisted files. No migration exists or is applied by this task.

Implement one bounded reserve batch for a new ledger row plus its ≤4 bindings. SQL constraints must abort on a partial/mismatched binding set; never publish a ledger row before separately writing bindings. Existing reserve error/response-loss handling must re-read the complete authoritative set and payload identity before dispatch. Losing concurrent prepares cannot attach metadata to a different winner. Preserve legacy rows without bindings and all existing ledger state/dispatch fences.

For votes, one conditional current-row mutation plus an audit trigger is a small viable choice. The WHERE/validation boundary must include accepted parent, exact payload/story binding, unexpired capability and expected revision. Audit insertion must occur only for an actual accepted transition; same-rating duplicate changes neither revision, timestamp nor event count. A stale different-rating revision fails; changed votes do not increment preference counts. Use primary/consistent authoritative reads for outcome classification, including committed-response-lost cases. An affected-row count alone is not the proof.

D1's binding batch rolls back on statement error, but a zero-row conditional statement is not necessarily an error: later SQL must not create an audit/binding after a failed condition. Test this explicitly. See [D1 batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). Do not introduce ad hoc JavaScript transactions or weaken existing 0010 triggers. Real isolated Workerd/D1 tests must cover partial failure, concurrent winner/loser, restart, lost responses and legacy reserve/recovery.

Signing material: a new dedicated random ≥256-bit HMAC key in Worker secrets, never a provider key; public key ID plus at most one retiring key, purpose-separated MAC inputs, fixed origin and version. No generated secret is recorded here. Retain verification keys until all issued links expire; freeze signed content once. Provisioning/rotation and compromised-key revocation require explicit operator authority. Emergency revocation intentionally invalidates affected links; it cannot rewrite frozen mail.

## 6. Rollback and preferences

Schema-only deployment before activation must prove the old ledger-aware Worker remains operational with additive tables. After issuing feedback links, ordinary rollback must retain valid signature/route support, atomic binding behavior, new and legacy frozen-payload recovery and required keys through expiry. Turning preference effects neutral is safer than reverting to health-only HTTP. Never drop 0011 or reset notification/delivery history as rollback. Any co-released RSS subreason data also requires its compatible strict reader; current old production is not automatically a valid rollback target. Emergency route shutdown for compromise must be explicit, accept broken links and preserve delivery evidence.

Learning parameters unchanged: 30-day capabilities; 90-day immutable-delivery-date window; latest 400 distinct stories; 180-day feedback-only retention with ≤20 expired delivery groups pruned per scheduled cycle; ≤4 cards/delivery; ten vote revisions; current vote only, never audit-event accumulation. Minimum five observations and absolute net difference ≥3 before a topic receives adjustment 0.5*(positive−negative)/total. Average across existing classified topics; unknown/raw topics neutral. No new taxonomy, fine-tuning, prompt instructions or analysis dispatch.

Preserve baseline candidate ordering and eligibility exactly except approved tie reordering: group already-admitted analyzed items by existing lane and identical original relevance; permute only their occupied positions by preference then original index. Do not globally sort all items by score and thereby change baseline replay ordering. Profile failure is neutral; history or ledger failure remains fail-closed. Original Gemini relevance, normal/fallback gates, dedupe, raw ordering, quotas and frozen recovery stay unchanged. Existing Batch-versus-generic-governance eligibility discrepancy remains documented in the spec and must not be resolved by changing feedback eligibility.

## 7. Approval and exact Builder handoff

Decisions ready for human review; **not READY to execute the six tasks yet**. Required human choices:

- Approve the frozen-payload-only token exception, including durable expired-token bytes/backups and forwarded-link risk.
- Approve the existing-Worker HTTP boundary, strict-origin correction, chosen HTTPS origin and corresponding narrow governance wording update.
- Approve the six-task local implementation scope, migration/allowlist source changes, signing configuration and unchanged learning/correction/retention parameters. Name the authorized Builder branch and baseline.
- Keep secret provisioning, live privacy verification, publication/merge, production migration/deployment and activation separately gated. No live links before privacy and compatible rollback evidence pass.

Once these design/implementation decisions are explicitly recorded, Builder may execute the existing six tasks sequentially on the authorized branch, using this record's one browser correction and atomicity/logging acceptance clarifications. No separate service/auth platform, extra LLM call, broader parser/Brave/accounting change or seventh feature. Require meaningful RED → GREEN, full regression/typecheck/build/dry-run, real D1 restart/concurrency, browser scanner/form tests, immutable-payload replay and one independent Analyst review of the exact commit. Final Architect acceptance precedes human integration/release decisions.

Review limitations: source inspection and official documentation only; no new runtime tests, real browser execution, production config/D1 access or live privacy validation. Changes in this review are documentation-only. The design can proceed to human decision with the bounded correction; unresolved permissions and deployment evidence are explicit gates, not assumed approvals.
