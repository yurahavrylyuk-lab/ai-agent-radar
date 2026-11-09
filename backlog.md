# AI Agent Radar — Backlog

## 2026-11-09 — D1 release safeguard verification corrected

**D1 RELEASE SAFEGUARD = CORRECTED / OFFLINE-TESTED / AWAITING FOCUSED INDEPENDENT REVIEW.** The Analyst confirmed the allowlist itself but found that applying it to an empty database correctly fails at historical recovery migration `0007`; the earlier Builder application report was exploratory evidence and was not a committed regression test. The committed test now drives installed Wrangler against isolated local D1 persistence, applies `0001`, `0002`, `0003`, `0005`, and `0006`, inserts the exact historical row-22 precondition plus a preservation sentinel, applies `0007` through `0009`, proves only `0010` is pending, applies it once, verifies the ledger/schema/data, and proves a repeat is a no-op. `0004` and synthetic future `0011` are present in the disposable migration directory but remain unselected and unapplied. Focused migration tests pass 5/5 and the full suite passes 802/802. This is Builder evidence, not production-readiness approval; no remote migration or deployment occurred.

## 2026-11-06 — Idempotent Email Delivery locally merged; D1 release safeguard pending review

**IDEMPOTENT EMAIL DELIVERY = INDEPENDENTLY ANALYST-APPROVED / LOCALLY MERGED / NOT PUBLISHED / NOT DEPLOYED.** Local `main` merge commit `06dd71b82fc72fe9b2cc717c725fd79840149ee4` contains the approved implementation; its merge verification passed 800/800 tests. GitHub publication is not authorized, migration `0010_email_delivery_ledger.sql` is not applied, and production is unchanged. The next roadmap item remains **BRAVE REQUEST TIMEOUT + BOUNDED RESPONSE**.

**D1 RELEASE SAFEGUARD = IMPLEMENTED LOCALLY / AWAITING INDEPENDENT REVIEW.** The production D1 binding now explicitly allowlists migrations `0001`, `0002`, `0003`, and `0005` through `0010`, deliberately excluding `0004_x_discovery.sql`. Future migrations are excluded by default and require an explicit source-controlled allowlist extension plus review. Local Wrangler evidence proves the allowlist selects and applies `0010` without selecting `0004` or a synthetic future migration; no remote migration or deployment occurred.

## 2026-11-06 — Idempotent Email Delivery implementation complete offline

**IDEMPOTENT EMAIL DELIVERY = IMPLEMENTED / OFFLINE-TESTED / AWAITING INDEPENDENT ANALYST REVIEW.** The feature branch now contains the approved daily D1 ledger, exact frozen Resend request bytes and `daily-digest/YYYY-MM-DD` key, fenced three-slot recovery bounded by the first dispatch admission plus 23 hours, accepted-email history repair, bounded telemetry, and real Workerd crash/concurrency/restart proof. Offline evidence: focused aggregate 59/59, full suite 794/794, build, Worker typecheck, five Workerd harnesses, Wrangler dry-run bundle audit, and diff check all passed.

Migration `0010_email_delivery_ledger.sql` is **CREATED / TESTED LOCALLY ONLY / NOT APPLIED**. This branch is not merged or deployed and no natural production validation is claimed. Release requires separate migration, merge and deployment approvals; cut over on an untouched logical UTC day outside old in-flight invocations. Missing ledger state fails closed. Recovery assumes the same Resend account and recipient configuration, never resets stale ambiguity, and production rollback after activation is limited to ledger-aware versions.

Next active buildable item after independent review and the later release gates: **BRAVE REQUEST TIMEOUT + BOUNDED RESPONSE**. Do not begin it from this implementation task.

## 2026-10-27 — Threads production activation deferred; roadmap continues

**THREADS = IMPLEMENTED / OFFLINE-TESTED / PRODUCTION ACTIVATION DEFERRED / EXTERNALLY BLOCKED BY META BUSINESS REQUIREMENTS.** The official Meta Threads integration does not need to be rebuilt. Engineering and review completed the `threads_basic` OAuth/profile flow, demonstrated `threads_keyword_search` with the authorized tester account, created the reviewer demo website and App Review screencast, completed Meta OAuth, and returned the public tester post through the keyword-search test. Those tester-mode results are not approval for public cross-user production search. No Threads production activation occurred, and the production Radar gates remain disabled.

The human has paused the Meta business setup. Threads production activation and **BRAVE + RSS + THREADS PRODUCTION PROOF** move to a parallel deferred/external-gate track and no longer block buildable roadmap work. Brave + RSS remain the usable production discovery sources. When the external requirements are available, Threads resumes at activation/release—not implementation from scratch.

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

Idempotent Email Delivery remains **DESIGN AMENDED / AWAITING FINAL HUMAN APPROVAL**. Its existing architecture is preserved; no approval, implementation plan, SQL, or runtime implementation is claimed by this documentation update.

## 2026-10-26 — Idempotent email delivery design

**IDEMPOTENT EMAIL DELIVERY + AMBIGUOUS-SEND RECOVERY = DESIGN AMENDED / AWAITING FINAL HUMAN APPROVAL.** [Design](docs/superpowers/specs/2026-10-26-idempotent-email-delivery-design.md) proposes a durable daily D1 delivery ledger plus Resend idempotency keys, exact-payload recovery, bounded reconciliation and fail-closed expired ambiguity. Migration number0010 is reserved in the design only; no SQL or implementation plan exists yet. Production facts and pending natural validation are unchanged. Threads activation/configuration remains externally gated and untouched; offline delivery work is independent of that gate.

## 2026-10-26 — Threads discovery merged; production activation remains gated

**THREADS DISCOVERY = MERGED TO MAIN / OFFLINE-TESTED / INDEPENDENTLY REVIEWED / NOT CONFIGURED / NOT DEPLOYED.** PR #37 merged reviewed head `e8ee22d6ac389b48eb19882653ad42e49122dd30` into `main` as merge commit `032a24f7eb5cd10469250d9e5e37646619ed3736` at `2026-10-26T08:05:04Z`. CI `validate` passed, the final suite passed 763/763, and build, Worker typecheck, Workerd, Wrangler dry-run, and bundle audit passed. The source adds the disabled-by-default official Threads keyword collector, deterministic 12/6/6 three-source fairness, strict timestamp validation, bounded failure isolation, and the existing single analyzer/finalizer path. It adds no migration and does not activate X or `0004_x_discovery.sql`.

Production remains source `bd2a3220611e5992b226e6cf7c0f9ec0b92c18ac`, Worker `6a1dcef4-e5cc-414a-aa89-6bf194fa5b60`, deployment `f0dbb968-a9b0-4719-9614-035571b1e917`, at 100% traffic. Threads has no production configuration or secret and is not present in that deployed source. Release still requires Meta app/public keyword-search approval, a securely prepared production token, feature/public-approval configuration, an inspected undeployed Worker version, explicit deployment approval, a natural-cycle validation, and combined Brave + RSS + Threads proof.

The combined production proof is first in roadmap order but is **BLOCKED / WAITING ON THREADS PRODUCTION ACTIVATION**. The next immediately actionable engineering item while those external gates remain pending is **Idempotent Email Delivery**.

## 2026-10-25 — Threads discovery implemented offline

**THREADS = IMPLEMENTED / OFFLINE-TESTED / AWAITING INDEPENDENT ANALYST REVIEW / NOT DEPLOYED.** The approved official public-keyword collector is disabled by default and joins Brave + RSS before shared dedupe, bounded retention, the one Batch analyzer path, and the one finalizer. It adds no migration and does not touch X/0004. Meta public-search approval, token/scopes/expiry, secret/config provisioning, release version, deployment, and natural combined-source proof remain separate human gates. Next roadmap step after review/release is **Brave + RSS + Threads production proof**, followed by Idempotent Email Delivery.

## 2026-10-25 — Threads discovery design approved and planned

**THREADS = DESIGN APPROVED / IMPLEMENTATION PLANNED / NOT IMPLEMENTED.** [Design](docs/superpowers/specs/2026-10-25-threads-discovery-design.md): official public keyword-search collector into the shared Batch pool; [five-task TDD implementation plan](docs/superpowers/plans/2026-10-25-threads-discovery.md) ready for human review; no runtime implementation. Meta public-search approval/token setup remains an external release dependency. This entry supersedes older active-priority descriptions: Threads → Brave + RSS + Threads production proof → Idempotent Email Delivery → Cross-source Event Deduplication → Telemetry-degraded Content Continuity → Workerd CI Runtime Gate → Legacy Cleanup → Centralize Pipeline Limits → P7 / Relevance + Feedback → Final Stabilization / V1.0. Gemini Latency, RSS BODY_LIMIT and Cross-provider Analyzer Failover natural validation continue independently and do not block offline Threads work. Production state below is unchanged; this checkpoint is documentation only.

## 2026-10-25 — Cross-provider analyzer failover deployed

**CROSS-PROVIDER ANALYZER FAILOVER = DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION.** Existing Worker version `6a1dcef4-e5cc-414a-aa89-6bf194fa5b60` for source `bd2a3220611e5992b226e6cf7c0f9ec0b92c18ac` is at 100% traffic as deployment `f0dbb968-a9b0-4719-9614-035571b1e917` (`2026-10-25T08:31:00.482237Z`). The promotion performed no build/upload. Production D1 `9fb545e2-2f43-4922-8b21-2d79a8de9556` retains applied `0009_openai_fallback_usage.sql`; `0004_x_discovery.sql` remains intentionally unapplied. The deployed version binds `OPENAI_API_KEY` without recording its value; the final accounting read was zero rows/zero OpenAI dispatches. Cron remains `0 8 * * *`, health returned `AI Agent Radar worker ready`, and natural validation is still pending. X remains disabled.

## 2026-10-24 — Cross-provider analyzer failover implemented offline

**CROSS-PROVIDER ANALYZER FAILOVER = IMPLEMENTED / OFFLINE-TESTED / AWAITING RE-REVIEW.** The scheduled Batch coordinator preserves Gemini V2 as primary and admits exactly one synchronous `gpt-6-luna` Responses request only after the exact three-attempt `unavailable_503` / `confirmed_zero` Gemini proof, D1 reservation authority, configured OpenAI quotas, and the shared timing gate all pass. Luna accepts only the known-safe Responses reasoning auxiliary plus exactly one assistant `output_text`; analyzer success is published only after the authoritative shared Batch validator passes. Every other Gemini or Luna outcome follows the existing degraded/status finalizer.

Migration `0009_openai_fallback_usage.sql` is created but **NOT APPLIED**. `OPENAI_API_KEY` is **NOT PROVISIONED** and the feature is **NOT DEPLOYED**; production remains `a1024cb72b1e08c7433e0f954da81f6283f106d3`. Release requires independent review, a compatible-reader rollback gate for the optional telemetry extension, explicit migration/secret/spend/deployment approval, and later natural-cycle validation. Threads remains the next roadmap item after this release gate. Older design/planning entries below are historical where superseded.

## 2026-10-24 — Failover design approved and implementation planned

**CROSS-PROVIDER ANALYZER FAILOVER = DESIGN APPROVED / PLANNED / NOT IMPLEMENTED.** Human approved Gemini → one GPT-6 Luna → existing degraded delivery, with low reasoning, max_output_tokens=12,288 (including reasoning), and a pessimistic12,288+12,288=24,576 spending reservation. This is not a byte-to-token equivalence. [Finalized design](docs/superpowers/specs/2026-10-24-cross-provider-analyzer-failover-design.md); [five-task TDD implementation plan](docs/superpowers/plans/2026-10-24-cross-provider-analyzer-failover.md). Structured JSON shape supplements the authoritative shared Batch validator. Proposed0009 accounting migration is specified only in Markdown, not created/applied.

Failover remains the next active build item before Threads. Gemini Latency remains **DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED**; RSS BODY_LIMIT remains **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**. Production remains `a1024cb72b1e08c7433e0f954da81f6283f106d3`, Worker `6304ec6a-1fe0-425f-9e0c-3ebd7ba760fa`, deployment `cf8b0acd-1451-4706-b3c4-2040fbf1a60d`. Observation continues in parallel; no new natural evidence is claimed.

Documentation-only checkpoint: no runtime/test execution, migration creation/application, D1 access, provider inference/feed calls, credentials, push or deployment. Protected untracked SHA remains `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`. Plan approval and later release permissions remain separate. Earlier dated design-only entries are historical; the actualization checkpoint remains in force.

## 2026-10-24 — Cross-provider analyzer failover design

**NEXT ACTIVE BUILD ITEM: CROSS-PROVIDER ANALYZER FAILOVER — Gemini → GPT-6 Luna → degraded digest.** Architecture only, ready for human review; no implementation plan or runtime change. [Design](docs/superpowers/specs/2026-10-24-cross-provider-analyzer-failover-design.md). Natural Gemini/RSS observation continues in parallel, before and during offline failover work. Failover precedes Threads; all later roadmap items remain retained.

Production remains `a1024cb72b1e08c7433e0f954da81f6283f106d3`. Gemini Latency: **DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED**. RSS BODY_LIMIT: **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**. Local docs-only baseline `aaa0543ab1b37f4e64a52231136d9787d8845ca5` is preserved. No production verification was repeated here. Older dated sections below are historical where superseded.

## 2026-10-24 — RSS BODY_LIMIT production release

**Current authority:** RSS BODY_LIMIT Reliability is **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**. Exact runtime source `a1024cb72b1e08c7433e0f954da81f6283f106d3` is deployed as Worker version `6304ec6a-1fe0-425f-9e0c-3ebd7ba760fa`, deployment `cf8b0acd-1451-4706-b3c4-2040fbf1a60d`, created `2026-10-24T08:19:22.895645Z`, at 100% traffic. Cron remains `0 8 * * *`; D1 remains `DB` → `ai-agent-radar` → `9fb545e2-2f43-4922-8b21-2d79a8de9556`; health returned exactly `AI Agent Radar worker ready`. No migration was applied and `0004_x_discovery.sql` remains intentionally unapplied.

Gemini Latency Reliability remains **DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED**. Cycle 1 ran on the preceding runtime source `223a1b90b9d64483b47717bd02a9d9c334fd3e0d`; it met the 24-candidate, 12,288-byte prompt and 110-second total-cycle bounds but ended in three reviewed `unavailable_503` responses rather than a successful Gemini result. Continue the planned natural validation window without claiming full validation. The next natural cycle is also the first production validation opportunity for the 1 MiB RSS limit. Older entries below retain historical point-in-time status and are superseded where they conflict with this section.

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

## Authoritative active priority order

Parallel deferred/external-gate track: **THREADS PRODUCTION ACTIVATION + BRAVE + RSS + THREADS PRODUCTION PROOF**. Engineering is complete; activation is deferred until the recorded Meta/business and release prerequisites are satisfied.

1. **IDEMPOTENT EMAIL DELIVERY — NEXT ACTIVE BUILDABLE ITEM**
2. **CROSS-SOURCE EVENT DEDUPLICATION**
3. **TELEMETRY-DEGRADED CONTENT CONTINUITY**
4. **WORKERD CI RUNTIME GATE**
5. **LEGACY CLEANUP**
6. **CENTRALIZE PIPELINE LIMITS**
7. **P7 / RELEVANCE + FEEDBACK**
8. **FINAL STABILIZATION / V1.0**

## Scope and completion criteria

1. **TODO / ACTIONABLE:** idempotent email and ambiguous-send recovery; design ready and awaiting human approval; do not claim current send-before-history ambiguity is solved.
2. **DEFERRED:** conservative cross-source event dedupe: same event group, distinct preserve both, uncertain preserve both. Current URL/alias dedupe remains unchanged; no semantic matching now.
3. **DEFERRED:** telemetry-degraded content continuity; existing telemetry admission behavior remains authoritative.
4. **DEFERRED:** Workerd CI runtime gate; no workflow change now.
5. **DEFERRED:** retire/isolate legacy `runMonitoringCycle` and obsolete X code; migration `0004` remains unapplied.
6. **DEFERRED:** centralize limits without raising quotas.
7. **TODO later:** relevance and feedback.
8. **TODO last:** final stabilization/V1.0.

## Historical milestones

P0–P5 and Batch are completed historical milestones. The 2026-10-16 cycle proved one exact Batch response/four stories/one email. The 2026-10-20 RSS proof admitted GitHub/Chrome items; OpenAI/Cloudflare body_limit remains outstanding. The 2026-10-22 cycle proved daily raw fallback with two confirmed-zero attempts but lost exact429/503 class; V2 now preserves classes durably. Older V2 review-pending/0008-unapplied status is superseded by the current handoff, not current production authority.

## Backlog/Plan Actualization Checkpoint

After every major merged/deployed/validated milestone, reconcile backlog.md, plan.md, docs/self-improvement/PROJECT_STATE.md, DAILY_SUMMARY.md and CHANGELOG.md before the next major roadmap item. Distinguish designed, implemented/tested, deployed, partially naturally validated and naturally validated. Record only actual evidence; historical entries retain their original context. Architecture acceptance never authorizes production mutation.
