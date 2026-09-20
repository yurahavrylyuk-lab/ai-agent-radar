# Architect Plan

## Status

REVIEW

Allowed statuses: EMPTY / READY / IN_PROGRESS / REVIEW / COMPLETE.
No implementation work is currently approved.

## Improvement Title

GOV-001 — Define the permanent self-improvement handoff protocol

## Motivation

Make role ownership, state transitions, branch policy, and durable handoffs unambiguous.

## Current Problem

Bootstrap wording incorrectly described `self-improvement` as future work and lacked a concrete active-cycle record.

## Proposed Change

Update the approved governance documents only.

## In Scope

AGENTS.md and the eight listed docs/self-improvement Markdown files.

## Out of Scope

Production code/config, Cloudflare/Cron, secrets, providers, deployments, tests/build/typecheck, and `Без назви.md`.

## Files Expected to Change

Only the nine in-scope documentation files.

## Risks

Stale or ambiguous ownership could permit unsafe autonomous work.

## Safety Constraints

No production behavior, deployment, provider calls, merge to main, or changes outside scope.

## Required Tests

Full diff/path audit; `git diff --check`; staged-diff audit; preserve untracked file checksum. Tests/build/typecheck not run — documentation-only scope.

## Acceptance Criteria

All role/state/branch requirements transcribed, only allowed paths changed, no secrets, and Builder handoff recorded.

## Builder Instructions

Baseline `3a6946fe07ea3838488c789cba4c69718b2ed328`; transition READY → IN_PROGRESS → REVIEW; commit/push only documentation scope. Record changed files, validation, deviations, blockers, and exact review target.

## Analyst Focus Areas

Check exact commit, state machine, scope, stale claims, secret exposure, Git cleanliness, and no production effects.

## Human Approval Required?

Yes — explicit bounded governance-update approval conveyed in this task.

## Architect Decision

Pending Analyst review. Lifecycle: EMPTY → READY → IN_PROGRESS → REVIEW. Architect decision pending.

## Builder Handoff

- Changed files: pending Builder record.
- Validation: pending Builder record.
- Deviations: pending Builder record.
- Blockers: none reported.
- Review target: exact Builder commit to be added after commit creation.
