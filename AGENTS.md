# AI Agent Radar operating contract

Applies to the entire repository and all Architect, Builder, and Analyst work.

## Shared durable memory

- Repository files are shared durable memory, intended for version control. Chat history alone is not authoritative.
- Read [PROJECT_STATE.md](docs/self-improvement/PROJECT_STATE.md), your role guide, the active plan, and the latest Analyst review before work.
- Record approved scope, evidence, deviations, reviews, and decisions in `docs/self-improvement/`; never invent verification results or store secrets there.
- Reconcile repository evidence with the recorded state. Report discrepancies; do not silently reinterpret production behavior or permissions.

## Role boundaries and handoff

- [Architect](docs/self-improvement/ARCHITECT.md) plans one bounded improvement, writes [ARCHITECT_PLAN.md](docs/self-improvement/ARCHITECT_PLAN.md), and decides ACCEPT / REVISE / REJECT / HUMAN REVIEW after review. Architect does not implement production code.
- [Builder](docs/self-improvement/BUILDER.md) implements only approved scope and records changes, checks, and deviations in [DAILY_SUMMARY.md](docs/self-improvement/DAILY_SUMMARY.md).
- [Analyst](docs/self-improvement/ANALYST.md) independently reviews the exact change and records findings in [ANALYST_REVIEW.md](docs/self-improvement/ANALYST_REVIEW.md). Analyst does not fix implementation.
- Keep the plan, review, summary, and [CHANGELOG.md](docs/self-improvement/CHANGELOG.md) consistent. Architect acceptance does not authorize a production merge or deployment.

## Branches and approval

- `main` is production. `self-improvement` exists as the experimental working branch for all autonomous Builder work. Never merge into `main` without explicit human approval.
- Explicit human approval is required for autonomous changes to: `main`, production secrets, Cloudflare resource creation/deletion, destructive D1 migrations, production Cron, provider quotas, authentication/security boundaries, GitHub automation affecting production, deployment credentials, merge policy, and self-improvement governance rules.
- These governance restrictions supersede older README checkpoint instructions to commit or push to `main` for autonomous work.
- The permanent handoff is Human → Architect → Builder → Analyst → Architect → Human. Only one cycle may be active; repository files are the durable channel.

## Production invariants

- Cloudflare Cron runs daily at `0 8 * * *` UTC. HTTP returns only `AI Agent Radar worker ready` and must never start monitoring; no manual monitoring endpoint.
- Per cycle: up to 10 Brave requests (one per `MONITORING_QUERIES` entry, quota-guarded), up to 4 new Gemini analyses, 1 Resend email, and 0 OpenAI calls. No automatic full-cycle retries.
- Gemini analysis uses only the reviewed ordered pool `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3.5-flash-lite`. Each model retains P0's initial request plus at most three 503 retries; fallback is forward-only and limited to exhausted verified 503/UNAVAILABLE or structurally model-specific 429 failures. Authentication, permission, policy, request, ambiguous quota, transport, accounting, and semantic failures are terminal. Every dispatch is exact-model attributed and quota-guarded; the existing global request/token ceilings remain authoritative and can stop the theoretical 12-attempt chain early.
- Deduplicate discoveries before Gemini; known URLs update `lastSeenAt` without analysis. Normal email eligibility requires relevance score >= 7, no previous email notification for the normalized URL/channel, and either a fresh new discovery or a stored discovery admitted by the approved bounded replay policy.
- Replay uses immutable `firstSeenAt`, a 72-hour window, activation cutoff `2026-10-06T16:00:00Z`, and a deterministic scan capped at 100. It does not require Brave rediscovery or Gemini re-analysis; fresh and replay stories share the existing ranking, four-story digest cap, and one-email-per-cycle limit.
- P4 exception: only when zero fresh-or-replay, unsent stories meet the normal threshold, up to four below-threshold fresh-or-replay, unsent stories whose exact hostname is in the current human-approved trusted-source registry may be sent in a digest labelled `It could be relevant`. Unknown or untrusted fallback sources are excluded; previously notified discoveries are never resent; source trust does not affect normal eligibility.
- Production persistence is D1. The Worker bundle must exclude local JSON persistence, Node filesystem modules, dotenv, and OpenAI cloud dependencies.
- Secrets belong in Worker secret bindings. Never commit API keys, the notification email address, temporary authentication secrets, or deployment credentials. See PROJECT_STATE.md for all limits and safety rules.
- Inspect scripts before execution. Live monitoring/provider test commands are not offline validation and must not run during this bootstrap.
