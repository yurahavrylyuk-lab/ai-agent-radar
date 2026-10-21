# AI Agent Radar — Backlog

## Current authority — 2026-10-21

Main/deployed source `4fad7003c6619aa1fdee2b27c0f9cae219a9aa60`, Worker `fb6b4691-938e-4c17-8dbd-5cb62d865d35`, as confirmed by the human release handoff. DEPLOYED does not mean NATURALLY VALIDATED. Current multi-source outage telemetry has no supplied natural-cycle proof yet.

## Authoritative priority order

1. **DAILY EMAIL DELIVERY GUARANTEE**
2. **GEMINI TRANSIENT-FAILURE HARDENING**
3. **PRODUCTION VALIDATION**
4. **RSS BODY_LIMIT RELIABILITY**
5. **THREADS**
6. **BRAVE + RSS + THREADS PRODUCTION PROOF**
7. **LEGACY CLEANUP**
8. **CENTRALIZE PIPELINE LIMITS**
9. **P7 / RELEVANCE + FEEDBACK**
10. **FINAL STABILIZATION / V1.0**

## Active work and completion criteria

1. **IMPLEMENTED / REVIEW PENDING:** one final attempt from normal analyzed, deterministic degraded, or status-only digest. Replay/no-resend, low-score labelling and the four-story cap remain intact; fallback adds no AI request.
2. **IMPLEMENTED / REVIEW PENDING:** same-model second dispatch only after proven confirmed-zero 429/503 and durable settlement, with 1000–1500 ms bounded jitter and the original shared 90-second deadline. Timeout and transport ambiguity remain non-retryable; quotas are unchanged.
3. **TODO:** naturally validate daily fallback, retry when genuinely exercised, multi-source outage telemetry and accounting safety. Track each as DEPLOYED versus NATURALLY VALIDATED; do not trigger monitoring for proof.
4. **TODO:** diagnose OpenAI/Cloudflare AI RSS body_limit, then smallest safe correction; do not blindly raise limits.
5. **TODO:** Threads through official Meta API only, same shared pool, no per-source Gemini call. No Threads implementation in this phase.
6. **TODO:** natural end-to-end proof after all three sources are released; do not claim Threads exists today.
7. **DEFERRED:** retire/isolate legacy runMonitoringCycle and remove obsolete X runtime/config/tests; preserve 0004 as unapplied. No X activation.
8. **DEFERRED:** centralize existing pipeline limits without silently increasing them.
9. **TODO, later:** relevance/feedback design, protected identity/authentication/persistence, bounded influence. No new feedback HTTP endpoint now.
10. **TODO, last:** stabilization and V1.0 closure against actual production evidence.

## Completed milestones and historical policy

- **DONE:** P0 legacy 503 retries, P1 digest, P2 Brave 10/day–100/week–350/month, P3 broader coverage, P4 legacy trusted fallback, P5 discovery reliability. P0 retry counts/model fallback and P4 send-nothing rules are historical legacy behavior, not scheduled Batch authority.
- **DONE / NATURALLY VALIDATED:** Batch delivery on 2026-10-16: one exact Gemini dispatch, four fresh stories, one accepted email.
- **DONE / DEPLOYED; partial NATURALLY VALIDATED:** RSS integration. On 2026-10-20 GitHub Changelog and Chrome RSS entered the shared pool; OpenAI/Cloudflare AI body_limit remains priority 4. Do not claim all feeds healthy.
- **DONE / DEPLOYED:** Batch-selected scores 1–10 delivery and provenance-qualified low-score replay. Do not infer natural low-score delivery proof from deployment or a zero-selection cycle.
- **DONE / DEPLOYED:** Gemini failure classification; the 2026-10-21 f53acb cycle timed out (row 28), yielded zero selections/eligible replay and no email. This motivates priorities 1–2, not a successful delivery milestone.
- **DONE / DEPLOYED, natural validation pending:** multi-source outage telemetry at 4fad700.
- **DONE historically / DEPRECATED activation:** P6 X implementation; disabled, zero production dependency, migration 0004 unapplied.

Detailed target: [daily digest reliability spec](docs/superpowers/specs/2026-10-21-daily-digest-reliability-design.md). Current and proposed policies are distinguished in [plan.md](plan.md). Production changes require human approval; this roadmap authorizes no deployment.

### Backlog/Plan Actualization Checkpoint

After every major feature or fix that is merged and/or production-validated, before beginning the next major roadmap item:

1. Update `backlog.md` with `DONE`, `TODO`, `DEFERRED`, or `DEPRECATED`, plus current priority and actual execution order.
2. Update `plan.md` with the current architecture and active implementation rules, explicitly superseding obsolete architecture.
3. Update `docs/self-improvement/PROJECT_STATE.md` only with verified production or deployment evidence.
4. Do not begin the next major roadmap item while these authoritative documents materially contradict the shipped state.
