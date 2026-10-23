# Self-improvement changelog

## 2026-10-22 — Gemini Reliability V2 implementation ready for review

- Implemented the approved closed V2 failure contract, durable D1 cycle/attempt telemetry, atomic accounting settlement, and bounded same-model retry policy: reviewed proven-zero 503 may reach three total dispatches; 429, timeout, ambiguity, malformed/semantic and accounting failures do not retry.
- Added failure-safe scheduled checkpoints/final outcomes, the approved degraded/status email design, and a deterministic bounded snippet cleaner while preserving one final email attempt, deterministic fallback, replay, discovery, quota and X-disabled behavior.
- Added unapplied migration `0008_monitoring_cycle_observability.sql`, marked **MIGRATION_READY_FOR_HUMAN_APPROVAL**. Disposable SQLite/local Workerd migration and restart evidence passed; no application or production D1 was queried or changed.
- Offline evidence passed: focused V2 254/254, Task 8 acceptance 23/23, Workerd regression, full suite 690/690, build, Worker typecheck, Wrangler dry-run, bundle audit and `git diff --check`.
- Implementation branch only: no provider call, monitoring cycle, production migration/D1 mutation, deployment, push, PR or merge. Production facts remain unchanged and release still requires independent review plus explicit human authorization.

## 2026-10-22 — Gemini Reliability V2 architecture and production actualization

- Architecture/docs only from main `0df2c2399c76b4c7c518119b6a8511a300ef9aee`, branch `codex/gemini-reliability-v2-design`. Added V2 spec; no implementation plan or runtime changes.
- Human production handoff supersedes prior review-pending deployment status: Worker `6129de15-115c-4f61-9a3b-488d26baf301`, deployment `77fbd332-da4a-4862-9608-78cb963883f9`. Natural 2026-10-22 degraded email: four raw fresh stories, zero replay, one acceptance, no resend/crash. Daily delivery guarantee COMPLETED / NATURALLY VALIDATED.
- Rows29/30 confirmed_zero with safe separate accounting prove deployed retry only partially: exact 429/503 is unknown, final summary not durable. Outage telemetry not fully naturally validated; low-score/timeout fallback not exercised.
- Designed conservative closed classification, max3 only for proven-zero 503, bounded exponential jitter/shared time budget, additive D1 cycle/attempt evidence with atomic zero outcome and human migration gate. Current 429 evidence cannot prove a transient window. No quota changes.
- Priority2 reuses existing email design system and safely cleaned snippets. Rewrote exact ten-item roadmap and preserved/expanded the permanent five-document actualization checkpoint. Older entries below remain historical, not current release status.
- Validation: scoped documentation consistency and whitespace checks; runtime tests not run (documentation-only). Unrelated untracked design preserved byte-identically. No monitoring, provider, D1, migration, deployment, push or merge. Design awaits human review before implementation planning.

## 2026-10-21 — Daily digest reliability review corrections

- Preserved ineligible replay records as grouped alias/history evidence while excluding them from delivery representation, closing the notified-alias resend gap.
- Relabelled an otherwise-empty status digest as `discovery_unavailable` only when the existing Brave/RSS source-health contract reports a full operational outage.
- Added focused regressions for both Analyst blockers; provider, quota, retry, acquisition, replay eligibility and one-email behavior remain unchanged.
- No deployment, provider call, monitoring cycle, migration, D1 mutation, push, PR or merge occurred.

## 2026-10-21 — Daily digest reliability ready for review

- Added one final scheduled digest attempt across normal analyzed stories, deterministic degraded raw highlights and truthful status-only outcomes, retaining replay/no-resend and low-relevance behavior.
- Added one same-model retry only after reviewed 429/503 evidence durably settles `confirmed_zero`; the retry uses a separate reservation, 1000–1500 ms bounded backoff and the original shared 90-second deadline. Timeout and uncertain outcomes never retry.
- Added bounded allowlisted delivery/retry telemetry and preserved one-email, four-story, source, quota, accounting and privacy invariants.
- No deployment, provider call, monitoring cycle, migration, D1 mutation, push, PR or merge occurred.


## 2026-10-21 — Daily digest reliability architecture

- Documentation/design only; baseline `4fad7003c6619aa1fdee2b27c0f9cae219a9aa60`, branch `codex/daily-digest-reliability-design`.
- Designed one final normal/degraded/status email attempt; deterministic raw fallback preserves source/history safety and does not fabricate analysis. Proposed a later one-retry exception only after proven durable confirmed-zero 429/503, with separate accounting and a shared 90-second budget.
- Reordered backlog/plan to reliability first and retained the permanent actualization checkpoint. Current source/Worker facts come from the human handoff; new outage telemetry is deployed, not naturally validated. Earlier tracker priorities below are historical.
- Checks: documentation consistency/whitespace and scoped diff inspection; runtime tests not run (no runtime change). Preserved unrelated untracked files. No provider, monitoring, deployment, D1, migration, push or merge action. Design awaits human review; implementation and release are not performed.

## 2026-10-20 — Multi-source discovery outage signaling ready for review

- Added bounded scheduled Batch health states for Brave and RSS plus an explicit outage flag only when both operational sources are unavailable.
- Kept Brave quota denial distinct as `quota_blocked`; partial source failures are degraded, and successful empty acquisition is healthy rather than an outage.
- Preserved shared discovery, replay, Gemini/accounting, selection, and delivery behavior. No deployment, provider call, migration, D1 mutation, push, PR, or merge occurred.

## 2026-10-20 — Bounded Gemini provider-failure observability ready for review

- Added closed Batch telemetry for reviewed confirmed-zero Gemini failures: `resource_exhausted_429` and `unavailable_503`.
- Classification originates only at the existing structured-evidence/accounting boundary and is independently allowlisted by scheduled serialization; arbitrary provider content is not copied into metrics or logs.
- Preserved accounting, dispatch, retry/fallback, timeout, quota, Brave/RSS, replay, selection, and email behavior. No deployment, provider call, migration, D1 mutation, push, PR, or merge occurred.

## 2026-10-20 — Production documentation reconciled

- Updated governance/project tracking to the deployed source `f81d6ac0d24baa843e9140a20a1ff00e8f535377` and current scheduled Batch architecture.
- Marked P5 and RSS production work DONE, recorded the two proven RSS feeds and two bounded `body_limit` follow-ups, and set Threads as the next discovery-source task.
- Documented Batch-selected 1–10 delivery, the `It could be relevant` label below 7, exact Batch replay provenance, and legacy low-score replay exclusion.
- Clarified that X is disabled/deprecated with zero production dependency and unapplied migration `0004`, and that `runMonitoringCycle()` is retained but not scheduled in production.
- Review correction supersedes the historical P6/X Architect plan, distinguishes the pre-deployment `244862...` natural-cycle evidence from the later `f81d6ac...` deployment, and establishes a permanent tracker-actualization checkpoint before the next major roadmap item.
- Documentation only; no runtime, deployment, migration, D1, provider, monitoring, secret, or production mutation.

## 2026-10-10 — Gemini timeout admission ready for review

- Raised the end-to-end Gemini provider deadline to 90 seconds and made a timeout stop further Gemini dispatches in its monitoring cycle without retry, fallback, or invented token accounting.
- Added one shared UTC-day admission policy for timeout ambiguity across preflight, D1, and local JSON. Historical timeout rows remain durable and count as requests; protected non-timeout unresolved states remain fail-closed.
- Added pending migration `0006`, bounded incomplete-timeout accounting diagnostics, exact row-19 and cross-midnight coverage, and disabled-X/no-0004 runtime coverage.
- No deployment, production migration, D1 mutation, provider call, X activation, or production merge occurred.

## 2026-10-09 — Gemini hardening integrated with P6 source

- Converged the accepted P6 source lineage with the already deployed Gemini ambiguity-accounting hotfix while retaining both `0004_x_discovery.sql` and `0005_gemini_ambiguity_accounting.sql`.
- Production remains on hotfix Worker version `6ad65e76-9728-4a2d-aece-15903028ad01`; `0005` is applied, `0004` is not applied, P6/X remains inactive, `usage_unknown=1`, and row 17 remains preserved as legacy accounting.
- This source-only integration does not deploy, migrate, recover Gemini usage, enable X, or call any provider.

## 2026-10-08 — P6 selected-account X integration ready for review

- Added the human-approved five-account immutable-ID registry and a disabled-by-default, bounded X timeline acquisition path with strict normalization, durable conservative usage/cursor/inbox state, and no retries or pagination.
- Added application-owned X provenance across D1/JSON/replay, visible digest attribution, unified four-slot selection, P4 fallback exclusion, and bounded secret-free scheduled metrics.
- Review correction preserves Brave article content while unioning first validated X provenance for same-story observations, and wires durable post-ID resolution for Brave-observed X status URLs without degrading ordinary Brave discovery.
- Final review correction rejects malformed or ambiguous edit aliases and makes seven-day expiry plus the 350-pending payload cap atomic with page/cursor commits in both D1 and local JSON persistence.
- Added unapplied migration `0004`; no credentials, paid credits, live provider request, production migration, Cloudflare/D1 mutation, deployment, P7 work, or production merge occurred.

## 2026-10-08 — Gemini ambiguity-accounting hotfix ready for review

- Added explicit UTC accounting windows and durable `legacy`, `reserved`, `exact`, `confirmed_zero`, `transport_ambiguous`, and retired states without inventing token usage.
- Added D1-enforced single unresolved ownership, atomic admission checks, exact identity settlement, crash-safe blocking, and provider-free retirement after all active windows expire.
- Added migration `0005`, offline lineage evidence, and an incident-specific row-17 runbook whose only eventual mutation is the separately authorized legacy latch clear after `2026-11-01T00:00:00Z`.
- Preserved model ordering, retries/fallbacks, quotas, replay, Brave, Resend, Cron, and health-only HTTP behavior. P6/X is absent from this deployable production-based branch. No production action or provider call occurred.
- Analyst fixup added exact operator reconciliation for stranded reservations and durable interval accounting across final dispatch, retry, and fallback boundary crossings; no heuristic margin or guessed usage is used.

## 2026-10-07 — P5 Discovery Reliability ready for review

- Added the approved ten-query configuration: five interleaved targeted official-source queries and five broad AI/developer-topic queries, all using Brave weekly freshness for monitoring.
- Added a deterministic, bounded official-source pre-analysis opportunity alongside P3's existing Codex/Claude Code priority without changing relevance, trust, replay, quotas, provider behavior, or production configuration.
- No provider call, deployment, Cloudflare/configuration/secret change, D1 migration, or production merge occurred.

## 2026-10-06 — Gemini multi-model fallback ready for review

- Added a reviewed three-model, forward-only Gemini fallback with unchanged per-model 503 retries and conservative model-specific 429 classification.
- Added pre-dispatch exact-model usage reservation/settlement, nullable historical model attribution, migration `0003`, and cycle/provider-attempt observability.
- Preserved global usage limits, four logical analyses, replay's zero-Gemini behavior, Brave/Resend behavior, secrets, Cron, and production configuration. No provider call, migration application, deployment, or production merge occurred.

## 2026-10-06 — Proposal 1 bounded notification replay ready for review

- Added a 72-hour, activation-cutoff-protected, 100-row bounded lookup for analyzed but unnotified discoveries, using existing JSON/D1 discovery data without a migration.
- Fresh and replay candidates now share normalized identity, P3 ordering, the four-story digest cap, P4's current exact-host trust check, and ordinary notification history.
- Added aggregate secret-free replay observability. No provider limits, Cron, secrets, deployment, provider calls, P5, or production merge changed.

## 2026-09-20 — GOV-001 completed

- GOV-001 revision 2 was independently reviewed: Analyst result `PASS` at checkpoint `5137631f44f8888fd4690cad368592110bb396c1`.
- Architect decision: `ACCEPT`; cycle transitioned REVIEW → COMPLETE.
- No production behavior, Cloudflare/Cron/provider-limit, deployment, provider-call, or merge-to-`main` changes occurred.
- Recurring automation remains inactive.

## 2026-09-20 — GOV-001 revision 2 governance correction

- Corrected the valid plan-status declaration and added consistent `BLOCKED` semantics.
- Captured revision-1 Builder handoff evidence and preserved the separate revision-1 Analyst checkpoint/result.
- Recorded the human clarification that the empty unrelated `Без назви.md` was intentionally deleted and requires no preservation or recreation.
- Completed the Builder side of revision 2 at REVIEW; revision-2 Analyst and Architect decisions remain pending.
- No production behavior, Cloudflare/Cron, provider-limit, deployment, provider-call, merge, or automation changes occurred, per the Builder/human handoff evidence.

## 2026-09-20 — Permanent handoff protocol (GOV-001)

- Defined the Human → Architect → Builder → Analyst → Architect → Human handoff protocol and role-owned state machines.
- Established `self-improvement` as the experimental working branch; `main` remains production and human merge authority remains final.
- No production behavior changed, no deployment/provider call occurred, and no automation loop was activated.

## 2026-09-20 — Shared governance and memory bootstrap

- Created the shared governance/memory system: AGENTS.md, PROJECT_STATE.md, ARCHITECT.md, BUILDER.md, ANALYST.md, ARCHITECT_PLAN.md, ANALYST_REVIEW.md, DAILY_SUMMARY.md, and this CHANGELOG.md.
- Recorded the human-provided production baseline and locally inspected repository evidence, with verification provenance.
- Established Architect planning, Builder implementation, independent Analyst review, and explicit human approval for protected actions and production merges.
- Initial plan: EMPTY; no implementation work approved. Initial review: NOT STARTED. No autonomous self-improvement cycle has run.
- No production code or behavior changed. No Cloudflare configuration or Cron changes.
- No Brave, Gemini, Resend, or OpenAI provider calls were made as project execution or validation.
- No deployment. No autonomous branch created yet. No commit created.
- Preserved the pre-existing untracked `Без назви.md` outside the bootstrap scope.
