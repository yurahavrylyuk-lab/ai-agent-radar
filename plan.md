# AI Agent Radar — Architecture and roadmap

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

CROSS-PROVIDER ANALYZER FAILOVER is the next active build item. The [design](docs/superpowers/specs/2026-10-24-cross-provider-analyzer-failover-design.md) is human-approved; the five-task implementation plan is ready for review and no implementation has started. Gemini remains primary; only its fully exhausted three-attempt unavailable_503/confirmed_zero sequence permits one synchronous Luna attempt. Use the same PreparedBatch/validator and finalizer, with separate durable OpenAI admission/accounting. All other Gemini failures retain the existing delivery path.

Gemini latency validation (cycle 1 mixed) and deployed RSS BODY_LIMIT validation proceed in parallel. Retain the latency evidence window of three eligible dispatched cycles, initially at most five scheduled cycles; successful Gemini median <=45s and comparable total cycle <=110s remain targets, not SLAs. Full raw pool/aliases, replay and one-email finalization remain unchanged. No future natural result is claimed. Design approval, later implementation planning/review, and production migration/secret/spend/deployment permissions remain distinct.

## Authoritative roadmap

1. **CROSS-PROVIDER ANALYZER FAILOVER — NEXT ACTIVE BUILD ITEM:** Gemini → GPT-6 Luna → degraded digest; design approved; implementation plan ready; not implemented.
2. **GEMINI LATENCY RELIABILITY — DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED:** observation continues in parallel.
3. **RSS BODY_LIMIT RELIABILITY — DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION:** observation continues in parallel.
4. **THREADS**
5. **BRAVE + RSS + THREADS PRODUCTION PROOF**
6. **IDEMPOTENT EMAIL DELIVERY**
7. **CROSS-SOURCE EVENT DEDUPLICATION**
8. **TELEMETRY-DEGRADED CONTENT CONTINUITY**
9. **WORKERD CI RUNTIME GATE**
10. **LEGACY CLEANUP**
11. **CENTRALIZE PIPELINE LIMITS**
12. **P7 / RELEVANCE + FEEDBACK**
13. **FINAL STABILIZATION / V1.0**

Future items are separate bounded work after failover: official API Threads and combined proof; idempotent/ambiguous email; conservative event dedupe (uncertain/distinct preserve both); telemetry-degraded continuity; Workerd CI; legacy cleanup; limits; relevance/feedback; stabilization. No semantic dedupe or other future implementation in latency work. HTTP remains health-only; X disabled and0004 unapplied.

## Backlog/Plan Actualization Checkpoint

After every major merged/deployed/validated milestone, reconcile backlog.md, plan.md, docs/self-improvement/PROJECT_STATE.md, DAILY_SUMMARY.md and CHANGELOG.md before the next major roadmap item. Distinguish designed, implemented/tested, deployed, partially naturally validated and naturally validated. Record only actual evidence; historical entries retain their original context. Architecture acceptance never authorizes production mutation.
