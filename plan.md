# AI Agent Radar — Current architecture and roadmap

## Authority — 2026-10-21

Current main/production source: `4fad7003c6619aa1fdee2b27c0f9cae219a9aa60`; Worker `fb6b4691-938e-4c17-8dbd-5cb62d865d35` (human-confirmed deployment). Source-health telemetry is DEPLOYED, not yet NATURALLY VALIDATED. The 2026-10-21 timeout invocation ran the earlier `f53acb06642c7880c62f3c9457562c9d42e61b24` source.

## Current production behavior

Natural Cron → Brave + four approved RSS feeds → shared URL/history dedupe and deterministic interleaving → at most 50 candidates / 32 KiB → one Gemini Batch dispatch → validated/persisted selections plus eligible replay → at most four stories / one email.

Gemini currently has no scheduled retry/model fallback. A 90-second timeout remains transport_ambiguous, with no guessed tokens. Valid selected scores 1–10 are deliverable; scores below 7 carry `It could be relevant`. Low-score replay needs persisted Batch selection provenance; legacy low-score replay is excluded. Known/notified aliases are excluded. No useful eligible stories currently means no email, including when Gemini fails and replay is empty.

RSS bounds stay max 5 feeds, 5 positions/feed, 5 seconds/feed, 256 KiB/feed, no retry/redirect. Four feeds are approved; only GitHub/Chrome have supplied successful natural RSS admission proof. Brave quotas stay 10/day, 100/week, 350/month. X is disabled/deprecated; 0004 remains unapplied. HTTP is health-only; no manual monitoring endpoint.

## Implemented on review branch — not deployed

All paths converge into one finalizer:

- Normal: existing Gemini analyzed selections + eligible replay.
- Degraded: existing deterministic fresh pool order, up to four safe unsent raw stories with original title/source/link/snippet, clearly labelled unanalysed; eligible replay can fill remaining slots.
- Status: if no safe useful stories, send a small truthful daily operational email. History failure suppresses story delivery, not status.

One final mail attempt per executing natural invocation; no independent failure/status sends. Consume the attempt before transport. Provider ambiguity or post-acceptance history failure never causes a replacement send. Inbox delivery and survival of platform termination cannot be guaranteed. Raw delivery records ordinary notification identity after acceptance, never fake analysis. Existing replay and low-score rules stay intact.

The review branch implements delivery reliability first and then at most one same-model retry ONLY for the existing proven confirmed-zero `resource_exhausted_429` / `unavailable_503` classifier after successful durable zero settlement. Separate reservations/request counts, unchanged quota guards and one shared cycle context are retained. Delay is 1000–1500 ms; both attempts and backoff share the existing total 90-second budget. Timeout, uncertain transport/usage, failed accounting, semantic errors and arbitrary 429 receive no retry. Max dispatches becomes 2 only through this reviewed exception; normal remains 1. Row 28 and the legacy latch are untouched. No timeout increase, model/provider fallback, extra ranker or second email is added.

The detailed state machine, acceptance tests, privacy rules and rollout gates are in [the design spec](docs/superpowers/specs/2026-10-21-daily-digest-reliability-design.md). No runtime change is authorized by writing this document.

## Authoritative execution order

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

Priorities 1–2 are implemented offline and await independent review and human-controlled release. Priority 3 observes natural cycles only after an approved release; validation is per path and must not claim unexercised retry/fallback success. Priorities 4–10 remain separate bounded work.

## Superseded historical policies

The former P0 initial+3 retries / multi-model advancement applies only to retained legacy tooling, not the scheduled path or this two-attempt proposal. The former P1 per-story analysis and fixed four-slot filler wording, P3 explicit score bonuses, P4 trusted-source-only/send-nothing batch assumption, and Threads-as-next priority are superseded for current scheduled architecture. Preserve historical commits/specs as provenance; do not execute their old imperative instructions. X activation is deprecated. Legacy removal and limit centralization wait for priorities 7–8.

### Backlog/Plan Actualization Checkpoint

After every major feature or fix that is merged and/or production-validated, before beginning the next major roadmap item:

1. Update `backlog.md` with `DONE`, `TODO`, `DEFERRED`, or `DEPRECATED`, plus current priority and actual execution order.
2. Update `plan.md` with the current architecture and active implementation rules, explicitly superseding obsolete architecture.
3. Update `docs/self-improvement/PROJECT_STATE.md` only with verified production or deployment evidence.
4. Do not begin the next major roadmap item while these authoritative documents materially contradict the shipped state.
