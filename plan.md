# AI Agent Radar — Architecture and roadmap

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

Brave (10 searches) + RSS → shared URL/alias/history dedupe and deterministic source interleaving → max 50 candidates / 32 KiB prompt → synchronous Gemini Batch → analyzed normal digest, or deterministic polished degraded digest, or truthful status_only → max 4 stories / one final email attempt.

V2 is production authority: same-model unavailable_503 plus durable confirmed_zero may retry to max 3 actual dispatches. Backoff1500–2000ms then3000–4000ms, one shared90s envelope, Gemini cutoff75s; >=10s after delay for retry admission. 429, timeout, transport ambiguity, invalid responses and accounting uncertainty do not retry. Each attempt has independent protected usage evidence. Applied0008 stores bounded cycle/attempt evidence; no prompt/content/raw errors. Old two-attempt429/503 and console-only descriptions are historical.

Analyzed Batch selections support scores1–10, label below7 `It could be relevant`; raw fallback has no invented score/analysis. Replay, notification dedupe and one-email guard stay unchanged. No promise of exactly-once delivery across provider acceptance/history ambiguity or platform termination.

## Active architecture phase

RSS BODY_LIMIT reliability is implemented and offline-tested on `codex/rss-body-limit-reliability`, awaiting independent review. The feature branch raises only the source-controlled global streamed-body cap to 1 MiB; feed count/order, five-item extraction, five-second timeout, structural limits, complete-document validation, sequential isolation, and no-secondary-fetch behavior remain unchanged. Local Workerd evidence covered three exact-limit tree-heavy successes around one streamed overflow with one active flow maximum. This feature is not deployed or naturally validated.

Gemini latency reliability is **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION** at source `223a1b90b9d64483b47717bd02a9d9c334fd3e0d`. The approved [latency design](docs/superpowers/specs/2026-10-23-gemini-latency-reliability-design.md) has a deterministic max-24 analysis subset after unchanged discovery/history, a <=12 KiB compact prompt, and `generation_config.thinking_level=low` on the existing synchronous Interactions path. Round-robin query/feed queues use a 3:1 Brave/RSS slot pattern and a soft two-per-host cap; the full original pool and aliases remain available for degraded fallback and notification evidence. Background execution and model fallback remain deferred. Acquisition, the current 75s cutoff, all V2 accounting protections, replay and one-email finalization are unchanged. Applied 0008 JSON accepts a bounded optional latency extension through compatible readers; no migration was added. Natural validation is the next step: first 3 eligible dispatched cycles, at most 5 scheduled cycles initially; goals median successful Gemini<=45s and comparable total cycle<=110s are not SLAs. Deployment does not establish that the timeout is fixed or success rate improved.

## Authoritative roadmap

1. **GEMINI LATENCY RELIABILITY**
2. **GEMINI LATENCY NATURAL PRODUCTION VALIDATION**
3. **RSS BODY_LIMIT RELIABILITY**
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

Future items are separate bounded work: RSS body_limit; official API Threads and combined proof; idempotent/ambiguous email; conservative event dedupe (uncertain/distinct preserve both); telemetry-degraded continuity; Workerd CI; legacy cleanup; limits; relevance/feedback; stabilization. No semantic dedupe or other future implementation in latency work. HTTP remains health-only; X disabled and0004 unapplied.

## Backlog/Plan Actualization Checkpoint

After every major merged/deployed/validated milestone, reconcile backlog.md, plan.md, docs/self-improvement/PROJECT_STATE.md, DAILY_SUMMARY.md and CHANGELOG.md before the next major roadmap item. Distinguish designed, implemented/tested, deployed, partially naturally validated and naturally validated. Record only actual evidence; historical entries retain their original context. Architecture acceptance never authorizes production mutation.
