# AI Agent Radar — Backlog

Detailed implementation requirements live in [`plan.md`](./plan.md).

## P0 — Gemini 503 Retry

**Status:** DONE — implemented in commit `9d545f1` (PR #1, merged 2026-09-30)  
**Priority:** Critical

- Retry only HTTP 503.
- Wait 5 seconds between retries.
- Maximum 3 retries after the initial request.
- Retry the same Gemini request.
- Do not repeat Brave discovery or deduplication.
- Do not retry permanent/non-503 errors.
- Preserve request/token usage accounting and safety checks.

**Done when:** Gemini 503 failures automatically retry according to the rules above and all tests pass.

---

## P1 — Four-Story Daily Digest

**Status:** TODO  
**Priority:** High

- Send one combined daily email.
- Story 1:
  - detailed summary
  - why it matters
  - key points
  - source link
- Stories 2–4:
  - concise summary
  - source link
- Prevent duplicates.
- Adjust/remove the current one-analysis-per-cycle limitation so up to four stories can be analyzed.

**Done when:** one digest can reliably contain four unique analyzed stories in the required format.

---

## P2 — Increase Brave Search Limits

**Status:** TODO  
**Priority:** High

Target limits:

- `BRAVE_DAILY_SEARCH_LIMIT=10`
- `BRAVE_WEEKLY_SEARCH_LIMIT=100`
- `BRAVE_MONTHLY_SEARCH_LIMIT=350`

Required work:

- update configuration/defaults
- update quota tests
- update documentation
- update production Cloudflare variables when implementation is approved
- verify quota guards continue to fail safely

**Note:** with a 10/day limit, weekly usage normally cannot exceed 70 unless the daily limit is changed later.

**Done when:** application configuration, tests, docs, and production configuration use the approved limits.

---

## P3 — Broader AI / IT / Development Coverage

**Status:** TODO  
**Priority:** Medium

Expand monitoring for:

- AI news
- AI agents
- model releases
- programming and software development
- developer tools
- development workflows
- AI coding tools
- useful AI/IT techniques and tutorials

Explicitly prioritize:

- Codex
- Claude Code

**Done when:** discovery and ranking cover the expanded topic set and tests verify the intended priority.

---

## P4 — Fallback Relevant Story

**Status:** TODO  
**Priority:** Medium

If no trustworthy story reaches the normal relevance threshold:

- select the best trustworthy available story or stories
- send them instead of sending nothing
- visibly label the fallback section:

`It could be relevant`

Do not send when no trustworthy candidate exists.

**Done when:** normal-threshold and fallback paths are both covered by tests.

---

## P5 — User Feedback Learning

**Status:** TODO  
**Priority:** Later

Add feedback actions:

- Relevant or Useful
- Not relevant or Not useful

Store:

- story ID
- source URL
- topic/domain where appropriate
- feedback signal
- timestamp

Use feedback as a bounded/soft ranking signal rather than allowing it to dominate relevance.

Provide the ability to:

- inspect stored feedback
- reset stored feedback

**Done when:** feedback can be submitted, stored, inspected, reset, and safely influence future ranking.

---

## Execution Order

`P0 → P1 → P2 → P3 → P4 → P5`

Work on a lower-priority item only when the preceding item is complete or explicitly deferred.

## Backlog Rules

- `plan.md` is the detailed implementation specification.
- `backlog.md` tracks execution status and priority.
- Do not silently invent requirements beyond the approved plan.
- Preserve existing safety, quota, deduplication, and source-integrity behavior unless a backlog item explicitly changes it.
- Production deployment/configuration changes require explicit approval.
