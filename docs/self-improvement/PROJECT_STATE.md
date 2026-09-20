# AI Agent Radar project state

## Authority and verification provenance

This file is the durable source of truth for the production baseline, architecture, limits, safety rules, and approval boundaries. Update it only with verified evidence and the required authorization; distinguish intended changes from deployed facts.

Bootstrap date: 2026-09-20. The human-provided production handoff supplies the verified production checkpoint, deployed Worker version, and controlled-test discovery below. Local read-only inspection confirmed HEAD/history, Worker entry point, configured providers/limits, Cron, pre-analysis discovery deduplication, and relevance threshold. This bootstrap did not query Cloudflare, inspect live D1 data, or repeat the production test; deployment facts remain attributed to the handoff.

## Project and purpose

- Project: AI Agent Radar.
- Repository: `ai-agent-radar`.
- Autonomous monitoring discovers useful developments in AI agents, AI products, developer tools, APIs, frameworks, SDKs, MCP tooling, open-source AI projects, major AI updates, and important AI-agent industry news.
- Core analysis question: “What can someone learn or build because this exists?”

## Production architecture

```text
Cloudflare Cron
→ Cloudflare Worker
→ Brave Search
→ D1 deduplication
→ Gemini analysis
→ D1 discovery persistence
→ relevance gate
→ Resend email
→ D1 notification history
```

- Worker entry point: `src/worker.ts`; Cloudflare configuration: `wrangler.jsonc`.
- Autonomous production schedule: `0 8 * * *` UTC, once daily at 08:00 UTC.
- Public HTTP fetch returns only `AI Agent Radar worker ready`.
- HTTP requests must never trigger monitoring. There is no manual monitoring endpoint.
- No automatic full-cycle retries.

## Providers

- Search: Brave Search.
- Analysis: Google Gemini 3.6 Flash; configured model identifier `gemini-3.6-flash`.
- Email: Resend.
- OpenAI: not used in the cloud production execution path. Local legacy tooling/dependencies do not authorize inclusion in the deployed Worker runtime.

## Limits

Maximum per autonomous monitoring cycle:

- Brave: 1 request.
- Gemini: 1 new analysis.
- Resend: 1 email.
- OpenAI: 0 calls.

Configured Brave request limits:

- Daily: 10.
- Weekly: 50.
- Monthly: 200.

Configured Gemini request limits:

- Daily: 5.
- Weekly: 20.
- Monthly: 50.

Configured Gemini token limits:

- Daily: 10,000.
- Weekly: 30,000.
- Monthly: 100,000.

These are ceilings, not consumption targets. Provider quota changes require explicit human approval.

## Deduplication and relevance

- Discovery deduplication happens before Gemini.
- Known discovery: update `lastSeenAt`; no Gemini request.
- New discovery: may consume the single Gemini analysis slot.
- Notification identity: normalized URL + notification channel.
- A previously notified discovery must not generate another email.
- Email eligibility requires all three: new discovery, `relevanceScore >= 7`, and no previously recorded email notification.

## Persistence

Production persistence uses Cloudflare D1 for:

- Discoveries.
- Notifications.
- Brave usage.
- Gemini usage.
- Gemini usage state.

Versioned D1 migrations live in `migrations/`. Local development also supports JSON persistence. Local JSON is not part of the deployed Worker runtime.

## Secrets and bundle safety

Secrets are Cloudflare Worker secret bindings. Record binding names only, never values:

- `BRAVE_SEARCH_API_KEY`.
- `GEMINI_API_KEY`.
- `RESEND_API_KEY`.
- `NOTIFICATION_EMAIL`.

Never commit Brave, Gemini, or Resend API keys, the notification email address, temporary authentication secrets, or deployment credentials. Do not copy secrets into plans, reviews, summaries, logs, or validation output.

The production Worker bundle must not include local JSON persistence, Node filesystem modules, dotenv, or an OpenAI cloud dependency. Production must not expose a public/manual monitoring endpoint.

## Production checkpoints

Latest verified production commit:

`be1c03a feat: enable daily AI Agent Radar monitoring`

Important history, oldest first:

- `b158141` — chore: establish AI Agent Radar repository.
- `83a4dcd` — feat: style AI Agent Radar email notifications.
- `3734369` — refactor: prepare persistence for cloud deployment.
- `9262e17` — feat: add Cloudflare Worker and D1 foundation.
- `8701767` — feat: configure Cloudflare D1 production environment.
- `a429286` — test: verify controlled cloud monitoring execution.
- `be1c03a` — feat: enable daily AI Agent Radar monitoring.

Production Worker version reported at the end of Step 8.5:

`8ba41688-d29d-42ae-8bcf-bc5f56ce9cf2`

## First verified production discovery

- Name: Microsoft Agent Framework Updates.
- Category: `framework`.
- Relevance: 8.
- Source: Releases · microsoft/agent-framework.
- Source URL: https://github.com/microsoft/agent-framework/releases.

The controlled production test reported in the handoff verified:

```text
Brave → Gemini → D1 discovery → relevance gate → Resend → D1 notification
```

## Self-improvement governance

- Architect plans changes, analyzes architecture, selects one bounded improvement, writes Builder instructions, reviews Analyst feedback, and decides ACCEPT / REVISE / REJECT / HUMAN REVIEW.
- Builder implements only Architect-approved scope, runs required tests/build/typecheck, works on the experimental branch, and never merges into `main`.
- Analyst independently checks correctness, architecture, security, regressions, API limits, cost, D1 integrity, and Git cleanliness; returns findings without directly fixing implementation.
- `main` = production.
- `self-improvement` = experimental autonomous work; it exists at governance checkpoint `3a6946fe07ea3838488c789cba4c69718b2ed328`.
- Nothing merges into `main` without explicit human approval. Architect acceptance and Analyst PASS are not merge or deployment permission.

Explicit human approval is required for autonomous changes to:

- `main` branch.
- Production secrets.
- Cloudflare resource creation/deletion.
- Destructive D1 migrations.
- Production Cron schedule.
- Provider quota limits.
- Authentication/security boundaries.
- GitHub automation affecting production.
- Deployment credentials.
- Merge policy.
- Self-improvement governance rules.

## Bootstrap status and local baseline

- This task is explicitly authorized documentation/governance setup only; it does not authorize future governance changes.
- Current governance cycle: GOV-001, revision 1, documentation/governance only. Plan status: REVIEW; Analyst review: NOT STARTED.
- Initial Analyst review: NOT STARTED.
- No autonomous self-improvement cycle has run yet.
- At initial inspection, the checkout was on `main` at `be1c03a`, with no tracked changes and one pre-existing untracked file, `Без назви.md`. Preserve that file; it is outside bootstrap scope.
- Deployed production checkpoint remains `be1c03a`; no deployment occurred during governance setup.
- Older README statements about a future Worker or pushing checkpoints to `main` do not override this verified production state or AGENTS.md approval boundaries.
