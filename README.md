# AI Agent Radar

AI Agent Radar is a Node.js and TypeScript project for discovering practical AI-agent, AI-product, and developer-tool updates. Each manually started monitoring cycle follows this local pipeline:

```text
Brave Search → deduplication → Gemini analysis → relevance filtering → Resend email notification
```

The project is an educational discovery and project-idea radar: its aim is not just to summarize news, but to surface what is worth learning from or building with.

## Implemented protections

- Duplicate URLs are stored and are not re-analyzed by Gemini.
- Notification history prevents duplicate email delivery.
- Brave and Gemini have persistent API usage guards.
- A conservative per-cycle analysis cap limits new analyses.
- The original source title and URL are preserved through analysis and notification formatting.
- Local discovery and notification history preserve operational state across runs.

Production runs in Cloudflare Workers with D1-backed persistence. Public HTTP remains health-only; monitoring runs only from the daily Cloudflare Cron Trigger.

## Cloudflare Worker and D1 foundation

The repository now contains the code foundation for a future Cloudflare Worker with D1-backed persistence. The Worker has a harmless health response only; it does not run monitoring from HTTP requests.

Current:

- Local JSON runtime state remains the default local implementation.
- D1 adapters exist for discoveries, notifications, Brave usage, and Gemini usage.
- The versioned D1 schema lives in `migrations/`.

Production schedule: `0 8 * * *` UTC (daily at 08:00 UTC). Each scheduled event runs one bounded monitoring cycle: up to ten quota-guarded Brave searches, up to four new Gemini analyses, and at most one Resend notification. D1 preserves deduplication, usage, discoveries, and notification history.

Repository Brave request limits are configured as:

- `BRAVE_DAILY_SEARCH_LIMIT=10`
- `BRAVE_WEEKLY_SEARCH_LIMIT=100`
- `BRAVE_MONTHLY_SEARCH_LIMIT=350`

## Discovery coverage and priority

The ten daily search slots cover four P3 topic groups without increasing the
Brave request budget:

- AI and ML: large language models, AI agents and coding assistants, Codex,
  Claude Code, Gemini, GPT, and open-source models.
- IT and infrastructure: cloud platforms, DevOps, Kubernetes, networking, and
  security advisories.
- Programming: language releases, compiler updates, and standard-library
  changes.
- Developer tools and workflow: IDEs, CLI tools, CI/CD, code review, productivity
  tooling, development techniques, and tutorials.

After the normal relevance threshold is met, Codex and Claude Code each receive
a deterministic `+1` digest-ordering bonus capped at `10`. The original Gemini
relevance score is not changed, and the bonus is never applied below the normal
notification threshold, so keyword presence alone cannot make a story eligible.
At the score ceiling, preferred-tool status breaks an otherwise exact tie.

Before Gemini analysis, unique unseen Brave results with explicit Codex or Claude
Code matches receive the same bounded priority signal when the four analysis
slots are selected. At most two positions are reserved by this signal; other
candidates retain their stable search order and fill the remaining slots. If
generic candidates are unavailable, preferred candidates may use otherwise-empty
slots. This selection does not bypass Gemini or change eligibility.

P2 is merged and Cloudflare production is configured with
`BRAVE_DAILY_SEARCH_LIMIT=10`, `BRAVE_WEEKLY_SEARCH_LIMIT=100`, and
`BRAVE_MONTHLY_SEARCH_LIMIT=350`.

For safe local D1 development only:

```bash
npm run d1:migrate:local
npm run worker:typecheck
```

`d1:migrate:local` explicitly uses Wrangler's `--local` option. Do not add `--remote` until a later deployment step.

## Local setup

1. Use Node.js 24 (see `.nvmrc`).
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env`.
4. Fill in only the provider credentials and notification settings you intend to use. Never commit `.env`.

`.env.example` documents the supported configuration without containing real credentials.

## Commands

- `npm test` — runs the offline test suite.
- `npm run build` — compiles TypeScript into `dist/`.
- `npm run monitor` — runs one real monitoring cycle and may call configured providers.
- `npm run monitor:test` — runs the controlled local monitoring test runner.
- `npm run email:test` — runs the controlled email test runner.

Other focused test commands are listed in `package.json`. Avoid real-provider commands unless the relevant API usage budget and environment configuration are ready.

## Project layout

- `src/tools` — provider-specific integrations such as web search, LLMs, and email.
- `src/services` — provider-independent workflow, safeguards, formatting, and persistence coordination.
- `src/types` — shared domain contracts.
- `test` — offline tests.
- `data` — local runtime state; its mutable contents are intentionally ignored by Git.

## Development checkpoints

Create one Git checkpoint per completed logical development step—not on every file save.

1. Run `npm test`.
2. Run `npm run build`.
3. Review `git diff` and `git status`.
4. Confirm no secrets or runtime data are staged (`.env` and `data/*.json` must remain ignored).
5. Commit with a descriptive message.
6. Push the checkpoint to `origin/main`.
