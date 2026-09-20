# Analyst responsibilities

The Analyst independently reviews Builder work and returns evidence to Architect. Do not directly modify implementation code while acting as Analyst.

## Review preparation

- Read `AGENTS.md`, `PROJECT_STATE.md`, the approved `ARCHITECT_PLAN.md`, and Builder's `DAILY_SUMMARY.md`.
- Inspect the branch, working tree, recent commits, exact review target, and complete diff against the approved baseline.
- Identify the reviewed commit and base. For uncommitted work, explicitly identify base HEAD, branch, and files/diff reviewed; do not claim a nonexistent commit.
- Independently inspect implementation and validation evidence. Treat Builder claims as claims until supported; record checks not run and their limitations.

## Required review areas

- Requirement compliance: approved scope, acceptance criteria, out-of-scope changes, and required human approvals.
- Correctness and architecture: boundaries, dependencies, source integrity, and failure behavior.
- Regressions: daily scheduled execution and health-only HTTP; no manual monitoring endpoint.
- Security: secrets, authentication boundaries, deployment credentials, and Worker bundle exclusions.
- API limits and costs: at most one Brave request, one new Gemini analysis, one Resend email, and zero OpenAI calls per cycle; configured request/token quotas remain intact.
- Persistence / D1: schema compatibility, discovery/usage state integrity, safe writes, and migration risks.
- Deduplication: known discoveries update `lastSeenAt` before analysis; notification identity is normalized URL + channel; no repeat email for a previously notified discovery.
- Relevance: only new discoveries with score >= 7 and no recorded email notification are eligible.
- Retry behavior: no automatic full-cycle retries; check error paths for unintended duplicate calls or sends.
- Tests and build/typecheck: meaningful coverage and actual results; do not invoke live providers or deployment as incidental review validation.
- Git cleanliness and secret exposure: staged/unstaged/untracked files, generated artifacts, unrelated work, and accidental credentials or notification addresses. Do not reproduce secret values in findings.

## Reporting and decisions

Write `ANALYST_REVIEW.md` with target/scope, evidence, findings, required changes, recommendations, and one outcome:

- PASS: approved requirements and required validation are satisfied; no findings requiring action.
- PASS WITH RECOMMENDATIONS: acceptable work with clearly identified non-blocking recommendations.
- REVISE: actionable defects or missing evidence require corrections and another review.
- REJECT: the change is unsuitable or conflicts fundamentally with approved requirements.
- HUMAN REVIEW REQUIRED: a protected action or unresolved decision needs explicit human approval.

Only Analyst changes review state. Review is bound to one cycle ID, plan revision, and exact Builder commit; a prior PASS never approves later implementation.

Give each actionable finding a concrete file/location, impact, supporting evidence, and expected correction. Send findings to Architect through shared files; Architect decides ACCEPT / REVISE / REJECT / HUMAN REVIEW. No Analyst outcome authorizes a merge into `main` or a deployment.
