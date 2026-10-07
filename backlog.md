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

**Status:** DONE  
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

**Status:** DONE
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

**Status:** DONE
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

**Status:** DONE
**Priority:** Medium

If no NEW, unsent story reaches the normal relevance threshold:

- select up to four available stories from the human-approved exact-host registry
- send them instead of sending nothing
- visibly label the fallback section:

`It could be relevant`

Do not send when no trustworthy candidate exists.

Normal qualifying stories always take precedence and are never padded with
fallback stories. Source trust applies only to fallback selection and does not
alter Gemini relevance scores or the normal threshold of 7.

**Done when:** normal-threshold and fallback paths are both covered by tests.

---

## P5 — Discovery Reliability

**Status:** TODO
**Priority:** High

Improve discovery recall without increasing the approved Brave daily quota.

Goals:

- search Brave with freshness up to 7 days, using `freshness = "pw"` as the preferred concept
- improve recall of important recent AI / IT / programming / developer-tool news
- add stronger deterministic coverage of important official sources, including OpenAI, Anthropic, Google AI, GitHub, Microsoft, and other high-value official developer/AI sources
- preserve the existing Brave limit of `10 / day`
- preserve deduplication
- preserve the maximum of four fresh Gemini analyses per cycle
- preserve P3 priority behavior
- preserve P4 fallback behavior
- preserve durable replay behavior
- preserve existing Gemini request/token quotas

Concrete acceptance case:

- a major official release such as **GPT-6.1 Sol** published within the configured freshness window should have a materially better chance of entering the analysis pipeline

**Architecture gate:** design this item with Architect before any implementation. Do not implement from this backlog entry alone.

**Done when:** the approved P5 architecture is implemented and tested, discovery recall for major recent official releases is improved, and all existing quota/dedup/ranking/replay safeguards remain intact.

---

## P6 — X.com Source Integration

**Status:** TODO
**Priority:** After P5

Add X.com as an additional bounded discovery source.

Goals:

- use selected trustworthy/high-signal AI and developer accounts
- optionally use X search/keywords where the approved architecture justifies it
- normalize X post/source identity
- deduplicate X discoveries against Brave and existing discoveries
- feed useful X discoveries into the same analysis, ranking, and digest pipeline
- define trust/spam filtering so X does not become an unrestricted noisy firehose
- preserve Gemini, Brave, deduplication, replay, and email safety limits

**Architecture gate:** design X API/auth/rate-limit strategy before implementation.

**Done when:** the approved P6 architecture is implemented and tested with bounded, deduplicated, high-signal X discovery feeding the existing pipeline.

---

## P7 — User Feedback

**Status:** TODO  
**Priority:** Later

Add per-story feedback actions such as:

- Relevant / Useful
- Not relevant / Not useful

Store feedback with enough identity/context to use it safely as a bounded soft ranking signal.

Requires design for:

- feedback endpoint
- story identity
- persistence
- protected inspect/reset routes
- security/authentication
- bounded influence on future ranking

**Architecture gate:** design this item before implementation because it changes the HTTP surface.

**Done when:** the approved P7 architecture is implemented and feedback can be submitted, stored, inspected, reset, and safely influence future ranking without dominating relevance.

---

## Execution Order

`P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7`

Work on a lower-priority item only when the preceding item is complete or explicitly deferred.

## Backlog Rules

- `plan.md` is the detailed implementation specification.
- `backlog.md` tracks execution status and priority.
- Do not silently invent requirements beyond the approved plan.
- Preserve existing safety, quota, deduplication, and source-integrity behavior unless a backlog item explicitly changes it.
- Production deployment/configuration changes require explicit approval.
