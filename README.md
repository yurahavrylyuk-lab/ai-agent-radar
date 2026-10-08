# AI Agent Radar

AI Agent Radar is a Node.js and TypeScript project for discovering practical AI-agent, AI-product, and developer-tool updates. Each manually started monitoring cycle follows this local pipeline:

```text
Brave Search + optional bounded X polling → deduplication → Gemini analysis → relevance filtering → Resend email notification
```

The project is an educational discovery and project-idea radar: its aim is not just to summarize news, but to surface what is worth learning from or building with.

## Implemented protections

- Duplicate URLs are stored and are not re-analyzed by Gemini.
- Notification history prevents duplicate email delivery.
- Brave and Gemini have persistent API usage guards.
- A conservative per-cycle analysis cap limits new analyses.
- The original source title and URL are preserved through analysis and notification formatting.
- Local discovery and notification history preserve operational state across runs.
- Recently analyzed but unnotified discoveries can be replayed from durable history without another Gemini analysis.

Production runs in Cloudflare Workers with D1-backed persistence. Public HTTP remains health-only; monitoring runs only from the daily Cloudflare Cron Trigger.

## Cloudflare Worker and D1 foundation

The repository now contains the code foundation for a future Cloudflare Worker with D1-backed persistence. The Worker has a harmless health response only; it does not run monitoring from HTTP requests.

Current:

- Local JSON runtime state remains the default local implementation.
- D1 adapters exist for discoveries, notifications, Brave/Gemini usage, and the disabled-by-default P6 X inbox/cursor/budget state.
- The versioned D1 schema lives in `migrations/`; migration `0003` adds nullable Gemini model attribution, while unapplied migration `0004` adds only P6 X tables.

Production schedule: `0 8 * * *` UTC (daily at 08:00 UTC). Each scheduled event runs one bounded monitoring cycle: up to ten quota-guarded Brave searches, up to four new Gemini analyses, and at most one Resend notification. D1 preserves deduplication, usage, discoveries, and notification history.

Gemini analysis uses a source-controlled, forward-only model pool:
`gemini-3.8-flash`, `gemini-3.6-flash`, then `gemini-3.5-flash-lite`.
Each model preserves the existing initial request plus three 503 retries. The
provider advances only after exhausted verified 503/UNAVAILABLE responses or a
structurally verified model-specific 429; ambiguous quota, authentication,
permission, policy, transport, accounting, and invalid-output failures do not
hop models. Every actual request is attributed to its model before dispatch.
The existing global limits (5/20/50 requests and 10,000/30,000/100,000 tokens)
remain fail-closed and normally stop the theoretical 12-attempt chain early.
`GEMINI_MODEL` is deprecated and ignored; it cannot alter the reviewed pool.
The pool uses only the approved included Free Tier capacity; paid fallback is not enabled.

### P6 selected-account X discovery

P6 adds a disabled-by-default, source-controlled selected-account timeline adapter. Its fixed v1 registry contains the immutable decimal-string user IDs approved for OpenAI, Anthropic, Google DeepMind, GitHub, and Microsoft, in that order. Handles are display metadata only; the runtime performs no user lookup, account discovery, search, pagination, redirect resolution, or retry.

When later activated, the adapter reserves worst-case local usage before each request and is bounded to five requests/50 Post reads per cycle, 5/35/155 requests by UTC day/ISO week/calendar month, 1,550 reserved reads/month, and an $8 source-controlled monthly ceiling at the approved price. Price approval expires and fails closed. X candidates share the existing four Gemini analysis positions and one digest; no X-only lane exists. X-owned provenance survives D1/JSON persistence and replay, provides visible digest attribution, and prevents below-threshold P4 fallback.

`X_DISCOVERY_ENABLED` defaults to false. Production activation is a separate human decision requiring migration `0004`, the `X_BEARER_TOKEN` Worker secret, current X terms/price/endpoint verification, prepaid-credit approval with auto-recharge off, and a provider-side spending cap. This implementation task does not perform any of those actions.

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

### P5 discovery reliability

P5 keeps the same ten Brave request slots but makes their allocation explicit:
five interleaved targeted official-source queries (OpenAI, Anthropic, Google AI,
GitHub Blog, and Microsoft developer documentation) and five broad topic
queries. Every monitoring query uses Brave's weekly `freshness: "pw"` filter;
an explicit/custom cycle still performs one freshness-constrained search.

The four Gemini analysis positions preserve P3's two Codex/Claude Code
opportunities. At most one additional recent, exact-host result observed by its
matching targeted official query is given a bounded analysis opportunity; normal
stable ordering fills the rest. This is neither a relevance bonus nor source
trust: Gemini, the normal threshold, P4 fallback policy, and notification
history remain authoritative.

## Fallback digest and source trust

The normal notification threshold remains `7`. If at least one fresh-or-replay,
unsent analysis reaches that threshold, the normal digest contains only normally
eligible stories; lower-scored stories never pad it.

Only when zero fresh-or-replay, unsent analyses reach the normal threshold may the radar
send a fallback digest. Fallback candidates must have an exact hostname match
in the human-maintained registry in `src/config/trustedSources.ts`. Parent
domains do not approve subdomains, `www` variants are not inferred, and unknown,
malformed, or unsupported sources fail closed. Trusted fallback candidates use
the existing ranking and notification-history behavior, retain their original
Gemini relevance scores, and are visibly labelled `It could be relevant` in
both HTML and plain text. If no trusted fallback candidate exists, no email is
sent. Source trust has no effect on normal eligibility.

P2 is merged and Cloudflare production is configured with
`BRAVE_DAILY_SEARCH_LIMIT=10`, `BRAVE_WEEKLY_SEARCH_LIMIT=100`, and
`BRAVE_MONTHLY_SEARCH_LIMIT=350`.

## Bounded notification replay

A stored, unnotified analysis can re-enter the same digest pool for 72 hours
from its immutable `firstSeenAt`, provided it was first seen on or after
`2026-10-06T16:00:00Z`. The recent-history scan is deterministic and capped at
100 rows. Replay does not require Brave to find the URL again and does not call
Gemini again.

Fresh and replay candidates deduplicate by normalized URL, share P3 ranking and
the four-story/one-email limits, and use the ordinary notification-history
identity. A normal replay story suppresses fallback. Below-threshold replay is
allowed only when the source still passes the current exact-host P4 registry.
Failed sends create no success record, so a candidate can be considered again
before expiry; the existing provider-accepted/history-write-failed ambiguity is
unchanged.

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
