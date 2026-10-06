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

**Status:** DONE. **Architecture:** approved deterministic exact-host trust registry and fallback digest implemented and validated offline.

**Goal:** When no fresh-or-approved-replay, unsent analyzed story is normally eligible at score >= 7, send up to four fresh-or-approved-replay, unsent analyzed stories from explicitly approved sources, visibly labelled **"It could be relevant"**. If none pass source trust, send nothing. Never pad a normal digest with fallback stories.

### Baseline and source-integrity distinction

- Authoritative main supplied by the human: `9d9017c9de2044e5f51f91cde871d45203aed3fa`; cached `origin/main` matches. Architecture inspection occurred on `codex/p3-broader-coverage` at `fa9c3933bcdc1f21f486a2e2bfd4bc3b1c8f912b`, not main. The inspected plan, notification orchestrator, and priority comparator match the authoritative baseline. No branch/ref changes are part of this task. Builder must verify its approved implementation baseline before work.
- Existing untrusted-content handling in `analysisAgent.ts`, title/URL preservation in `discoveryProcessor.ts`, URL normalization in `discoveryHistoryCore.ts`, and safe HTTP(S) rendering in `discoveryEmailFormatter.ts` establish source integrity, not publisher trust. Preserve all of them.
- Trust means only “human-approved source for fallback delivery”; it is a boolean, not a relevance score or assurance that every article is true. Do not infer trust from Gemini output, titles, snippets, source labels, Codex/Claude keywords, search position, or a safe-looking link.

### Minimal registry and predicate

- Proposed registry: `src/config/trustedSources.ts`, a static, version-controlled, Worker-bundled readonly constant. No filesystem reads, database table, runtime configuration endpoint, secrets, external dependency, or remote lookup.
- Proposed shape: `TRUSTED_SOURCE_REGISTRY = { version: 1, approvedHostnames: [] } as const`. The empty list here specifies the format only; it is not an approved initial list. Every implemented entry must be copied from the explicit human approval below.
- Proposed predicate: `isTrustedFallbackSource(sourceUrl: string): boolean` in `src/services/sourceTrust.ts`. It reads the registry and uses only standard URL parsing and deterministic string comparison.
- Match the parsed hostname of the preserved, normalized original source URL. Do not inspect article links or follow redirects. Reparse defensively at the trust boundary; do not alter stored discovery/notification identity.
- Accept only absolute HTTP(S) URLs with a nonempty valid DNS hostname. No relative/base-URL resolution. Reject credentials, IP literals, single-label names, malformed input, and non-default ports. An explicit default port is equivalent to the omitted port.
- Use the standard `URL` parser's ASCII/IDNA hostname representation, lowercase it, and remove one terminal DNS dot. Reject remaining empty labels and invalid DNS labels. Registry entries must already be canonical lowercase ASCII hostnames, including explicit punycode where relevant, with no scheme, path, port, wildcard, credentials, or terminal dot. Do not perform fuzzy matching or Unicode-confusable equivalence.
- Matching is exact hostname equality only. Approving a parent domain does NOT approve its subdomains. `www` is not stripped; each desired host requires its own entry. No suffix matching, public-suffix inference, wildcard rules, or automatic additions in this version.
- Paths, query strings, and fragments cannot confer trust. A trusted hostname appearing in a path, username, query, or suffix of an attacker-controlled hostname is not a match.
- Unknown URL/hostname, parse failure, unsupported URL, invalid registry/version, or an empty registry returns false without making provider calls. Validate registry entries and duplicates in tests; if runtime registry validation fails, disable fallback trust for the entire registry, without disabling the normal relevance path.
- Human approval must consider the whole hostname: this mechanism cannot distinguish publishers sharing one user-generated-content host. Do not approve a broad multi-tenant host while assuming trust is restricted to one account or path.

### Initial host approval

```text
P4_INITIAL_SOURCE_HOSTS
status: APPROVED
approved_by: human owner
approved_at: 2026-10-05
matching: exact-host-only; subdomains require separate entries
approved_hostnames:
  - openai.com
  - developers.openai.com
  - platform.openai.com
  - anthropic.com
  - docs.anthropic.com
  - blog.google
  - ai.google.dev
  - github.blog
  - github.com
  - devblogs.microsoft.com
  - learn.microsoft.com
  - aws.amazon.com
  - cloud.google.com
  - azure.microsoft.com
  - kubernetes.io
  - nodejs.org
  - python.org
  - go.dev
  - www.rust-lang.org
  - www.typescriptlang.org
rationale: explicitly approved by the human owner for P4 fallback delivery
```

These are the only production registry entries. Subsequent additions/removals
require explicit human approval and a reviewed repository change; nothing may
update the registry automatically. An explicitly approved empty list is valid
and intentionally disables fallback delivery.

### Exact integration point and selection flow

Implement only in the digest selection path of `notifyDigest()` in `src/services/notificationOrchestrator.ts`, called by Phase 3 of `runMonitoringCycle()`. Replace the early returns that currently discard all below-threshold candidates; do not change `isNotificationEligible()` or its threshold.

1. From this cycle's successfully analyzed `status === "new"` results and any approved bounded replay discoveries, deduplicate using the existing source-URL identity behavior and check the existing normalized-URL/email notification history. Exclude previously sent stories. History read errors retain the existing abort behavior; they must not activate fallback.
2. Apply the unchanged normal eligibility predicate (score >= 7) to this fresh-or-replay, unsent pool. If any normal candidates exist, rank with `compareDiscoveryPriority()`, take up to four, and send the ordinary digest. Trust neither excludes unknown normal sources nor promotes below-threshold sources.
3. Only when that normal pool is empty, apply `isTrustedFallbackSource()` to the fresh-or-approved-replay, unsent analyzed pool. Do not reconsider ordinary duplicates, expired/out-of-window discoveries, failed analyses, unanalysed search results, or previously sent stories.
4. Rank trusted fallback candidates with the existing P3 comparator and stable tie behavior, retaining the original relevance scores; take up to four. No separate trust score, priority bonus, new minimum relevance threshold, or extra analysis/search is introduced.
5. If the fallback pool is empty, return without sending. Otherwise use a digest-formatting mode explicitly selected by the orchestrator and render the literal label `It could be relevant` visibly in both HTML and plain text. Preserve safe source-link rendering and the existing lead/concise story layout. Default formatting remains normal.
6. Reuse the existing single-send and per-story notification-history recording path, channel, error handling, and accepted send-before-record trade-off. A fallback notification prevents a later duplicate email exactly as a normal notification does. Do not add fallback retries or a second email.

### Preserved behavior and later Builder scope

Preserve P0's HTTP-503 retry behavior and accounting, P1's up-to-four-story single digest, P2 Brave limits, P3 Codex/Claude Code selection and ordering, the four-new-analysis cap, existing deduplication and notification history, source-integrity checks, and normal threshold 7. This task does not implement P5 or authorize Cloudflare, secret, deployment, schema, quota, or provider changes.

Implemented P4 files and responsibilities:

- `src/config/trustedSources.ts` and `src/services/sourceTrust.ts`: approved static registry and deterministic fail-closed predicate.
- `src/services/notificationOrchestrator.ts`: fallback selection and explicit formatting mode; existing normal single-story eligibility stays unchanged.
- `src/services/discoveryEmailFormatter.ts`: optional normal/fallback mode, default normal, visible fallback label in both representations. Keep the mode type local unless existing shared types require it.
- `test/sourceTrust.test.ts`, `test/notificationOrchestrator.test.ts`, and `test/discoveryEmailFormatter.test.ts`: exact-host, orchestration, history, cap, and rendering coverage.
- `README.md` and `docs/self-improvement/PROJECT_STATE.md`: fallback exception and registry maintenance policy. `AGENTS.md` remains unchanged because its governance rules require a separate approved governance handoff.

### Acceptance criteria and offline tests

- An approved canonical hostname returns true; an unknown hostname returns false. Repeated calls with the same registry/URL always return the same boolean.
- Mixed-case hostnames, standard IDNA representation, a single terminal dot, and explicit default ports follow the documented normalization. Parent approval never implicitly trusts a subdomain or `www` host.
- Malformed/relative URLs, unsupported schemes, credentials, IP literals, non-default ports, attacker suffixes, and trusted-looking paths fail closed. Empty/invalid registry enables no fallback; normal delivery still works.
- Synthetic test hosts are explicitly test-only and must not seed the production registry.
- A trusted story below 7 remains normally ineligible. An unknown-source story at or above 7 remains normally eligible. Trust is consulted only for fallback selection, not relevance, analysis-slot selection, or normal digest ordering.
- Any normal fresh-or-replay/unsent eligible story suppresses fallback, even if fewer than four normal stories exist. If all normal-scoring inputs are already sent, only remaining fresh-or-approved-replay/unsent candidates may be considered for fallback.
- With no normal candidate, trusted fresh-or-replay/unsent candidates are ranked using unchanged P3 behavior, capped at four, and visibly labelled `It could be relevant` in HTML and plain text. No trusted candidate means no email.
- Ordinary duplicates, expired/out-of-window discoveries, sent items, and failed analyses cannot enter fallback. Notification-history read failure aborts instead of falling back. Normal and fallback sends use the same dedup/history identity and remain at most one email per cycle.
- Tests demonstrate unchanged stored relevance, threshold 7, P0 retries, P1 formatting, P2 limits, P3 priority, and four-analysis cap. No extra provider calls are introduced.
- Trust requires no LLM, web reputation, DNS, redirect resolution, network access, or provider call. All verification uses offline fixtures and injected send/history dependencies.

**Implementation result:** P4 uses the approved static registry and fail-closed
predicate only after notification-history filtering establishes that zero fresh-or-replay,
unsent candidates meet the unchanged score-7 threshold. Normal delivery remains
unchanged; fallback delivery is capped at four, labelled in HTML/plain text, and
recorded through the existing notification history. P5 remains TODO.

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
| P4 | DONE — use the human-approved exact-host registry and deterministic fail-closed source predicate only when the normal fresh-or-approved-replay/unsent score >= 7 pool is empty. Rank trusted fresh-or-replay analyzed candidates with unchanged P3 ordering, send up to four with visible "It could be relevant" labelling in HTML/plain text, or send nothing. Unknown sources remain eligible through the unchanged normal path. Preserve caps, integrity, deduplication, and notification history. |
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
