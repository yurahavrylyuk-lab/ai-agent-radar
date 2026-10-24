# AI Agent Radar project state

## 2026-10-24 — Cross-provider analyzer failover implementation checkpoint

Cross-provider analyzer failover is **IMPLEMENTED / OFFLINE-TESTED / AWAITING INDEPENDENT REVIEW**, not deployed. Source now permits one synchronous native-fetch `gpt-6-luna` attempt only after all three Gemini V2 attempts are durably `unavailable_503` and `confirmed_zero`, D1 grants the single reservation, configured OpenAI request/token limits pass, and the shared cycle-time gate remains safe. It reuses the exact prepared Batch prompt, strict shared result validator, existing degraded fallback and one-email finalizer. All other Gemini failures remain terminal for analyzer failover.

Migration `0009_openai_fallback_usage.sql` is present and **UNAPPLIED**. `OPENAI_API_KEY` is **NOT PROVISIONED**. Production remains source `a1024cb72b1e08c7433e0f954da81f6283f106d3`, Worker `6304ec6a-1fe0-425f-9e0c-3ebd7ba760fa`, deployment `cf8b0acd-1451-4706-b3c4-2040fbf1a60d`; no production query or mutation was performed by this implementation. The optional bounded analyzer-failover snapshot extension requires a compatible-reader rollback check before release. Natural cap/failover evidence is pending a separately authorized release. Older dated entries below are historical where superseded.

## 2026-10-24 — Failover design approved and implementation planned

**CROSS-PROVIDER ANALYZER FAILOVER = DESIGN APPROVED / PLANNED / NOT IMPLEMENTED.** Human approved Gemini → one GPT-6 Luna → existing degraded delivery, with low reasoning, max_output_tokens=12,288 (including reasoning), and a pessimistic12,288+12,288=24,576 spending reservation. This is not a byte-to-token equivalence. [Finalized design](../superpowers/specs/2026-10-24-cross-provider-analyzer-failover-design.md); [five-task TDD implementation plan](../superpowers/plans/2026-10-24-cross-provider-analyzer-failover.md). Structured JSON shape supplements the authoritative shared Batch validator. Proposed0009 accounting migration is specified only in Markdown, not created/applied.

Failover remains the next active build item before Threads. Gemini Latency remains **DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED**; RSS BODY_LIMIT remains **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**. Production remains `a1024cb72b1e08c7433e0f954da81f6283f106d3`, Worker `6304ec6a-1fe0-425f-9e0c-3ebd7ba760fa`, deployment `cf8b0acd-1451-4706-b3c4-2040fbf1a60d`. Observation continues in parallel; no new natural evidence is claimed.

Documentation-only checkpoint: no runtime/test execution, migration creation/application, D1 access, provider inference/feed calls, credentials, push or deployment. Protected untracked SHA remains `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`. Plan approval and later release permissions remain separate. Earlier dated design-only entries are historical; the actualization checkpoint remains in force.

## 2026-10-24 — Cross-provider analyzer failover designed

[Cross-provider design](../superpowers/specs/2026-10-24-cross-provider-analyzer-failover-design.md) is **DESIGNED / AWAITING HUMAN REVIEW**, next active build item before Threads. No implementation plan yet. Proposed Gemini → one GPT-6 Luna attempt → existing degraded finalizer requires all three Gemini503 attempts durably confirmed_zero, sufficient shared time and D1-backed OpenAI quota admission. Proposed new accounting migration is not created/applied; production zero-OpenAI policy is not activated or silently rewritten.

Local main baseline `aaa0543ab1b37f4e64a52231136d9787d8845ca5` preserved on design branch `codex/cross-provider-analyzer-failover-design`. Production source remains `a1024cb72b1e08c7433e0f954da81f6283f106d3`, Worker `6304ec6a-1fe0-425f-9e0c-3ebd7ba760fa`, deployment `cf8b0acd-1451-4706-b3c4-2040fbf1a60d`. Gemini: **DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED**; RSS: **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**. Natural validation continues in parallel, with source attribution. 0004 stays unapplied.

Read-only source inspection and official OpenAI documentation informed the design. No runtime tests were run for documentation-only work. No implementation, provider inference/feed call, D1 access, migration, secret change, push or deployment occurred. Protected untracked design stays excluded and byte-identical at `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`. Backlog/Plan Actualization Checkpoint retained; historical entries below are not new verification claims.

## 2026-10-24 — RSS BODY_LIMIT production release

Production now runs exact source `a1024cb72b1e08c7433e0f954da81f6283f106d3`, Worker version `6304ec6a-1fe0-425f-9e0c-3ebd7ba760fa`, deployment `cf8b0acd-1451-4706-b3c4-2040fbf1a60d`, created `2026-10-24T08:19:22.895645Z`, with 100% traffic. Source annotation, Cron `0 8 * * *`, D1 binding `DB` to `9fb545e2-2f43-4922-8b21-2d79a8de9556`, and exact health response `AI Agent Radar worker ready` were verified. No migration or D1 mutation occurred; `0004_x_discovery.sql` remains intentionally unapplied.

**RSS BODY_LIMIT Reliability = DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION.** The deployed limit is 1 MiB; all other reviewed RSS safeguards remain unchanged. **Gemini Latency Reliability = DEPLOYED / NATURAL VALIDATION CYCLE 1 MIXED.** Cycle 1 ran on preceding source `223a1b90b9d64483b47717bd02a9d9c334fd3e0d`: 24 submitted candidates, 11,191 prompt bytes, low thinking, three reviewed `unavailable_503` attempts settled `confirmed_zero`, no timeout or ambiguity, one degraded email accepted, and 55.441-second runtime. Successful-Gemini latency is not yet naturally validated. Subsequent evidence must identify the new source boundary. No manual monitoring, provider, or RSS call occurred during release.

This section is current production authority; older entries below remain historical point-in-time records.

## 2026-10-23 — RSS BODY_LIMIT reliability implementation

**RSS BODY_LIMIT RELIABILITY = IMPLEMENTED / OFFLINE-TESTED / AWAITING INDEPENDENT REVIEW.** The feature branch changes only global RSS `bodyBytes` from `262144` to `1048576`; complete-document XML validation, sequential feeds, and every other acquisition/parser limit remain unchanged. Production remains on the deployed `262144`-byte source until a later explicit release approval.

[Design amendment](../superpowers/specs/2026-10-23-rss-body-limit-reliability-design.md) and [TDD plan](../superpowers/plans/2026-10-23-rss-body-limit-reliability.md) are implemented with exact-boundary, streaming, cancellation, full-document, structure, and isolation tests plus a local Workerd sequential safety gate. Focused Node RSS tests passed 23/23; focused RSS/Batch/Worker tests passed 82/82; the full suite passed 713/713; build, Worker typecheck, Workerd, and Wrangler dry-run gates passed. No new migration.

Local docs-only main baseline353c718a146252be47a2d6fbf926fdfbf3e81598 is preserved as the parent of branch codex/rss-body-limit-reliability. Production remains source223a1b90b9d64483b47717bd02a9d9c334fd3e0d, Worker b8f02106-f558-43a2-a428-529b2051512f, deployment44a6b945-07ba-4154-877a-433949ce4e5f. **Gemini Latency Reliability = DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION.**

**Release hold:** no RSS deployment2026-10-23. First validate2026-10-24 natural Cron from exact deployed Gemini-only source223a1b90b9d64483b47717bd02a9d9c334fd3e0d; a later separate explicit human approval is required to deploy RSS. Building/testing/review and later authorized push/merge may precede that gate; merge alone is not deployment approval. Future Cron has not been claimed as completed.

Implementation and offline verification only; no feed/provider call, D1/migration action, push, PR, merge or deployment. Protected untracked design remains byte-identical and excluded. Permanent Backlog/Plan Actualization Checkpoint remains in force. Older entries below retain their historical context.

## Authority and verification provenance

This file is the durable source of truth for the production baseline, architecture, limits, safety rules, and approval boundaries. Update it only with verified evidence and the required authorization; distinguish intended changes from deployed facts.

Production source `223a1b90b9d64483b47717bd02a9d9c334fd3e0d`; Worker `b8f02106-f558-43a2-a428-529b2051512f`; deployment `44a6b945-07ba-4154-877a-433949ce4e5f` created `2026-10-23T18:01:16.307406Z`; production D1 `9fb545e2-2f43-4922-8b21-2d79a8de9556`. Post-release Wrangler metadata verified the source annotation, 100% traffic and unchanged D1 binding. Deployment output verified Cron `0 8 * * *`; the health endpoint returned exactly `AI Agent Radar worker ready`.

Daily email guarantee, durable cycle telemetry, durable attempt telemetry and degraded email redesign are **COMPLETED / NATURALLY VALIDATED** (styling is deployed). Gemini Reliability V2 is **DEPLOYED / PARTIALLY NATURALLY VALIDATED**: timeout/accounting/fallback paths exercised, deployed 503 retry path not naturally exercised. Migration `0008_monitoring_cycle_observability.sql` is **APPLIED**; `0004_x_discovery.sql` remains intentionally **UNAPPLIED**, X disabled.

Natural cycle scheduled `2026-10-23T08:00:49.466Z`, completed `2026-10-23T08:03:06.914Z`; reported runtime ~136.4s (scheduled-to-completed wall interval 137.448s; execution start was not supplied). Brave healthy, 10/10, 50 results; RSS degraded, 2/4 feeds succeeded; 60 raw observations, 47 submitted candidates, 24,303 prompt bytes. One gemini-3.8-flash dispatch lasted 75.331s, ended timeout/transport_ambiguous, correctly no retry. Polished degraded email: one attempt, accepted.

Gemini latency reliability is **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**. It deterministically selects at most 24 candidates from the unchanged bounded discovery pool, compacts the prompt to at most 12,288 bytes, uses scheduled low thinking, and records bounded optional latency evidence in the already-applied 0008 snapshot JSON. The full original pool and aliases remain authoritative for degraded fallback and no-resend evidence. No migration or D1 mutation accompanied deployment. No provider or monitoring call was manually invoked; the next 3 eligible natural Cron cycles, extendable to at most 5 scheduled cycles if inconclusive, are the authorized evidence window. No claim is made yet that latency improved, the timeout is fixed, or Gemini success rate changed.

The previously verified 2026-10-20 natural cycle ran earlier, from `2026-10-20T08:00:49.466Z` through `2026-10-20T08:01:22.310Z`, on source `244862880eb35300532cf75917d2936668d39409` and Worker version `eec530db-ffea-4a96-9d0e-73439610f923`. It completed 10/10 Brave searches; GitHub Changelog and Chrome for Developers RSS succeeded; OpenAI and Cloudflare AI reached `body_limit`; and five valid RSS candidates entered the shared pool. Gemini ended `provider_failed` with `confirmed_zero`, so no digest/email was produced. This cycle production-proved the RSS native-fetch receiver fix, not the later low-relevance deployment.

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
→ normally one Gemini batch dispatch; at most three after reviewed 503 with durable confirmed-zero settlement
→ valid analyzed selections persist in D1; raw fallback does not fabricate analysis
→ normal / degraded / status-only finalizer (maximum four stories)
→ at most one Resend attempt
→ D1 notification history
```

- Worker entry point: `src/worker.ts`; Cloudflare configuration: `wrangler.jsonc`.
- Autonomous production schedule: `0 8 * * *` UTC, once daily at 08:00 UTC.
- Public HTTP fetch returns only `AI Agent Radar worker ready`.
- HTTP requests must never trigger monitoring. There is no manual monitoring endpoint.
- Each completed scheduled run emits a bounded durable D1 cycle/attempt record plus a supplementary structured, secret-free console summary with aggregate counts and bounded outcome status details. It excludes source URLs and content, redacts configured secret values and email addresses, and truncates error text.
- The current scheduled Batch path collects Brave/RSS and prepares the bounded shared pool before Gemini availability checking. Admission failure prevents Gemini dispatch; eligible replay remains available. The older pre-discovery preflight description belongs to the retained legacy path.
- Each cycle performs one bounded recent-discovery lookup so an analyzed but unnotified discovery can re-enter the shared digest without Brave rediscovery or Gemini re-analysis. Replay adds no provider request and does not create a second email.
- The scheduled Batch path records isolated Brave/RSS acquisition failures and preserves successful results; Brave quota denial stops further Brave requests. All-source failure is observable through source-health telemetry. Legacy all-search-failed exception behavior is not the scheduled Batch policy.
- No automatic full-cycle retries.
- The production Batch Gemini path performs normally one and at most three provider dispatches for the fresh batch after reviewed 503 with durable confirmed-zero settlement and can return at most four selected stories for the single digest. The current deployed source retains the low-relevance behavior introduced at `f81d6ac` and permits scores 1–10 and labels a selected score below 7 with `It could be relevant`; natural low-score delivery has not yet been demonstrated by the supplied evidence.
- `runMonitoringCycle()` is the retained legacy per-story path. It is not invoked by the production schedule and is not removed by this documentation reconciliation.

## Providers

- Search: Brave Search.
- Analysis: Google Gemini through the reviewed ordered pool `gemini-3.8-flash`, `gemini-3.6-flash`, and `gemini-3.5-flash-lite`. Runtime environment input cannot add, remove, or reorder models; `GEMINI_MODEL` is deprecated and ignored. The production scheduled Batch Gemini path uses `gemini-3.8-flash`, normally one dispatch, with at most two same-model retries only after reviewed 503 and durable confirmed_zero; no model fallback. One 90s envelope has a 75s Gemini cutoff; delays 1500–2000ms then3000–4000ms. 429, timeout, transport and accounting uncertainty never retry. The pool remains restricted to approved included Free Tier capacity; paid fallback is disabled.
- Email: Resend.
- Historical discovery integration: P6 X selected-account polling is implemented but disabled. Production activation is abandoned/deprecated; no X credential or migration activation is planned on the active roadmap.
- Replacement source roadmap: Brave and RSS are active. Daily delivery reliability is deployed and naturally validated. V2 is deployed/partially naturally validated, styling and durable telemetry naturally validated. Gemini latency reliability is deployed and awaits natural validation before RSS body_limit and Threads; see backlog.md.
- OpenAI: not used in the cloud production execution path. Local legacy tooling/dependencies do not authorize inclusion in the deployed Worker runtime.

## RSS production checkpoint

RSS discovery is implemented and deployed. The registry contains exactly four approved first-party feeds (OpenAI News, GitHub Changelog, Cloudflare AI, and Chrome for Developers) in fixed order. Collection remains bounded to five configured feeds, five item positions per feed, one request with no retry or redirect, a 5-second request-through-body deadline, and 256 KiB per feed. Failures are isolated from Brave and expose only bounded allowlisted telemetry. The Workerd native-fetch receiver issue is fixed by injecting a receiver-safe wrapper.

Brave and RSS observations enter the same canonical URL/history/notification deduplication path before deterministic interleaving into the 50-candidate, 32 KiB prompt. The scheduled path retains four stories and one email maximum; deployed V2 retry permits at most three same-model Gemini dispatches under its503 confirmed-zero gate. The implementation adds no D1 schema or migration, does not use X or migration `0004`, and does not add Threads behavior.

Production evidence from the natural 2026-10-20 cycle proved that GitHub Changelog and Chrome for Developers succeeded and valid RSS candidates entered the shared Gemini pool. OpenAI and Cloudflare AI reached the bounded `body_limit`; those feeds remain follow-up reliability work. This evidence does not claim all four feeds are fully healthy.

## Limits

Maximum per autonomous monitoring cycle:

- Brave: up to 10 requests (one per `MONITORING_QUERIES` entry; the quota guard stops the loop early if a daily/weekly/monthly limit is reached).
- Batch prompt: at most 50 submitted candidates and 32 KiB (`32,768` bytes).
- Gemini: normally one fresh-batch dispatch, at most three under the reviewed 503 confirmed-zero retry gate, returning at most four selected stories; known/duplicate URLs do not enter the submitted batch.
- Gemini provider attempts: three maximum for scheduled Batch, separate durable reservations/settlements and unchanged quota guards. Timeout/transport ambiguity never retries. Legacy multi-model retry is not scheduled authority. V2 max 3 is deployed.
- Resend: 1 email.
- OpenAI: current production remains 0 calls. The reviewed-but-not-deployed source permits at most one `gpt-6-luna` call only after the exact Gemini/D1/quota/timing failover gate; it adds no SDK retry or second OpenAI attempt.
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
- Bounded monitoring_cycles and monitoring_gemini_attempts telemetry (migration 0008 applied).
- Historical P6 X tables would exist only if `0004_x_discovery.sql` were applied; that migration is intentionally unapplied.

Gemini usage migration `0003_gemini_usage_model.sql` adds nullable exact-model attribution. Production has applied `0005_gemini_ambiguity_accounting.sql`, `0006_gemini_timeout_admission.sql`, the exact-identity `0007_row22_exact_recovery.sql`, and `0008_monitoring_cycle_observability.sql`; `0004_x_discovery.sql` remains intentionally unapplied. Migration 0006 permits a safe new reservation after a timeout ambiguity's UTC day without rewriting the ambiguity. Migration 0007 recovered only the proven non-dispatched row 22 to `confirmed_zero` and restored the generic transition protection in the same migration. Historical Gemini rows remain durable and continue to count in their applicable accounting windows.

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

The production Worker bundle must not include local JSON persistence, Node filesystem modules, dotenv, or an OpenAI SDK/cloud package dependency. The bounded failover uses native Worker `fetch` only. Production must not expose a public/manual monitoring endpoint.

## Gemini blocked-state recovery

`usage_unknown` remains the fail-closed latch for legacy/unattributed uncertainty and corruption; it is never cleared automatically. The accounting incident is resolved and production currently has `usage_unknown=0`. Row 17 remains unchanged legacy evidence. Rows 19 and 21 remain durable timeout ambiguities with unknown token usage, but they do not block admission after their respective `accounting_through` UTC days. Row 22 is `confirmed_zero` only because its exact identity and persisted pre-dispatch evidence were recovered through migration 0007; generic ambiguity clearing remains forbidden. Do not reinterpret historical zero placeholders as proven token usage or make a provider request merely to test availability.

## Production checkpoints

### Historical verified deployment — 2026-10-20 (superseded by current handoff above)

- Source: `f81d6ac0d24baa843e9140a20a1ff00e8f535377`.
- Worker version: `dd57f18a-7443-431d-b6bb-ae4d5ece4d8f`.
- Deployment ID: `33a93550-71fc-4753-8c2d-d2a1d405d460`.
- Deployment timestamp: `2026-10-20T08:27:08.479492Z`.
- Traffic: 100%.
- Cron: `0 8 * * *`.
- D1 database ID: `9fb545e2-2f43-4922-8b21-2d79a8de9556`.
- Health: `AI Agent Radar worker ready`.
- Low-relevance Batch behavior: **DEPLOYED / awaiting natural-cycle validation**. No natural Cron completion is attributed to this source yet.

### Historical verified natural cycle before that deployment

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
