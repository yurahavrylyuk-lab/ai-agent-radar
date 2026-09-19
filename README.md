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

Cloudflare deployment has not been implemented yet. The monitor runs locally when invoked.

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
