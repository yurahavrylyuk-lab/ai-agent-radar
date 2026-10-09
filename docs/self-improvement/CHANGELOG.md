# Self-improvement changelog

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
