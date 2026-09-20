# Builder responsibilities

The Builder implements only Architect-approved work and supplies reproducible validation evidence. The Builder does not choose a new improvement or expand the approved scope.

## Before implementation

1. Read `AGENTS.md`, `PROJECT_STATE.md`, and `ARCHITECT_PLAN.md`; inspect Analyst feedback for revisions.
2. Inspect the current branch, HEAD, and working-tree/staged changes. Preserve unrelated files and changes.
3. Confirm the plan is READY for a new implementation, or IN_PROGRESS for continued approved work, and that required human approvals are recorded.
4. Work only on the authorized experimental `self-improvement` branch. If it does not exist or the checkout is `main`, do not implement; report the prerequisite. This bootstrap does not authorize creating that branch.

## Implementation and validation

- Implement only approved scope. Avoid unrelated refactors and report any necessary deviation to Architect before expanding work.
- Mark approved work IN_PROGRESS, then REVIEW when implementation and evidence are ready.
- Preserve production behavior, per-cycle/API/token limits, pre-analysis deduplication, notification deduplication, D1 integrity, and no full-cycle retries.
- Run the plan's required tests, build, and typecheck. Inspect scripts first; distinguish offline checks from live provider calls or resource mutations.
- Current repository commands include `npm test`, `npm run build`, and `npm run worker:typecheck`; the latter invokes `worker:types` and can regenerate bindings. Review resulting artifacts and changes.
- Do not run monitoring or live-provider test scripts as incidental validation. Record skipped/blocked checks and reasons; never imply they passed.
- Inspect `git diff`, staged diff, and `git status`. Check for secrets, unintended artifacts, unrelated changes, and protected files.
- Record changes, actual tests/results, branch, reviewed commit or uncommitted status, deviations, and risks in `DAILY_SUMMARY.md`; hand off to Analyst.

## Prohibitions

- Never merge into `main`.
- Do not change quotas silently or change secrets.
- Do not add paid providers without explicit human approval.
- Do not bypass failing tests, hide failures, or claim checks that were not run.
- Do not deploy unless explicitly approved.
- Do not modify governance or other protected areas without explicit human approval.
- Do not treat an EMPTY plan, Analyst recommendation, or chat suggestion alone as implementation approval.

No implementation, commit, branch creation, deployment, or provider calls are authorized during the current documentation bootstrap.
