# AI Agent Radar — Implementation Plan

## P0 · Gemini 503 Retry ✅ DONE

**Goal:** After a 503 response from the Gemini API, wait 5 seconds and retry the same request up to 3 times (i.e., 1 initial attempt + 3 retries = 4 total attempts maximum).

### Rules
- Retry only on HTTP 503. All other error codes (400, 401, 429, 500, etc.) are **permanent** and must **not** retry.
- Do not repeat Brave discovery or deduplication on any retry; pass the already-fetched article content directly back into the same Gemini call.
- Preserve usage accounting: count every attempt (successful or failed) toward token/request usage records.
- Preserve safety checks: apply the same content-safety validation to the retried response as to the original.
- Delay between retries: fixed 5-second wait (no exponential back-off required at this stage).
- After 3 retries are exhausted without success, surface the error to the caller as a permanent failure.

### Implementation Steps
1. Identify the Gemini HTTP client wrapper in `src/`.
2. Add a `retryOn503(fn, maxRetries = 3, delayMs = 5000)` utility function:
   - Call `fn()`.
   - If result is HTTP 503 and `attempts < maxRetries`, `await sleep(5000)` and recurse.
   - If result is any other error status, throw immediately (no retry).
   - On success, return result.
3. Wrap every Gemini API call site with `retryOn503`.
4. Ensure usage counters are incremented inside `fn` before the throw/return, not outside, so each attempt is counted.
5. Add unit tests in `test/` covering: success on first try, success on second try (after one 503), failure after 3 retries, no retry on 500, no retry on 429.

---

## P1 · Four-Story Combined Daily Email ✅ DONE

**Goal:** Replace the current one-analysis-per-cycle email with a single daily email containing four stories in a defined format.

### Email Structure
| Slot | Content |
|------|---------|
| Story 1 (lead) | Detailed summary · Why it matters · Key points (bullet list) · Source link |
| Stories 2–4 | Concise one-paragraph summary · Source link |

### Deduplication
- No story may appear more than once across any slot.
- Apply existing deduplication logic before slot assignment.

### Implementation Steps
1. Audit the current cycle logic in `src/` and identify the one-analysis-per-cycle gate; remove or relax that limitation so up to 4 analyses can be produced per email send.
2. Add a story-ranking step that orders candidates by relevance score descending.
3. Assign rank 1 → Story 1 (lead format), ranks 2–4 → concise format.
4. Build or extend the email template:
   - Lead block: `<h2>`, summary paragraph, **Why it matters** section, `<ul>` key points, source link.
   - Concise blocks: `<p>` summary + source link.
5. Guard: if fewer than 4 stories are available, fill available slots only; do not pad with low-quality content (see P4 for the fallback case).
6. Add integration-level tests in `test/` for: correct slot assignment, no duplicate stories, correct HTML structure for lead vs. concise blocks.

---

## P2 · Increase Brave Search Limits (100/week · 350/month · 10/day) ✅ DONE

**Goal:** Raise weekly quota to 100 and monthly quota to 350 while keeping the daily limit at 10.

### Scope
- Config file(s) in `src/` or `data/`
- Quota-guard logic
- Tests in `test/`
- Documentation in `docs/` and/or `README.md`
- Notes for production Cloudflare variable updates (documented, not applied)

### Implementation Steps
1. Locate the Brave quota constants (daily / weekly / monthly) in config.
2. Update values:
   - `BRAVE_DAILY_SEARCH_LIMIT` → 10 (unchanged)
   - `BRAVE_WEEKLY_SEARCH_LIMIT` → 100
   - `BRAVE_MONTHLY_SEARCH_LIMIT` → 350
3. Verify the quota-guard function checks all three limits and blocks a request if **any** limit is reached.
4. Update tests in `test/` to assert the new weekly and monthly thresholds.
5. Update `docs/` and `README.md` to document the new limits.
6. Add a comment block in the config (or a separate `docs/cloudflare-vars.md`) listing the Cloudflare environment variable names that must be updated in production (e.g., `BRAVE_WEEKLY_SEARCH_LIMIT`, `BRAVE_MONTHLY_SEARCH_LIMIT`) — document only, do not mutate production.

---

## P3 · Broaden AI, IT, Programming, and Developer-Tool Coverage ✅ DONE

**Goal:** Expand topic coverage to include AI, IT, programming, developer tools, and workflows, with explicit priority for **Codex** and **Claude Code**.

### Implementation Steps
1. Locate the topic/keyword configuration (likely in `src/` config or `data/`).
2. Add or expand topic categories:
   - **AI & ML:** large language models, AI agents, AI coding assistants, Codex, Claude Code, Gemini, GPT, open-source models.
   - **IT & Infrastructure:** cloud platforms, DevOps, Kubernetes, networking, security advisories.
   - **Programming:** language releases, compiler updates, standard library changes.
   - **Developer Tools & Workflow:** IDEs, CLI tools, CI/CD, code review tools, productivity tooling.
3. Assign explicit priority weights so that **Codex** and **Claude Code** keyword matches score higher than generic developer-tool matches.
4. Update relevance scoring to incorporate the new categories without displacing existing radar topics.
5. Add tests asserting that a Codex-related article scores above a generic IT article, and a Claude Code article scores above a generic programming article.
6. Update `docs/` to describe the expanded topic taxonomy.

---

## P4 · Fallback "It Could Be Relevant" Email

**Goal:** If no story meets the normal relevance threshold, send the best available trustworthy story (or stories) labelled **"It could be relevant"** rather than sending nothing or a blank email.

### Implementation Steps
1. Identify the relevance threshold constant and the code path that currently suppresses sending when no story qualifies.
2. After the normal threshold check, add a fallback branch:
   - Filter candidates to trustworthy sources only (existing source-trust logic).
   - If at least one trustworthy candidate exists, select the highest-scoring one(s).
   - Render them with a clearly labelled **"It could be relevant"** header/badge in the email template.
   - Send the fallback email.
3. If zero trustworthy candidates exist, do not send (preserve existing no-send behaviour).
4. Add tests covering: normal send (threshold met), fallback send (threshold not met, trustworthy story exists), no-send (threshold not met, no trustworthy story).
5. Document the fallback behaviour in `docs/`.

---

## P5 · User Feedback Signal (Relevant / Not Relevant)

**Goal:** Add **"Relevant or Useful"** and **"Not relevant or Not useful"** feedback links to emails, store the feedback signal, and use it softly in future ranking. Provide the ability to inspect and reset feedback.

### Implementation Steps
1. **Email template:** Append two feedback links to each story block (lead and concise):
   - `[Relevant or Useful]` → links to a feedback endpoint with `storyId` + `signal=positive`.
   - `[Not relevant or Not useful]` → links to a feedback endpoint with `storyId` + `signal=negative`.
2. **Feedback storage:** Create a feedback store (e.g., a new table in `migrations/` if using D1, or a KV namespace entry) with schema: `{ storyId, url, signal, timestamp }`.
3. **Feedback endpoint:** Add a route/handler in `src/` that:
   - Accepts `storyId` and `signal` query params.
   - Validates and stores the record.
   - Returns a plain confirmation page (no redirect to external URLs).
4. **Soft ranking integration:** In the relevance scoring step, apply a lightweight multiplier:
   - Positive feedback on a story's domain/topic → small score boost (e.g., ×1.1).
   - Negative feedback → small score penalty (e.g., ×0.9).
   - Cap influence so feedback alone cannot override a large relevance gap.
5. **Inspect & reset:**
   - Add an admin route/command to list all stored feedback records.
   - Add an admin route/command to reset (delete) all feedback records.
   - Protect admin routes (e.g., via a shared secret header).
6. Add tests covering: storing positive feedback, storing negative feedback, score boost/penalty application, inspect endpoint returns correct records, reset clears all records.
7. Document the feedback feature in `docs/`.

---

## Acceptance Criteria

| Priority | Criterion |
|----------|-----------|
| P0 | A Gemini 503 response triggers a 5-second wait and retry; the same request is retried up to 3 times after the initial attempt; non-503 errors do not retry; Brave discovery and deduplication are not repeated on retry; usage accounting increments on every attempt; safety validation applies to every response including retried ones. |
| P1 | The daily email contains exactly four story slots; Story 1 renders a detailed summary, why-it-matters section, key-points bullet list, and source link; Stories 2–4 render a concise summary and source link; no story appears in more than one slot; the one-analysis-per-cycle limitation is removed or raised to at least four. |
| P2 | `BRAVE_DAILY_SEARCH_LIMIT` remains 10; `BRAVE_WEEKLY_SEARCH_LIMIT` is 100; `BRAVE_MONTHLY_SEARCH_LIMIT` is 350; the quota-guard blocks requests when any limit is reached; tests assert the new weekly and monthly thresholds; docs and README reflect the new limits; production Cloudflare variable names are documented (not mutated). |
| P3 | Topic config includes AI, IT, programming, developer-tool, and workflow categories; Codex and Claude Code receive higher priority weights than generic developer-tool matches; relevance scores for Codex and Claude Code articles exceed scores for equivalent generic articles in tests. |
| P4 | When no story meets the relevance threshold but at least one trustworthy candidate exists, an email is sent with a visible "It could be relevant" label; when no trustworthy candidate exists, no email is sent; normal send path is unaffected. |
| P5 | Each story block in the email contains "Relevant or Useful" and "Not relevant or Not useful" feedback links; clicking a link stores the signal with storyId, URL, and timestamp; stored feedback applies a soft score multiplier in future ranking; an admin inspect route returns all feedback records; an admin reset route clears all feedback records; admin routes are protected. |

---

## Constraints

- Modify only `plan.md`; no other file may be created or changed as part of this architect output.
- No deployment, integration, merge, or push actions.
- No production configuration or secret mutation.
- Do not invent requirements not present in the original instruction.
- Retry logic must be scoped to HTTP 503 only; all other Gemini error codes are permanent failures.
- Brave daily limit must remain at 10; only weekly and monthly limits change.
- Feedback score influence must be soft (bounded multiplier) and must not allow feedback alone to override large relevance gaps.
- Admin feedback routes must be access-controlled.

---

## File Modification Summary

| File | Changes |
|------|---------|
| `plan.md` | This document (sole allowed output) |

> All implementation described above must be applied in source files (`src/`, `test/`, `docs/`, `migrations/`, `data/`, `README.md`) by the executing agent in subsequent steps. This plan is the authoritative reference; do not invent requirements not listed here.
