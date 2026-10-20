# AI Agent Radar

AI Agent Radar is a Node.js and TypeScript project for discovering practical AI-agent, AI-product, and developer-tool updates. Production monitoring follows this scheduled pipeline:

```text
multi-query Brave + bounded RSS → shared deduplication → one Gemini batch → up to four stories → one Resend digest
```

The retained `runMonitoringCycle()` per-story path is available for legacy/local use but is not the Cloudflare scheduled production path.

The project is an educational discovery and project-idea radar: its aim is not just to summarize news, but to surface what is worth learning from or building with.

## Implemented protections

- Duplicate URLs are stored and are not re-analyzed by Gemini.
- Notification history prevents duplicate email delivery.
- Brave and Gemini have persistent API usage guards.
- Candidate, prompt, selection, dispatch, and delivery caps bound each scheduled Batch cycle.
- The original source title and URL are preserved through analysis and notification formatting.
- Local discovery and notification history preserve operational state across runs.
- Recently analyzed but unnotified discoveries can be replayed from durable history without another Gemini analysis.

Production runs in Cloudflare Workers with D1-backed persistence. Public HTTP remains health-only; monitoring runs only from the daily Cloudflare Cron Trigger.

## Cloudflare Worker and D1 foundation

The repository contains the production Cloudflare Worker with D1-backed persistence. The Worker has a harmless health response only; it does not run monitoring from HTTP requests.

Current:

- Local JSON runtime state remains the default local implementation.
- D1 adapters exist for discoveries, notifications, Brave/Gemini usage, and the disabled/deprecated P6 X inbox/cursor/budget state.
- The versioned D1 schema lives in `migrations/`; migration `0003` adds nullable Gemini model attribution, while unapplied migration `0004` adds only P6 X tables.

Production schedule: `0 8 * * *` UTC (daily at 08:00 UTC). Each scheduled event runs `runBatchMonitoringCycle()`: up to ten quota-guarded Brave searches plus bounded RSS feed collection enter one shared canonical/history-deduplicated pool; at most 50 candidates enter the current 32 KiB prompt; Gemini is dispatched at most once; at most four stories are selected; and at most one Resend digest is sent. D1 preserves deduplication, usage, discoveries, Batch-selection provenance, and notification history.

The retained legacy Gemini analysis path uses a source-controlled, forward-only model pool:
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

The production scheduled Batch path uses `gemini-3.8-flash` with at most one provider dispatch. It does not perform 503 retries, model fallback, repair, per-story analysis, or a second ranking request.

The Gemini provider deadline is 90 seconds across dispatch, headers, and body
reading/parsing. A timed-out attempt remains durable, unknown-token accounting,
stops further Gemini work in that cycle, and blocks new admission only through
the end of its `accounting_through` UTC day. It remains counted as one request
in every applicable accounting window; its zero token placeholders are not
treated as proof of zero use.

### Deprecated P6 selected-account X discovery

The repository retains a disabled source-controlled selected-account timeline adapter. Its fixed v1 registry contains the immutable decimal-string user IDs approved for OpenAI, Anthropic, Google DeepMind, GitHub, and Microsoft, in that order. Handles are display metadata only; the runtime performs no user lookup, account discovery, search, pagination, redirect resolution, or retry.

The historical adapter retains its reviewed bounds and source-controlled registry, but it has zero production dependency.

X is disabled and production activation is abandoned/deprecated. Migration `0004_x_discovery.sql` is intentionally unapplied; no X secret or paid provider capacity is required. X is not active roadmap work.

### RSS discovery

RSS discovery is implemented and deployed for four approved first-party feeds. It is bounded to five configured feeds, five item positions per feed, one request with no retry or redirect, a 5-second request-through-body deadline, and 256 KiB per feed. Feed failures are isolated and do not stop Brave. The Workerd native-fetch receiver issue is fixed.

The natural 2026-10-20 production cycle proved GitHub Changelog and Chrome for Developers succeeded and supplied valid RSS candidates to the shared Gemini pool. OpenAI and Cloudflare AI reached `body_limit` and remain follow-up reliability work; all four feeds are not claimed healthy.

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

In the retained legacy per-story path, after its normal relevance threshold is met,
Codex and Claude Code each receive
a deterministic `+1` digest-ordering bonus capped at `10`. The original Gemini
relevance score is not changed, and the bonus is never applied below the normal
notification threshold, so keyword presence alone cannot make a story eligible.
At the score ceiling, preferred-tool status breaks an otherwise exact tie.

In that legacy path, before Gemini analysis, unique unseen Brave results with explicit Codex or Claude
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

The implemented P5 multi-query Brave observations now join RSS in the scheduled
Batch candidate pool. The older four-position pre-analysis behavior remains part
of `runMonitoringCycle()` only and is not the production scheduled path.

## Batch low-relevance delivery and legacy fallback

In the production scheduled Batch path, Gemini may select up to four stories with
scores from 1–10. Every valid selected story is deliverable. A selected story
below 7 is visibly labelled exactly `It could be relevant`; a story at or above
7 retains normal rendering. An all-low selected batch can therefore still
produce one digest without another Gemini request.

Fresh Batch selections persist optional exact provenance
`batchSelectionProvenance?: { kind: "batch" }`. A replayed low-score story is
eligible only when this marker is present and valid. Legacy low-score records
remain ineligible, but their URL aliases still contribute notification-history
evidence so they can prevent a resend without becoming delivery candidates.

The exact-host P4 trusted-source fallback and score-7 normal gate remain in the
legacy `runMonitoringCycle()` path. They are not used to exclude selected stories
from the scheduled Batch path.

P2 is merged and Cloudflare production is configured with
`BRAVE_DAILY_SEARCH_LIMIT=10`, `BRAVE_WEEKLY_SEARCH_LIMIT=100`, and
`BRAVE_MONTHLY_SEARCH_LIMIT=350`.

## Bounded notification replay

A stored, unnotified analysis can re-enter the same digest pool for 72 hours
from its immutable `firstSeenAt`, provided it was first seen on or after
`2026-10-06T16:00:00Z`. The recent-history scan is deterministic and capped at
100 rows. Replay does not require Brave to find the URL again and does not call
Gemini again.

Fresh and replay candidates deduplicate by normalized URL, share deterministic
ranking and the four-story/one-email limits, and use the ordinary notification-
history identity. In the scheduled Batch path, low-score replay requires the
exact Batch-selection marker described above; legacy low-score replay remains
ineligible.
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
6. Push the feature branch; merging to `main` requires explicit human approval.
