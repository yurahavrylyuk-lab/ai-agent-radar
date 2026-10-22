# AI Agent Radar — Backlog

## Current authority — 2026-10-22

Current production/main source `0df2c2399c76b4c7c518119b6a8511a300ef9aee`, Worker `6129de15-115c-4f61-9a3b-488d26baf301`, deployment `77fbd332-da4a-4862-9608-78cb963883f9`, from the human-verified 2026-10-22 handoff. No live production query was performed by this architecture task.

## Authoritative priority order

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

## Active work and completion criteria

1. **TODO / ARCHITECTURE_READY:** durable bounded Gemini classifications and cycle summaries; failure-aware maximum-three-attempt policy for proven-zero 503 with exponential backoff/jitter. Current 429 evidence cannot establish transient rate exhaustion, so V2 does not retry it. Timeout/ambiguity never retries. Additive D1 telemetry migration proposed, not applied.
2. **TODO / DESIGNED:** reuse normal dark inline-CSS/table email shell, degraded banner, styled cards and safely cleaned bounded snippets; preserve plain text and truthful raw/replay provenance.
3. **TODO:** after human-controlled release, naturally validate V2 evidence, retry policy, styling, source health, accounting and one email; record unexercised paths separately.
4. **TODO:** smallest safe OpenAI/Cloudflare AI RSS body_limit correction; do not blindly increase limits.
5. **TODO:** official Meta API Threads only, shared candidate pool, no per-source Gemini call.
6. **TODO:** real combined Brave/RSS/Threads proof after their releases.
7. **DEFERRED:** retire/isolate old runMonitoringCycle; remove obsolete X runtime/config/tests; keep 0004 intentionally unapplied.
8. **DEFERRED:** centralize existing limits without increasing quotas.
9. **TODO, later:** P7 relevance/feedback with separately reviewed boundaries.
10. **TODO, last:** final stabilization/V1.0 against actual evidence.

## Completed / naturally validated and partial milestones

- **COMPLETED / NATURALLY VALIDATED:** daily email delivery guarantee on natural Cron `2026-10-22T08:00:49.466Z`: four fresh raw stories, zero replay, one accepted degraded email, no resend/crash. It is no longer active priority 1. Platform termination/provider rejection remain possible.
- **IMPLEMENTED / DEPLOYED / PARTIALLY NATURALLY VALIDATED:** existing coarse Gemini hardening: rows 29/30 confirmed_zero, two actual dispatches, approximately 1.5-second gap, no new ambiguity. Exact 429/503 class unavailable; V2 smarter policy is not implemented.
- Low-score and timeout fallback were not naturally exercised on this cycle. Source outage telemetry remains only partially evidenced because the final structured summary was not durably retained.

## Earlier completed milestones and historical policy


- **DONE:** P0 legacy 503 retries, P1 digest, P2 Brave 10/day–100/week–350/month, P3 broader coverage, P4 legacy trusted fallback, P5 discovery reliability. P0 retry counts/model fallback and P4 send-nothing rules are historical legacy behavior, not scheduled Batch authority.
- **DONE / NATURALLY VALIDATED:** Batch delivery on 2026-10-16: one exact Gemini dispatch, four fresh stories, one accepted email.
- **DONE / DEPLOYED; partial NATURALLY VALIDATED:** RSS integration. On 2026-10-20 GitHub Changelog and Chrome RSS entered the shared pool; OpenAI/Cloudflare AI body_limit remains priority 4. Do not claim all feeds healthy.
- **DONE / DEPLOYED:** Batch-selected scores 1–10 delivery and provenance-qualified low-score replay. Do not infer natural low-score delivery proof from deployment or a zero-selection cycle.
- **DONE / DEPLOYED:** Gemini failure classification; the 2026-10-21 f53acb cycle timed out (row 28), yielded zero selections/eligible replay and no email. This is historical evidence; the later 2026-10-22 degraded cycle validated delivery.
- **DEPLOYED / not fully NATURALLY VALIDATED:** multi-source outage telemetry, retained in current production; final summary was not durably recoverable.
- **DONE historically / DEPRECATED activation:** P6 X implementation; disabled, zero production dependency, migration 0004 unapplied.


Target: [Gemini Reliability V2 design](docs/superpowers/specs/2026-10-22-gemini-reliability-v2-design.md). Design only; human review precedes implementation planning. No runtime implementation, migration, deployment or production authorization follows from this roadmap.

### Backlog/Plan Actualization Checkpoint

After every major merged, deployed or production-validated milestone, before beginning the next major roadmap item:

1. Update `backlog.md` with completed/implemented/deployed/naturally validated/partially validated/TODO/deferred status and actual priority.
2. Update `plan.md` with current architecture and target rules, superseding obsolete instructions explicitly.
3. Update `docs/self-improvement/PROJECT_STATE.md` only with verified facts and evidence provenance.
4. Reconcile `docs/self-improvement/DAILY_SUMMARY.md` and `docs/self-improvement/CHANGELOG.md` with the same milestone.
5. Do not begin the next major item while these five documents materially contradict each other or shipped behavior.
