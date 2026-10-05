# AI Agent Radar project state

## Authority and verification provenance

This file is the durable source of truth for the production baseline, architecture, limits, safety rules, and approval boundaries. Update it only with verified evidence and the required authorization; distinguish intended changes from deployed facts.

Bootstrap date: 2026-09-20. The human-provided production handoff supplies the verified production checkpoint, deployed Worker version, and controlled-test discovery below. Local read-only inspection confirmed HEAD/history, Worker entry point, configured providers/limits, Cron, pre-analysis discovery deduplication, and relevance threshold. This bootstrap did not query Cloudflare, inspect live D1 data, or repeat the production test; deployment facts remain attributed to the handoff.

## Project and purpose

- Project: AI Agent Radar.
- Repository: `ai-agent-radar`.
- Autonomous monitoring discovers useful developments across AI/ML, AI agents and products, model releases, programming, IT/infrastructure, developer tools, and development workflows while preserving API, framework, SDK, MCP, open-source, major-update, and AI-industry coverage.
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

- Brave: up to 10 requests (one per `MONITORING_QUERIES` entry; the quota guard stops the loop early if a daily/weekly/monthly limit is reached).
- Gemini: up to 4 new analyses (`MAX_NEW_ANALYSES_PER_CYCLE = 4`; known/duplicate URLs consume no analysis slot).
- Resend: 1 email.
- OpenAI: 0 calls.

Approved repository Brave request limits for P2:

- Daily: 10.
- Weekly: 100.
- Monthly: 350.

Cloudflare production variables are not changed by the P2 implementation task. After merge, a separate authorized production update must change `BRAVE_WEEKLY_SEARCH_LIMIT` from 50 to 100 and `BRAVE_MONTHLY_SEARCH_LIMIT` from 200 to 350; `BRAVE_DAILY_SEARCH_LIMIT` remains 10.

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
- New discovery: may consume one of up to four Gemini analysis slots.
- Notification identity: normalized URL + notification channel.
- A previously notified discovery must not generate another email.
- Normal email eligibility requires all three: new discovery, `relevanceScore >= 7`, and no previously recorded email notification.
- P4 adds one bounded fallback exception after notification-history filtering: only when zero NEW, unsent analyses meet the normal threshold, up to four below-threshold candidates from human-approved exact hostnames may be sent in one digest labelled `It could be relevant`. If no trusted candidate exists, no email is sent. Normal candidates always take precedence and are never padded with fallback stories.
- The versioned fallback trust registry is static and provider-independent. It uses exact HTTP(S) hostname equality only; it infers no parent, subdomain, or `www` trust. Unknown, malformed, unsupported, credentialed, address-based, or non-default-port sources fail closed. Trust does not change stored Gemini relevance or normal eligibility.
- Before analysis slots are assigned, P3 gives unique unseen Brave candidates with explicit Codex or Claude Code matches a bounded deterministic priority signal. At most two of four positions are reserved by this signal; generic candidates retain stable search order and fill remaining slots, while preferred candidates may use otherwise-empty positions. This selection never changes eligibility or stored relevance.
- P3 digest ordering gives relevant Codex and Claude Code discoveries a deterministic `+1` priority bonus capped at `10`, with preferred-tool status breaking an otherwise exact tie at the ceiling. This is a post-eligibility ordering signal: it does not mutate the stored Gemini relevance score and never makes a below-threshold story eligible.
- P3 topic coverage includes AI/ML (including Gemini, GPT, and open-source models), IT/infrastructure (cloud, DevOps, Kubernetes, networking, and security advisories), programming releases, and developer tools/workflows (IDEs, CLI, CI/CD, code review, productivity tooling, techniques, and tutorials).

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
- GOV-001 revision 1 completed at Builder commit `71751da70ac15767fe1356dece3d719ee7f460a4` and was reviewed as `REVISE` in Analyst checkpoint `846392643d039f5304e118d7c87fb91c2a1aaed1`; the revision-1 Architect decision is `REVISE`.
- GOV-001 is COMPLETE at final revision 2. Accepted Builder commit `ab23e28d6d7e8c3a2d55ded8f81a5ce53e4d7744` received Analyst `PASS` at checkpoint `5137631f44f8888fd4690cad368592110bb396c1`; final Architect decision: `ACCEPT`.
- `3a6946fe07ea3838488c789cba4c69718b2ed328` is the original governance baseline and branch starting checkpoint, not the current `self-improvement` tip.
- The Analyst historically observed that `Без назви.md` was absent during revision-1 review. The human owner later clarified that they intentionally deleted the empty, unrelated file after the Builder handoff. That resolves the uncertainty; its absence is not a Builder failure and it has no preservation, checksum, or recreation requirement.
- No autonomous production change is authorized by GOV-001.
- Deployed production checkpoint remains `be1c03a`; no deployment occurred during governance setup.
- Older README statements about a future Worker or pushing checkpoints to `main` do not override this verified production state or AGENTS.md approval boundaries.
