# Brave bounds — sequential TDD implementation plan

2026-11-11. HUMAN REVIEW / NOT AUTHORIZED TO IMPLEMENT. [Design](../specs/2026-11-11-brave-request-bounds-design.md). Five tasks; native Builder followed by one independent final Analyst review. No new worktree, subagent, runtime feature, retry or live call. Exact approved Builder baseline/branch must be recorded after design approval; the present local design branch is not runtime authorization.

## 1. Pin accounting and transport contract, then deadline

Read current source, usage guard/store, monitor, Worker wiring and tests. Preserve protected SHA and inspect status before editing. Add meaningful failing deadline tests in `test/webSearch.test.ts`: headers never settle, body stalls after successful headers, late headers, late rejection, exact clock boundary, cancellation rejection. Inject fake fetch/stream and controlled clock/timers (minimal optional test dependencies if necessary); never wait on a live provider. Prove one call, zero records pre-header timeout and one record after observed successful headers. Add the 5-second controller/deadline and fixed error class. Record actual RED output and GREEN results. Existing successful/accounting regression tests may be green throughout; do not fabricate RED.

## 2. Bound success and error bodies

RED: Content-Length at/exceeding cap, invalid/unsafe length, absent header, misleading small header with large stream, exact boundary and cap+1, oversized individual chunk, non-ASCII byte counts, timeout mid-body, truncated UTF-8, malformed JSON, valid empty results and invalid envelope. Exercise 256 KiB success and 16 KiB error caps independently. Verify no read after limit, cancellation requested and locks/timers released. Implement bounded read and strict decode/parse for successes; drain/discard errors safely, never expose body/statusText. Assert malformed 2xx still records exactly once before returning failure.

## 3. Redirect, failure isolation and accounting races

RED: 301/302/307/308 have manual redirect, no Location request/credential leak, no usage record. Canary secret/query/provider strings never appear in errors or monitoring failure summaries. Assert usage denial causes zero dispatch, record rejection suppresses all candidates and cancels work, body failure cannot erase a successful-header usage record, and delayed write is never silently abandoned. No duplicate record, retry or pagination under any race. Verify unchanged query count/order, count=5, optional freshness=pw, first-five positions/rawCount, guard-denial stop and other-source isolation using existing monitoring/Worker tests. Implement only narrowly required handling; no usage-store or quota rewrite.

## 4. Real isolated Workerd transport proof

Create a loopback-only harness following existing RSS/email harness conventions. Synthetic receiver supplies valid/malformed/oversized/error/redirect responses and delayed headers/body; count arrivals at origin and redirect destination. Use real Worker fetch with correct receiver, local D1 or the existing fake usage seam as appropriate, no production binding IDs or credentials. Prove stalled body returns bounded failure, successful-header record remains exactly one, redirect target sees zero requests, and no timer/stream leaks prevent shutdown. Test actual 5-second policy at least once; shortened injected unit-test timeouts are not the only runtime proof. Local runtime fixtures are isolated and cleaned without touching protected/history files.

## 5. Final verification and handoff

Inspect all commands/harnesses first; use installed tools only. Required after implementation:

- Focused Node tests for webSearch/Batch/Worker and the new Workerd harness.
- Full `npm test`; additionally enumerate `test/**/*.test.ts` recursively and invoke installed tsx on the explicit sorted list if shell glob omits nested tests. Report both inventories/results. Do not change package test discovery here; that accepted Claude correction belongs to roadmap task 6.
- `npm run build`; `npm run worker:typecheck` (review regenerated bindings; exclude unrelated output).
- Existing isolated RSS, Gemini/RSS telemetry, OpenAI fallback, Threads and email-delivery Workerd harnesses, plus Brave harness, with loopback-only fixtures and no live provider egress.
- Installed Wrangler deploy **--dry-run** to a temporary output directory with metrics disabled; verify command remains dry-run. Inspect bundle for forbidden local persistence/Node filesystem/dotenv/OpenAI SDK dependencies and secrets. Do not publish/upload.
- Scoped diff, `git diff --check`, protected checksum, exact branch/base/head and changed-file inventory. Tests need not be rerun in this Architect phase; none are claimed now.

Record RED/GREEN results, command exits, accounting residual limitation and deviations in DAILY_SUMMARY. Stop for one independent Analyst review (requested Terra High where available); do not self-approve or merge. Analyst must confirm all design acceptance points, one-request proof and no changes outside authorized scope. Only after human design/Builder authorization may local implementation/commit proceed. Push, merge, migration, secrets and deployment remain separately gated. Do not start feedback or the next roadmap task automatically.
