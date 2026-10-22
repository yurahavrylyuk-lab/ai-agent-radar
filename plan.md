# AI Agent Radar — Current architecture and roadmap

## Authority — 2026-10-22

Current production/main source `0df2c2399c76b4c7c518119b6a8511a300ef9aee`, Worker `6129de15-115c-4f61-9a3b-488d26baf301`, deployment `77fbd332-da4a-4862-9608-78cb963883f9`, from the human-verified 2026-10-22 handoff. No live production query was performed by this architecture task.

## Current production architecture

Brave + RSS → shared canonical URL/history dedupe and deterministic candidate interleaving → bounded pool (50 candidates / 32 KiB) → Gemini → success: normal digest; failure: deterministic degraded digest → status-only if no usable story payload → one final email attempt.

Normal analyzed delivery includes eligible replay and Batch-selected scores 1–10; selected scores below 7 retain `It could be relevant`. Degraded raw stories have no fabricated score/analysis. At most four stories total, unchanged history/no-resend and replay rules. Consume the one-email attempt before transport; provider acceptance/history uncertainty never triggers another send. This does not guarantee inbox delivery or survival of platform termination.

Current scheduled Gemini is normally one dispatch, maximum two on the same model only after reviewed confirmed-zero resource_exhausted_429/unavailable_503 and durable settlement. Backoff 1000–1500 ms, separate reservations, one shared 90-second deadline. Timeout/transport ambiguity is never retried. This coarse retry is DEPLOYED / PARTIALLY NATURALLY VALIDATED, not V2.

Daily delivery guarantee is COMPLETED / NATURALLY VALIDATED on 2026-10-22: four raw fresh stories, zero replay, one accepted degraded email, two confirmed-zero Gemini rows, no new ambiguity. Exact provider class is unavailable; low-score and timeout fallback were not exercised. Outage telemetry is deployed but not fully naturally validated.

RSS: four approved feeds; max5 feeds, 5 positions/feed, 5 seconds/feed, 256 KiB, no retry/redirect. Brave limits remain 10/day, 100/week, 350/month. X disabled/deprecated; 0004 unapplied. HTTP remains health-only. No manual monitoring endpoint.

## Target — Gemini Reliability V2 (not implemented)

Gemini attempt → durable bounded classification/accounting evidence → failure-aware retry decision → shared bounded budget → deterministic fallback → one email.

[Gemini Reliability V2 design](docs/superpowers/specs/2026-10-22-gemini-reliability-v2-design.md) is the design authority. It explicitly supersedes the coarse generic confirmed-zero 429/503 one-retry policy **as a target only**. Reviewed 503 may receive two retries (max3 dispatches); current model-specific 429 cannot establish a transient quota window and gets no retry. Unknown/malformed, timeout, transport, semantic and accounting failures stop Gemini. No model/provider fallback.

Proposed delays: 1500–2000 ms then 3000–4000 ms. One 90-second envelope with Gemini cutoff at +75 seconds leaves 15 seconds of finalization opportunity; at least 10 seconds must remain after delay before retry admission. Existing quotas/accounting remain authoritative.

Propose bounded cycle and attempt tables in existing D1, additive 0008 behind human migration approval; no overloaded accounting/notification fields. Confirmed-zero settlement and its durable class must be atomic before retry. Failed telemetry cannot trigger another email or hide uncertainty. Console summaries remain supplementary.

Priority 2 reuses existing dark table/inline-CSS email shell, truthful degraded banner, raw cards and safe 768-byte plain snippets. Normal analyzed/replay low-score semantics remain intact. No implementation plan is created in this architecture phase.

## Authoritative execution order

1. **GEMINI RELIABILITY V2**
2. **DEGRADED EMAIL VISUAL REDESIGN**
3. **PRODUCTION VALIDATION**
4. **RSS BODY_LIMIT RELIABILITY**
5. **THREADS**
6. **BRAVE + RSS + THREADS PRODUCTION PROOF**
7. **LEGACY CLEANUP**
8. **CENTRALIZE PIPELINE LIMITS**
9. **P7 / RELEVANCE + FEEDBACK**
10. **FINAL STABILIZATION / V1.0**

## Superseded historical policies

Legacy P0 multi-model retry and per-story analysis are not scheduled Batch authority. Earlier send-nothing-on-empty and one-dispatch-only scheduled descriptions are superseded by deployed daily delivery/coarse retry. V2 is only designed. X activation is deprecated; Threads, RSS body_limit, background execution, legacy cleanup and limit centralization remain separate work. Preserve historical specs/commits; do not treat their imperative instructions as current authority.

### Backlog/Plan Actualization Checkpoint

After every major merged, deployed or production-validated milestone, before beginning the next major roadmap item:

1. Update `backlog.md` with completed/implemented/deployed/naturally validated/partially validated/TODO/deferred status and actual priority.
2. Update `plan.md` with current architecture and target rules, superseding obsolete instructions explicitly.
3. Update `docs/self-improvement/PROJECT_STATE.md` only with verified facts and evidence provenance.
4. Reconcile `docs/self-improvement/DAILY_SUMMARY.md` and `docs/self-improvement/CHANGELOG.md` with the same milestone.
5. Do not begin the next major item while these five documents materially contradict each other or shipped behavior.
