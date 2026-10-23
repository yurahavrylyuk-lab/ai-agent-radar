# AI Agent Radar — Backlog

## Current authority — 2026-10-23

Production/main `4eb3cf049f222b1193d827b94b93f88196b03880`; Worker `04ffb752-0e5e-4e15-be37-26af010fa503`; deployment `309f3faf-72b7-4c09-bbd1-ad839efa2155`; production D1 `9fb545e2-2f43-4922-8b21-2d79a8de9556`. These are verified facts supplied by the human 2026-10-23 handoff, not a live production query by this task. Local main matches the supplied source.

Daily email guarantee, durable cycle telemetry, durable attempt telemetry and degraded email redesign are **COMPLETED / NATURALLY VALIDATED** (styling is deployed). Gemini Reliability V2 is **DEPLOYED / PARTIALLY NATURALLY VALIDATED**: timeout/accounting/fallback paths exercised, deployed 503 retry path not naturally exercised. Migration `0008_monitoring_cycle_observability.sql` is **APPLIED**; `0004_x_discovery.sql` remains intentionally **UNAPPLIED**, X disabled.

Natural cycle scheduled `2026-10-23T08:00:49.466Z`, completed `2026-10-23T08:03:06.914Z`; reported runtime ~136.4s (scheduled-to-completed wall interval 137.448s; execution start was not supplied). Brave healthy, 10/10, 50 results; RSS degraded, 2/4 feeds succeeded; 60 raw observations, 47 submitted candidates, 24,303 prompt bytes. One gemini-3.8-flash dispatch lasted 75.331s, ended timeout/transport_ambiguous, correctly no retry. Polished degraded email: one attempt, accepted.

## Authoritative active priority order

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

## Scope and completion criteria

1. **ARCHITECTURE_READY / HUMAN REVIEW:** recommended [optimized synchronous Gemini](docs/superpowers/specs/2026-10-23-gemini-latency-reliability-design.md): max 24 selected candidates, <=12 KiB prompt and documented low thinking. Preserve V2 accounting/full-pool fallback; defer background/model fallback. No runtime implementation in this phase.
2. **TODO after approved release:** 3–5 natural Cron cycles measuring completion/timeout rate, latency, payload, quality, accounting and one email; no manual cycles.
3. **TODO:** smallest bounded OpenAI/Cloudflare RSS body_limit fix; no blind limit increase.
4. **TODO:** official Meta API only, shared source pool, no per-source Gemini request.
5. **TODO:** natural combined-source proof after Threads release.
6. **DEFERRED:** idempotent email and ambiguous-send recovery; do not claim current send-before-history ambiguity is solved.
7. **DEFERRED:** conservative cross-source event dedupe: same event group, distinct preserve both, uncertain preserve both. Current URL/alias dedupe remains unchanged; no semantic matching now.
8. **DEFERRED:** telemetry-degraded content continuity; existing telemetry admission behavior remains authoritative.
9. **DEFERRED:** Workerd CI runtime gate; no workflow change now.
10. **DEFERRED:** retire/isolate legacy runMonitoringCycle and obsolete X code; migration 0004 remains unapplied.
11. **DEFERRED:** centralize limits without raising quotas.
12. **TODO later:** relevance and feedback.
13. **TODO last:** final stabilization/V1.0.

## Historical milestones

P0–P5 and Batch are completed historical milestones. The 2026-10-16 cycle proved one exact Batch response/four stories/one email. The 2026-10-20 RSS proof admitted GitHub/Chrome items; OpenAI/Cloudflare body_limit remains outstanding. The 2026-10-22 cycle proved daily raw fallback with two confirmed-zero attempts but lost exact429/503 class; V2 now preserves classes durably. Older V2 review-pending/0008-unapplied status is superseded by the current handoff, not current production authority.

## Backlog/Plan Actualization Checkpoint

After every major merged/deployed/validated milestone, reconcile backlog.md, plan.md, docs/self-improvement/PROJECT_STATE.md, DAILY_SUMMARY.md and CHANGELOG.md before the next major roadmap item. Distinguish designed, implemented/tested, deployed, partially naturally validated and naturally validated. Record only actual evidence; historical entries retain their original context. Architecture acceptance never authorizes production mutation.
