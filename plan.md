# AI Agent Radar — Architecture and roadmap

## Current v1.0 authority — 2026-11-12

This section supersedes conflicting status/priority labels in the dated historical entries below; those entries remain audit history, not current execution authority. The human approved the finalized Email Feedback architecture and six-task Builder handoff; that bounded implementation is now local and awaiting independent Analyst review. Publication, merge and production remain separately gated.

Baseline `e97440a99d918e7df905e4b22f5560c9649d6620`: local main and live GitHub main verified equal. RSS Structural Subreasons is independently approved, merged, published and CI-verified per the human release record; source publication is independently verified here. It is NOT DEPLOYED. RSS Diagnostic Persistence and Idempotent Email Delivery passed the supplied November 11 natural-cycle evidence; old awaiting-review/unpublished/unapplied labels describe earlier milestones, not current release state. No fresh production or CI query is claimed here.

### Mandatory v1.0 order

0. **Release gate: RSS Structural Subreasons.** Before activation, designate and validate a rollback artifact whose strict snapshot reader accepts old and extended v1 RSS records and preserves email-ledger behavior. After any extended record exists, do not roll back to an old exact-key reader. Prefer the reviewed release or a narrowly corrected compatible release; if policy requires a distinct rollback artifact, approve a minimal reader-only backport first. No standalone rollback platform, history rewriting, telemetry deletion, or deployment in this task. Natural validation may be inconclusive if no structural failure occurs.
1. **Brave Request Timeout + Bounded Response — IMPLEMENTED / OFFLINE-TESTED / AWAITING INDEPENDENT ANALYST REVIEW.** The local feature branch adds the approved five-second complete-operation deadline, 256 KiB success and 16 KiB error-body caps, strict decode/parse, manual redirect rejection and fixed content-free failures. Existing budgets, successful-header accounting, queries, freshness and ranking remain unchanged. It is not published, merged, deployed or naturally validated.
2. **Email Feedback + Preference Learning MVP — IMPLEMENTED LOCALLY / OFFLINE-TESTED / AWAITING INDEPENDENT ANALYST REVIEW.** Newly prepared story emails carry bounded 30-day HMAC capabilities in their existing immutable frozen payload only; feedback tables store digests. GET/HEAD are read-only and POST requires exact-origin explicit confirmation. Current votes, ten-revision audit, 180-day bounded pruning, and a 90-day/latest-400 conservative ±0.5 same-lane equal-score tie-break are implemented without another provider call or eligibility change. `0011` is source-only and unapplied; production origin/signing/privacy/rollback/publication/release gates remain open.
3. **RSS Structural Failure Resolution.** Use new persisted predicate evidence for OpenAI/Cloudflare; do not assume the irrelevant-field hypothesis is either feed's cause. No parser/source change without evidence and bounded review.
4. **Cross-Source Event Deduplication.** Conservative same-event identification; uncertain matches and genuinely different announcements remain distinct.
5. **Bounded Failure-Cause Diagnostics.** Accepted Claude Platform proposal; closed, bounded, logs-only diagnostics. No extra provider dispatch, email route or D1 telemetry without separate approval.
6. **CI and Maintenance.** Combine Workerd CI Runtime Gate with the two accepted Claude proposals: nested test discovery correction and Node.js 24 TypeScript typings alignment. Verify compatible changes together; no separate large refactoring projects.
7. **Final Stabilization / v1.0.** Offline/full Workerd regression, explicitly approved releases, daily-email integrity, feedback persistence and preference-ranking verification, operations runbook and human acceptance. Target seven consecutive natural daily cycles with no unresolved critical delivery/accounting failures; record exact dates and evidence, never manufacture cycles. External integrations need not all be activated.

### Deferred, not v1.0 prerequisites

Threads activation until official Meta/business approvals (do not rebuild it); deprecated X/0004; full Claude Self-Upgrade Autopilot; major legacy refactoring; broad pipeline-limit restructuring; advanced/LLM preference optimization; telemetry-degraded content continuity unless new production evidence elevates it.

Claude Platform remains a proposal generator/backlog adviser, never implementation, main-change, merge or deployment authority. The three accepted proposals above are recorded from the explicit human brief; no separate proposal artifacts were located, so no invented proposal IDs or broader scope are attached.

### Design handoff

- [Brave bounds design](docs/superpowers/specs/2026-11-11-brave-request-bounds-design.md)
- [Brave bounds sequential TDD plan](docs/superpowers/plans/2026-11-11-brave-request-bounds.md)
- [Feedback/preference design](docs/superpowers/specs/2026-11-11-email-feedback-preferences-design.md)
- [Feedback/preference sequential TDD plan](docs/superpowers/plans/2026-11-11-email-feedback-preferences.md)

Email Feedback is the current independent-review cycle. Existing protected historical specification remains untracked and byte-identical. Human → Architect → Builder → independent Analyst → Architect → Human remains mandatory; publication and production permissions are separate.

## 2026-11-09 — Reproducible D1 release-safeguard verification

**Current verification authority:** the allowlist strategy is unchanged, while its evidence is corrected. A fresh empty database is not a valid predecessor for `0007_row22_exact_recovery.sql`; it must contain the exact reviewed historical row-22 state. A committed integration test now reconstructs that state using real local Wrangler migration execution and history recording, demonstrates `0010` as the sole pending approved migration after `0009`, and verifies that `0004` and synthetic future `0011` remain excluded. The previous Builder run is retained as exploratory evidence only. Passing Builder tests do not authorize or certify a production migration; focused independent review and separate human production authorization remain mandatory.

## 2026-11-06 — Local merge and explicit D1 migration release selection

**IDEMPOTENT EMAIL DELIVERY = INDEPENDENTLY ANALYST-APPROVED / LOCALLY MERGED / NOT PUBLISHED / NOT DEPLOYED.** Approved runtime history is present on local `main` at merge commit `06dd71b82fc72fe9b2cc717c725fd79840149ee4`; merge verification passed 800/800 tests. Migration `0010_email_delivery_ledger.sql` remains unapplied, and neither GitHub publication nor production deployment is authorized. **BRAVE REQUEST TIMEOUT + BOUNDED RESPONSE** remains next in execution order.

**D1 migration release rule:** Wrangler's production D1 binding uses an explicit source-controlled `migrations_pattern` allowlist containing `0001`, `0002`, `0003`, and `0005` through `0010`. It intentionally excludes deprecated X migration `0004_x_discovery.sql`; unlisted future migrations are not release candidates. Every future migration requires an explicit allowlist update, focused local selection/application proof, independent review, and separate human production authorization. The safeguard is implemented locally and awaiting Analyst review; it has not applied any remote migration.

## 2026-11-06 — Idempotent Email Delivery Builder milestone

**IDEMPOTENT EMAIL DELIVERY = IMPLEMENTED / OFFLINE-TESTED / AWAITING INDEPENDENT ANALYST REVIEW.** Scheduled delivery now derives one daily identity from authoritative ScheduledEvent UTC, freezes one exact provider payload, reserves and fences D1 state before transport, permits at most three actual-or-uncertain dispatch slots inside the immutable first-admission +23-hour window, and performs at most one Resend HTTP request per Worker invocation. Provider acceptance is monotonic; ambiguous outcomes remain recoverable only with the same key and bytes; accepted notification history is repaired independently without resending. Every normal, degraded, status-only and recovery path uses the same authority. Missing/invalid scheduled identity or unreadable ledger state fails closed.

Offline verification passed: focused aggregate 59/59, full suite 794/794, build, Worker typecheck, Workerd delivery/Gemini/OpenAI/RSS/Threads harnesses, Wrangler dry-run bundle audit and diff check. Migration `0010_email_delivery_ledger.sql` remains local and unapplied. No merge, deployment or natural validation is claimed.

Release gates remain separate: independent Analyst review; explicit merge approval; explicit migration approval; untouched logical-day cutover outside old in-flight invocations; same Resend account/recipient configuration; no stale-ambiguity reset; and rollback only to ledger-aware versions after activation. The next planned engineering item is **Brave Request Timeout + Bounded Response**.

## 2026-10-27 — Current authority: Threads activation deferred

**THREADS = IMPLEMENTED / OFFLINE-TESTED / PRODUCTION ACTIVATION DEFERRED / EXTERNALLY BLOCKED BY META BUSINESS REQUIREMENTS.** The implementation and its review evidence remain valid; Threads must not be rebuilt. Completed external engineering evidence includes the official API integration, demonstrated `threads_basic` OAuth/profile flow, demonstrated `threads_keyword_search` using the authorized tester account, reviewer demo website, completed Meta OAuth flow, successful tester keyword search returning the public tester post, and completed App Review screencast. Tester-mode success and App Review submission do not grant public cross-user production-search approval.

No Threads production activation occurred. The runtime gates remain disabled, and Brave + RSS remain the usable discovery sources while AI Radar development continues. Threads activation and combined-source production proof are a parallel deferred track that may re-enter at activation/release once Meta/business prerequisites exist.

### Threads production activation prerequisites

External Meta/business prerequisites:

- [ ] Create/configure an appropriate Meta Business Portfolio
- [ ] Have a business-owned custom domain
- [ ] Have a business website on that domain
- [ ] Complete Meta Business Verification as required
- [ ] Configure the verified business/domain information in Meta
- [ ] Complete App Review for `threads_basic`
- [ ] Complete App Review for `threads_keyword_search`
- [ ] Ensure required Meta Testing/API-call evidence shows complete, including the required `1 of 1` calls where applicable
- [ ] Obtain final Meta approval for public keyword-search access
- [ ] Provision a production Threads access token with the approved permissions
- [ ] Establish/document token expiry and rotation procedure

Only after those external prerequisites:

- [ ] Provision `THREADS_ACCESS_TOKEN` securely in Cloudflare
- [ ] Configure `THREADS_TOKEN_EXPIRES_AT`
- [ ] Set/verify `THREADS_PUBLIC_SEARCH_APPROVED=true` only after actual Meta approval
- [ ] Enable `THREADS_DISCOVERY_ENABLED=true`
- [ ] Create/verify the production Worker version
- [ ] Obtain explicit human deployment approval
- [ ] Deploy
- [ ] Run/observe a natural combined Brave + RSS + Threads production cycle
- [ ] Verify Threads candidate admission, dedupe, analyzer selection and one-email behavior
- [ ] Actualize project documentation from real production evidence

`THREADS_PUBLIC_SEARCH_APPROVED` MUST NOT be set to true based only on tester-mode success or App Review submission.

### Active engineering roadmap

1. **IDEMPOTENT EMAIL DELIVERY — NEXT ACTIVE BUILDABLE ITEM**
2. **CROSS-SOURCE EVENT DEDUPLICATION**
3. **TELEMETRY-DEGRADED CONTENT CONTINUITY**
4. **WORKERD CI RUNTIME GATE**
5. **LEGACY CLEANUP**
6. **CENTRALIZE PIPELINE LIMITS**
7. **P7 / RELEVANCE + FEEDBACK**
8. **FINAL STABILIZATION / V1.0**

Idempotent Email Delivery remains **DESIGN AMENDED / AWAITING FINAL HUMAN APPROVAL**. No design approval, implementation plan, migration SQL, or runtime implementation is created here.

## 2026-10-26 — Idempotent email delivery design

**IDEMPOTENT EMAIL DELIVERY + AMBIGUOUS-SEND RECOVERY = DESIGN AMENDED / AWAITING FINAL HUMAN APPROVAL.** [Design](docs/superpowers/specs/2026-10-26-idempotent-email-delivery-design.md) proposes a durable daily D1 delivery ledger plus Resend idempotency keys, exact-payload recovery, bounded reconciliation and fail-closed expired ambiguity. Migration number0010 is reserved in the design only; no SQL or implementation plan exists yet. Production facts and pending natural validation are unchanged. Threads activation/configuration remains externally gated and untouched; offline delivery work is independent of that gate.

## 2026-10-26 — Threads discovery source-control milestone

**THREADS DISCOVERY = MERGED TO MAIN / OFFLINE-TESTED / INDEPENDENTLY REVIEWED / NOT CONFIGURED / NOT DEPLOYED.** PR #37 merged reviewed head `e8ee22d6ac389b48eb19882653ad42e49122dd30` through a normal merge commit, producing `main` `032a24f7eb5cd10469250d9e5e37646619ed3736`. CI `validate` passed; final evidence was 763/763 tests plus passing build, Worker typecheck, Workerd, Wrangler dry-run, and bundle audit.

Lifecycle: **DESIGNED / PLANNED / IMPLEMENTED / OFFLINE-TESTED / INDEPENDENTLY REVIEWED / MERGED / NOT CONFIGURED / NOT DEPLOYED / NOT NATURALLY VALIDATED**.

The merged architecture adds an official, disabled-by-default Threads public-keyword collector with three fixed queries, strict timestamp validation, bounded acquisition/failure isolation, and deterministic Brave/RSS/Threads retention of 12/6/6 before the unchanged shared analyzer and finalizer. It adds no extra LLM or email path and no migration. Production still runs `bd2a3220611e5992b226e6cf7c0f9ec0b92c18ac`; Threads is unconfigured and absent from that deployed source.

Release remains gated on Meta app/public keyword-search approval, securely prepared production credentials, production feature/public-approval configuration, an inspected undeployed Worker version, explicit deployment approval, natural-cycle validation, and combined Brave + RSS + Threads proof. That proof is first in roadmap order but externally blocked; **Idempotent Email Delivery** is the next immediately actionable engineering item while activation is pending.

## 2026-10-25 — Threads discovery implementation handoff

**CURRENT EXECUTION STATE: IMPLEMENTED OFFLINE / AWAITING INDEPENDENT ANALYST REVIEW / NOT PUSHED / NOT DEPLOYED.** Tasks 1–5 of the approved plan are complete on `codex/threads-discovery-implementation`. The runtime remains gated off by default; no Meta credential, public-search approval, Cloudflare setting, migration, provider call, or production action was performed. Release order remains independent review → authorized publication/merge → external Meta approval/token setup → authorized undeployed version → authorized deployment → natural Brave + RSS + Threads proof.

## 2026-10-25 — Threads discovery design approved and planned

**THREADS = DESIGN APPROVED / IMPLEMENTATION PLANNED / NOT IMPLEMENTED.** [Design](docs/superpowers/specs/2026-10-25-threads-discovery-design.md) defines official public keyword search → shared Brave/RSS/Threads observations → bounded dedupe/selection → one PreparedBatch → existing Gemini/Luna admission → existing finalizer. [Five-task TDD implementation plan](docs/superpowers/plans/2026-10-25-threads-discovery.md) ready for human review; no runtime implementation; Meta public-search approval and token setup are external release gates. This entry supersedes older active-phase statements: Threads is next, followed by combined-source production proof and the remaining roadmap recorded in backlog.md. Gemini Latency, RSS BODY_LIMIT and Cross-provider Analyzer Failover natural validation proceed independently. No production state, runtime limits, migrations, credentials or deployment changed.

## 2026-10-25 — Cross-provider analyzer failover production release

**DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION.** The existing Worker version `6a1dcef4-e5cc-414a-aa89-6bf194fa5b60` for source `bd2a3220611e5992b226e6cf7c0f9ec0b92c18ac` was promoted to 100% traffic as deployment `f0dbb968-a9b0-4719-9614-035571b1e917` at `2026-10-25T08:31:00.482237Z`; no build/upload occurred. Production D1 retains the protected `0009_openai_fallback_usage.sql` schema and zero accounting rows/dispatches at release time. `0004_x_discovery.sql` remains intentionally unapplied. The deployed version binds `OPENAI_API_KEY` without recording its value. Cron remains `0 8 * * *`, the health endpoint returned `AI Agent Radar worker ready`, X remains disabled, and a natural scheduled cycle is still required before claiming failover-path validation.

## 2026-10-24 — Cross-provider analyzer failover implemented offline

**CROSS-PROVIDER ANALYZER FAILOVER = IMPLEMENTED / OFFLINE-TESTED / AWAITING RE-REVIEW.** The bounded production-target architecture is now represented in source: Gemini V2 remains primary; only an exact exhausted three-attempt `unavailable_503` / `confirmed_zero` sequence can reach one D1-admitted `gpt-6-luna` request. The Luna request reuses the same max-24 / 12,288-byte prepared Batch input, accepts only the known-safe Responses reasoning auxiliary plus exactly one assistant `output_text`, and publishes analyzer success only after the strict shared validator passes. No other Gemini failure can cross the failover boundary.

The source adds unapplied migration `0009_openai_fallback_usage.sql`, fixed optional quota variables, durable reservation/dispatch/settlement evidence and bounded optional telemetry. `OPENAI_API_KEY` is not source-required or provisioned. This is not deployed: production remains `a1024cb72b1e08c7433e0f954da81f6283f106d3`. Independent review plus separate migration, secret/spend and deployment authorization remain mandatory; rollback compatibility for the optional snapshot extension is a release gate. Threads follows this release gate. Older design/planning entries below retain historical context.

## 2026-10-24 — Failover design approved and implementation planned

**CROSS-PROVIDER ANALYZER FAILOVER = DESIGN APPROVED / PLANNED / NOT IMPLEMENTED.** Human approved Gemini → one GPT-6 Luna → existing degraded delivery, with low reasoning, max_output_tokens=12,288 (including reasoning), and a pessimistic12,288+12,288=24,576 spending reservation. This is not a byte-to-token equivalence. [Finalized design](docs/superpowers/specs/2026-10-24-cross-provider-analyzer-failover-design.md); [five-task TDD implementation plan](docs/superpowers/plans/2026-10-24-cross-provider-analyzer-failover.md). Structured JSON shape supplements the authoritative shared Batch validator. Proposed0009 accounting migration is specified only in Markdown, not created/applied.

Failover remains the next active build item before Threads. Gemini Latency remains **DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED**; RSS BODY_LIMIT remains **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**. Production remains `a1024cb72b1e08c7433e0f954da81f6283f106d3`, Worker `6304ec6a-1fe0-425f-9e0c-3ebd7ba760fa`, deployment `cf8b0acd-1451-4706-b3c4-2040fbf1a60d`. Observation continues in parallel; no new natural evidence is claimed.

Documentation-only checkpoint: no runtime/test execution, migration creation/application, D1 access, provider inference/feed calls, credentials, push or deployment. Protected untracked SHA remains `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`. Plan approval and later release permissions remain separate. Earlier dated design-only entries are historical; the actualization checkpoint remains in force.

## 2026-10-24 — Cross-provider analyzer failover design

**NEXT ACTIVE BUILD ITEM: CROSS-PROVIDER ANALYZER FAILOVER — Gemini → GPT-6 Luna → degraded digest.** Architecture only, ready for human review; no implementation plan or runtime change. [Design](docs/superpowers/specs/2026-10-24-cross-provider-analyzer-failover-design.md). Natural Gemini/RSS observation continues in parallel, before and during offline failover work. Failover precedes Threads; all later roadmap items remain retained.

Production remains `a1024cb72b1e08c7433e0f954da81f6283f106d3`. Gemini Latency: **DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED**. RSS BODY_LIMIT: **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**. Local docs-only baseline `aaa0543ab1b37f4e64a52231136d9787d8845ca5` is preserved. No production verification was repeated here. Older dated sections below are historical where superseded.

## 2026-10-24 — RSS BODY_LIMIT production release

**Current authority:** exact source `a1024cb72b1e08c7433e0f954da81f6283f106d3` is deployed at 100% as Worker `6304ec6a-1fe0-425f-9e0c-3ebd7ba760fa`, deployment `cf8b0acd-1451-4706-b3c4-2040fbf1a60d`, created `2026-10-24T08:19:22.895645Z`. RSS BODY_LIMIT Reliability is **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**; the bounded body limit is now 1 MiB while existing feed, timeout, streaming, complete-document, structural, sequential-isolation, and no-redirect/no-retry rules remain authoritative. Cron, D1 binding, and health were verified unchanged; no migration was applied and `0004_x_discovery.sql` remains intentionally unapplied.

Gemini Latency Reliability is **DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED**. The first natural cycle ran on preceding source `223a1b90b9d64483b47717bd02a9d9c334fd3e0d`, met the bounded workload and total-cycle targets, and safely degraded after three reviewed 503 responses; successful-Gemini latency remains unvalidated. Continue natural validation on the new source and record the source boundary explicitly. Older entries below are historical where superseded by this current authority.

## 2026-10-23 — RSS BODY_LIMIT reliability implementation

**RSS BODY_LIMIT RELIABILITY = IMPLEMENTED / OFFLINE-TESTED / AWAITING INDEPENDENT REVIEW.** The feature branch changes only global RSS `bodyBytes` from `262144` to `1048576`; complete-document XML validation, sequential feeds, and every other acquisition/parser limit remain unchanged. Production remains on the deployed `262144`-byte source until a later explicit release approval.

[Design amendment](docs/superpowers/specs/2026-10-23-rss-body-limit-reliability-design.md) and [TDD plan](docs/superpowers/plans/2026-10-23-rss-body-limit-reliability.md) are implemented with exact-boundary, streaming, cancellation, full-document, structure, and isolation tests plus a local Workerd sequential safety gate. Focused Node RSS tests passed 23/23; focused RSS/Batch/Worker tests passed 82/82; the full suite passed 713/713; build, Worker typecheck, Workerd, and Wrangler dry-run gates passed. No new migration.

Local docs-only main baseline353c718a146252be47a2d6fbf926fdfbf3e81598 is preserved as the parent of branch codex/rss-body-limit-reliability. Production remains source223a1b90b9d64483b47717bd02a9d9c334fd3e0d, Worker b8f02106-f558-43a2-a428-529b2051512f, deployment44a6b945-07ba-4154-877a-433949ce4e5f. **Gemini Latency Reliability = DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION.**

**Release hold:** no RSS deployment2026-10-23. First validate2026-10-24 natural Cron from exact deployed Gemini-only source223a1b90b9d64483b47717bd02a9d9c334fd3e0d; a later separate explicit human approval is required to deploy RSS. Building/testing/review and later authorized push/merge may precede that gate; merge alone is not deployment approval. Future Cron has not been claimed as completed.

Implementation and offline verification only; no feed/provider call, D1/migration action, push, PR, merge or deployment. Protected untracked design remains byte-identical and excluded. Permanent Backlog/Plan Actualization Checkpoint remains in force. Older entries below retain their historical context.

## Current authority — 2026-10-23

Production source `223a1b90b9d64483b47717bd02a9d9c334fd3e0d`; Worker `b8f02106-f558-43a2-a428-529b2051512f`; deployment `44a6b945-07ba-4154-877a-433949ce4e5f` created `2026-10-23T18:01:16.307406Z`; production D1 `9fb545e2-2f43-4922-8b21-2d79a8de9556`. Wrangler deployment metadata and the health endpoint were verified after release. Traffic is 100%, Cron remains `0 8 * * *`, and health returned `AI Agent Radar worker ready`.

Daily email guarantee, durable cycle telemetry, durable attempt telemetry and degraded email redesign are **COMPLETED / NATURALLY VALIDATED** (styling is deployed). Gemini Reliability V2 is **DEPLOYED / PARTIALLY NATURALLY VALIDATED**: timeout/accounting/fallback paths exercised, deployed 503 retry path not naturally exercised. Migration `0008_monitoring_cycle_observability.sql` is **APPLIED**; `0004_x_discovery.sql` remains intentionally **UNAPPLIED**, X disabled.

Natural cycle scheduled `2026-10-23T08:00:49.466Z`, completed `2026-10-23T08:03:06.914Z`; reported runtime ~136.4s (scheduled-to-completed wall interval 137.448s; execution start was not supplied). Brave healthy, 10/10, 50 results; RSS degraded, 2/4 feeds succeeded; 60 raw observations, 47 submitted candidates, 24,303 prompt bytes. One gemini-3.8-flash dispatch lasted 75.331s, ended timeout/transport_ambiguous, correctly no retry. Polished degraded email: one attempt, accepted.

## Deployed architecture

Brave (10 searches) + RSS → shared URL/alias/history dedupe and deterministic source interleaving → bounded raw pool (max 50 candidates / 32 KiB) → max 24 selected analysis candidates / 12,288-byte compact prompt → synchronous low-thinking Gemini Batch → analyzed normal digest, or deterministic polished degraded digest, or truthful status_only → max 4 stories / one final email attempt.

V2 is production authority: same-model unavailable_503 plus durable confirmed_zero may retry to max 3 actual dispatches. Backoff1500–2000ms then3000–4000ms, one shared90s envelope, Gemini cutoff75s; >=10s after delay for retry admission. 429, timeout, transport ambiguity, invalid responses and accounting uncertainty do not retry. Each attempt has independent protected usage evidence. Applied0008 stores bounded cycle/attempt evidence; no prompt/content/raw errors. Old two-attempt429/503 and console-only descriptions are historical.

Analyzed Batch selections support scores1–10, label below7 `It could be relevant`; raw fallback has no invented score/analysis. Replay, notification dedupe and one-email guard stay unchanged. No promise of exactly-once delivery across provider acceptance/history ambiguity or platform termination.

## Active architecture phase

Threads Discovery is complete in source control at merge commit `032a24f7eb5cd10469250d9e5e37646619ed3736`, but remains disabled, unconfigured, undeployed, and not naturally validated. Production activation is deferred by human decision and externally blocked by Meta business verification, App Review/public-search approval, credential, configuration, undeployed-version inspection, and human deployment gates. Combined-source proof cannot begin until those gates pass, but neither activation nor proof blocks the active engineering roadmap.

Idempotent Email Delivery is the next immediately actionable engineering item while Threads activation is externally blocked. Full raw pool/aliases, replay and one-email finalization remain unchanged until that separately approved work begins. No future natural result is claimed, and source merge does not authorize production configuration or deployment.

## Authoritative roadmap

Parallel deferred/external-gate track: **THREADS PRODUCTION ACTIVATION + BRAVE + RSS + THREADS PRODUCTION PROOF**. Resume from activation/release work—not implementation—after the recorded Meta/business prerequisites are satisfied.

1. **IDEMPOTENT EMAIL DELIVERY — NEXT ACTIVE BUILDABLE ITEM**
2. **CROSS-SOURCE EVENT DEDUPLICATION**
3. **TELEMETRY-DEGRADED CONTENT CONTINUITY**
4. **WORKERD CI RUNTIME GATE**
5. **LEGACY CLEANUP**
6. **CENTRALIZE PIPELINE LIMITS**
7. **P7 / RELEVANCE + FEEDBACK**
8. **FINAL STABILIZATION / V1.0**

Threads source implementation is complete, but production activation and combined-source proof remain separate human-controlled gates on the deferred track. Engineering proceeds with idempotent/ambiguous email work and the remaining ordered roadmap independently. Later items remain separate bounded changes: conservative event dedupe (uncertain/distinct preserve both); telemetry-degraded continuity; Workerd CI; legacy cleanup; limits; relevance/feedback; stabilization. HTTP remains health-only; X is disabled and `0004` unapplied.

## Backlog/Plan Actualization Checkpoint

After every major merged/deployed/validated milestone, reconcile backlog.md, plan.md, docs/self-improvement/PROJECT_STATE.md, DAILY_SUMMARY.md and CHANGELOG.md before the next major roadmap item. Distinguish designed, implemented/tested, deployed, partially naturally validated and naturally validated. Record only actual evidence; historical entries retain their original context. Architecture acceptance never authorizes production mutation.
