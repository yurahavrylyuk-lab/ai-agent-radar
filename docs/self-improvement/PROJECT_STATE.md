# AI Agent Radar project state

## Authority and verification provenance

This file is the durable source of truth for the production baseline, architecture, limits, safety rules, and approval boundaries. Update it only with verified evidence and the required authorization; distinguish intended changes from deployed facts.

Current verified production deployment (2026-10-20): source `f81d6ac0d24baa843e9140a20a1ff00e8f535377`, Worker version `dd57f18a-7443-431d-b6bb-ae4d5ece4d8f`, deployment ID `33a93550-71fc-4753-8c2d-d2a1d405d460`, deployed at `2026-10-20T08:27:08.479492Z` with 100% traffic. Cron remains `0 8 * * *`; D1 remains `9fb545e2-2f43-4922-8b21-2d79a8de9556`; health returned `AI Agent Radar worker ready`. This deploy includes Batch low-relevance delivery, but no natural scheduled cycle has yet been observed on `f81d6ac`; that behavior is **DEPLOYED / awaiting natural-cycle validation**.

The latest verified natural cycle ran earlier, from `2026-10-20T08:00:49.466Z` through `2026-10-20T08:01:22.310Z`, on source `244862880eb35300532cf75917d2936668d39409` and Worker version `eec530db-ffea-4a96-9d0e-73439610f923`. It completed 10/10 Brave searches; GitHub Changelog and Chrome for Developers RSS succeeded; OpenAI and Cloudflare AI reached `body_limit`; and five valid RSS candidates entered the shared pool. Gemini ended `provider_failed` with `confirmed_zero`, so no digest/email was produced. This cycle production-proved the RSS native-fetch receiver fix, not the later low-relevance deployment.

P5, Batch Gemini, and RSS discovery are production-proven. Migration `0004_x_discovery.sql` remains intentionally unapplied and X is disabled/deprecated with zero production dependency. The Gemini accounting incident is resolved: `usage_unknown=0`, rows 19 and 21 remain historical timeout ambiguity evidence, and row 22 is the exact-identity recovered `confirmed_zero` record.

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
→ multi-query Brave Search + bounded RSS discovery
→ shared canonical URL/history deduplication
→ bounded pool (maximum 50 candidates / 32 KiB prompt)
→ at most one Gemini batch dispatch
→ at most four selected stories
→ D1 discovery persistence
→ at most one Resend digest
→ D1 notification history
```

- Worker entry point: `src/worker.ts`; Cloudflare configuration: `wrangler.jsonc`.
- Autonomous production schedule: `0 8 * * *` UTC, once daily at 08:00 UTC.
- Public HTTP fetch returns only `AI Agent Radar worker ready`.
- HTTP requests must never trigger monitoring. There is no manual monitoring endpoint.
- Each successful scheduled run emits exactly one structured, secret-free cycle summary with aggregate counts and bounded outcome status details. It excludes source URLs and content, redacts configured secret values and email addresses, and truncates error text.
- Before new discovery, a scheduled cycle performs one read-only Gemini availability preflight after bounded replay lookup. If Gemini is locally blocked, the summary records a bounded `geminiBlockedReason`; Brave and fresh analysis are skipped, while eligible stored replay can still use the ordinary one-digest delivery path. A completed replay-only cycle is not proof that Gemini is available.
- Each cycle performs one bounded recent-discovery lookup so an analyzed but unnotified discovery can re-enter the shared digest without Brave rediscovery or Gemini re-analysis. Replay adds no provider request and does not create a second email.
- Default multi-query monitoring records isolated non-quota Brave failures by one-based query ordinal and continues sequentially so successful query results still reach normal deduplication, analysis, and notification processing. Each recorded search failure appears in `searchFailures` and increments the aggregate `failures` count. Each query is attempted at most once; there is no query or full-cycle retry. A quota denial still stops further searches without becoming a transient failure. If non-quota failures occur and no usable results were collected, the cycle rejects instead of reporting empty success.
- No automatic full-cycle retries.
- The production-proven Batch Gemini path performs at most one provider dispatch for the fresh batch and can return at most four selected stories for the single digest. The currently deployed `f81d6ac` source permits scores 1–10 and labels a selected score below 7 with `It could be relevant`; that low-relevance behavior is awaiting its first observed natural cycle.
- `runMonitoringCycle()` is the retained legacy per-story path. It is not invoked by the production schedule and is not removed by this documentation reconciliation.

## Providers

- Search: Brave Search.
- Analysis: Google Gemini through the reviewed ordered pool `gemini-3.8-flash`, `gemini-3.6-flash`, and `gemini-3.5-flash-lite`. Runtime environment input cannot add, remove, or reorder models; `GEMINI_MODEL` is deprecated and ignored. The production scheduled Batch Gemini path uses one `gemini-3.8-flash` dispatch with no retry or model fallback. The pool remains restricted to approved included Free Tier capacity; paid fallback is disabled.
- Email: Resend.
- Historical discovery integration: P6 X selected-account polling is implemented but disabled. Production activation is abandoned/deprecated; no X credential or migration activation is planned on the active roadmap.
- Replacement source roadmap: Brave and RSS are active; Threads is the next discovery-source task. P7 remains TODO after Threads.
- OpenAI: not used in the cloud production execution path. Local legacy tooling/dependencies do not authorize inclusion in the deployed Worker runtime.

## RSS production checkpoint

RSS discovery is implemented and deployed. The registry contains exactly four approved first-party feeds (OpenAI News, GitHub Changelog, Cloudflare AI, and Chrome for Developers) in fixed order. Collection remains bounded to five configured feeds, five item positions per feed, one request with no retry or redirect, a 5-second request-through-body deadline, and 256 KiB per feed. Failures are isolated from Brave and expose only bounded allowlisted telemetry. The Workerd native-fetch receiver issue is fixed by injecting a receiver-safe wrapper.

Brave and RSS observations enter the same canonical URL/history/notification deduplication path before deterministic interleaving into the 50-candidate, 32 KiB prompt. The scheduled path retains one Gemini dispatch maximum, four selected stories maximum, and one email maximum. The implementation adds no D1 schema or migration, does not use X or migration `0004`, and does not add Threads behavior.

Production evidence from the natural 2026-10-20 cycle proved that GitHub Changelog and Chrome for Developers succeeded and valid RSS candidates entered the shared Gemini pool. OpenAI and Cloudflare AI reached the bounded `body_limit`; those feeds remain follow-up reliability work. This evidence does not claim all four feeds are fully healthy.

## Limits

Maximum per autonomous monitoring cycle:

- Brave: up to 10 requests (one per `MONITORING_QUERIES` entry; the quota guard stops the loop early if a daily/weekly/monthly limit is reached).
- Batch prompt: at most 50 submitted candidates and 32 KiB (`32,768` bytes).
- Gemini: at most one fresh-batch provider dispatch, returning at most four selected stories; known/duplicate URLs do not enter the submitted batch.
- Gemini provider attempts: one maximum for the scheduled fresh batch. Historical retry/fallback behavior remains documented for older execution paths but is not used by the production Batch Gemini cycle.
- Resend: 1 email.
- OpenAI: 0 calls.
- X: 0 calls. The implementation remains disabled and its production activation is deprecated.

Approved repository Brave request limits for P2:

- Daily: 10.
- Weekly: 100.
- Monthly: 350.

Cloudflare production uses the approved Brave limits: daily 10, weekly 100, monthly 350.

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
- New discoveries may enter the single bounded Gemini batch; at most four validated stories are accepted for delivery.
- Notification identity: normalized URL + notification channel.
- A previously notified discovery must not generate another email.
- Scheduled Batch delivery accepts Gemini-selected stories with scores from 1–10. A selected score below 7 is delivered with `It could be relevant`; scores at or above 7 retain normal rendering.
- Fresh Batch selections persist exact optional provenance `batchSelectionProvenance?: { kind: "batch" }`. Replay permits a low-score story only when this marker is present and valid. Legacy low-score records without the marker remain ineligible, although all bounded aliases still contribute notification-history evidence so an ineligible record can prevent a duplicate resend without becoming a delivery representative.
- The retained legacy `runMonitoringCycle()` path keeps its existing score-7 normal eligibility and P4 trusted-source fallback behavior; it is not the production scheduled path.
- Replay candidates use immutable `firstSeenAt` and must be both within 72 hours of the cycle-start instant and on/after the immutable activation cutoff `2026-10-06T16:00:00Z`. Discovery lookup is newest-first with normalized-URL tie-breaking, capped at 100 with no pagination. Fresh and replay candidates deduplicate by normalized URL, use one P3-ranked four-story pool, and produce at most one digest. Stored relevance is unchanged.
- In the retained legacy per-story path, P4 adds one bounded fallback exception after notification-history filtering: only when zero fresh-or-replay, unsent analyses meet the normal threshold, up to four below-threshold candidates from currently human-approved exact hostnames may be sent in one digest labelled `It could be relevant`. Trust is rechecked at replay time. This rule does not gate scheduled Batch selections.
- The versioned fallback trust registry is static and provider-independent. It uses exact HTTP(S) hostname equality only; it infers no parent, subdomain, or `www` trust. Unknown, malformed, unsupported, credentialed, address-based, or non-default-port sources fail closed. Trust does not change stored Gemini relevance or normal eligibility.
- In the retained legacy per-story path, P3 gives unique unseen Brave candidates with explicit Codex or Claude Code matches a bounded deterministic priority signal before analysis slots are assigned. At most two of four positions are reserved by this signal; generic candidates retain stable search order and fill remaining slots, while preferred candidates may use otherwise-empty positions.
- P3 digest ordering gives Codex and Claude Code discoveries a deterministic bounded priority signal without mutating stored Gemini relevance. In the scheduled Batch path this ordering does not exclude selected stories below 7.
- P3 topic coverage includes AI/ML (including Gemini, GPT, and open-source models), IT/infrastructure (cloud, DevOps, Kubernetes, networking, and security advisories), programming releases, and developer tools/workflows (IDEs, CLI, CI/CD, code review, productivity tooling, techniques, and tutorials).
- P5 is DONE. The implemented multi-query Brave path keeps the ten-query/ten-request ceiling, applies `freshness: "pw"`, and interleaves five targeted official-source queries (OpenAI, Anthropic, Google AI, GitHub Blog, Microsoft) with five broad queries. Its observations join RSS before the shared Batch candidate cap and deduplication rules.
- P6's historical implementation polls only the five approved X user IDs and retains its reviewed bounds, normalization, provenance, and fallback exclusions. It is disabled, its activation is deprecated, and it is not part of the active production source roadmap.

## Persistence

Production persistence uses Cloudflare D1 for:

- Discoveries.
- Notifications.
- Brave usage.
- Gemini usage.
- Gemini usage state.
- Historical P6 X tables would exist only if `0004_x_discovery.sql` were applied; that migration is intentionally unapplied.

Gemini usage migration `0003_gemini_usage_model.sql` adds nullable exact-model attribution. Production has applied `0005_gemini_ambiguity_accounting.sql`, `0006_gemini_timeout_admission.sql`, and the exact-identity `0007_row22_exact_recovery.sql`; `0004_x_discovery.sql` remains intentionally unapplied. Migration 0006 permits a safe new reservation after a timeout ambiguity's UTC day without rewriting the ambiguity. Migration 0007 recovered only the proven non-dispatched row 22 to `confirmed_zero` and restored the generic transition protection in the same migration. Historical Gemini rows remain durable and continue to count in their applicable accounting windows.

New dispatches use explicit UTC calendar-day, Monday-start-week, and calendar-month accounting. A D1-atomic conditional insert admits at most one exact-model `reserved` request after rechecking the legacy latch, unresolved ownership, cycle allowance, and all request/token ceilings. Exact provider usage settles `reserved -> exact`; reviewed retry/fallback non-2xx responses settle `reserved -> confirmed_zero`; timeout, network, unreadable usage, and settlement uncertainty remain durably unresolved without guessed tokens. Structured reservations do not toggle the legacy latch.

Every structured Gemini request persists an accounting interval from reservation timestamp through `accounting_through`; request count and exact tokens apply conservatively to every UTC window that interval overlaps. This closes dispatch-boundary crossings without a timing margin or token estimate. A stranded `reserved` row requires exact operator reconciliation to `transport_ambiguous` after termination proof. Non-timeout ambiguity remains blocked until separately reviewed retirement outside all active accounting windows. A valid timeout ambiguity blocks through its `accounting_through` UTC day, remains durable with unknown token accounting, and may coexist with a new reservation beginning the next UTC day subject to every normal quota and safety guard. A retired row blocks again if clock rollback makes its interval active. See `GEMINI_ACCOUNTING_RECOVERY.md`.

The same discoveries table supplies the bounded replay lookup; Proposal 1 adds no migration, retry table, or delivery-attempt table. A successful ordinary notification-history record excludes all later replay. A failed email send writes no success record and can be considered again until expiry. The accepted send-before-history-write ambiguity remains: provider acceptance followed by history failure can allow a later duplicate delivery.

Versioned D1 migrations live in `migrations/`. Local development also supports JSON persistence. Local JSON is not part of the deployed Worker runtime.

## Secrets and bundle safety

Secrets are Cloudflare Worker secret bindings. Record binding names only, never values:

- `BRAVE_SEARCH_API_KEY`.
- `GEMINI_API_KEY`.
- `RESEND_API_KEY`.
- `NOTIFICATION_EMAIL`.
- No X credential is required or planned while the deprecated X integration remains disabled.

Never commit Brave, Gemini, Resend, or X credentials, the notification email address, temporary authentication secrets, or deployment credentials. Do not copy secrets into plans, reviews, summaries, logs, or validation output.

P6/X production activation is abandoned/deprecated. `0004_x_discovery.sql` remains intentionally unapplied, X stays disabled with zero production dependency, and no X credential or paid provider capacity is authorized. The replacement source roadmap is Brave + RSS + Threads.

The production Worker bundle must not include local JSON persistence, Node filesystem modules, dotenv, or an OpenAI cloud dependency. Production must not expose a public/manual monitoring endpoint.

## Gemini blocked-state recovery

`usage_unknown` remains the fail-closed latch for legacy/unattributed uncertainty and corruption; it is never cleared automatically. The accounting incident is resolved and production currently has `usage_unknown=0`. Row 17 remains unchanged legacy evidence. Rows 19 and 21 remain durable timeout ambiguities with unknown token usage, but they do not block admission after their respective `accounting_through` UTC days. Row 22 is `confirmed_zero` only because its exact identity and persisted pre-dispatch evidence were recovered through migration 0007; generic ambiguity clearing remains forbidden. Do not reinterpret historical zero placeholders as proven token usage or make a provider request merely to test availability.

## Production checkpoints

### Latest verified deployment

- Source: `f81d6ac0d24baa843e9140a20a1ff00e8f535377`.
- Worker version: `dd57f18a-7443-431d-b6bb-ae4d5ece4d8f`.
- Deployment ID: `33a93550-71fc-4753-8c2d-d2a1d405d460`.
- Deployment timestamp: `2026-10-20T08:27:08.479492Z`.
- Traffic: 100%.
- Cron: `0 8 * * *`.
- D1 database ID: `9fb545e2-2f43-4922-8b21-2d79a8de9556`.
- Health: `AI Agent Radar worker ready`.
- Low-relevance Batch behavior: **DEPLOYED / awaiting natural-cycle validation**. No natural Cron completion is attributed to this source yet.

### Latest verified natural cycle before that deployment

- Source: `244862880eb35300532cf75917d2936668d39409`.
- Worker version: `eec530db-ffea-4a96-9d0e-73439610f923`.
- Invocation: `2026-10-20T08:00:49.466Z` through `2026-10-20T08:01:22.310Z`.
- Brave: 10/10.
- RSS: GitHub Changelog and Chrome for Developers succeeded; OpenAI and Cloudflare AI reached `body_limit`; five valid RSS candidates entered the shared pool.
- Gemini/delivery: `provider_failed` / `confirmed_zero`; no digest and no email.
- Verdict: the RSS native-fetch receiver fix was production-proven. This cycle did not exercise the later `f81d6ac` low-relevance deployment.

### Earlier Batch proof

The natural `2026-10-16` scheduled cycle proved the Batch Gemini production path end to end: 10 successful Brave searches returned 50 observations, one `gemini-3.8-flash` batch dispatch settled exactly, four fresh stories were persisted and delivered in one digest, and the cycle completed with zero failures.

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
