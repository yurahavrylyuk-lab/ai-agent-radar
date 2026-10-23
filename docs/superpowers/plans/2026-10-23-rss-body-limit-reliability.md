# RSS BODY_LIMIT Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native Builder execution task-by-task, then one independent Analyst review. Steps use checkbox (`- [ ]`) syntax. This document does not start implementation.

**Goal:** Admit complete valid feeds up to1 MiB while preserving all existing RSS safeguards and isolating this release from Gemini natural validation.

**Architecture:** Change one frozen global constant. Existing Content-Length and streamed-byte checks automatically use it; preserve full-document SAX/tree parsing and sequential feed collection. Add exact-boundary/structural and local Workerd regression evidence.

**Tech Stack:** Existing TypeScript, node:test/tsx, saxes, Worker/installed Wrangler. No dependency additions.

**Spec:** `docs/superpowers/specs/2026-10-23-rss-body-limit-reliability-design.md`. Human explicitly approved the one-constant approach. Base `353c718a146252be47a2d6fbf926fdfbf3e81598`; branch `codex/rss-body-limit-reliability`, main physical repo, no worktree. Preserve the base governance commit and protected untracked file (SHA-256 `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`).

## Global constraints

- Plan-only now; only docs may be committed. No runtime edit, push, PR, merge, feed/provider call, deployment, D1 or migration operation.
- Future runtime diff must be only `src/config/rssSources.ts`: bodyBytes262144→1048576. Leave rssDiscovery.ts, all registry entries and all other constants byte-identical.
- Preserve feeds5/items5/timeout5000/depth32/elements10000/field8192/title256/snippet768/url2048/age604800000; no redirects/retries, parallel feeds, partial XML, Range, external/entity/article fetch, parser swap or new config override.
- No Gemini/Brave logic, prompt, accounting, latency, delivery or other roadmap work.0008 remains applied,0004 intentionally unapplied; no migration needed.
- Production remains Gemini-only `223a1b90b9d64483b47717bd02a9d9c334fd3e0d`, Worker `b8f02106-f558-43a2-a428-529b2051512f`, deployment `44a6b945-07ba-4154-877a-433949ce4e5f`, DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION.
- **No RSS deployment on2026-10-23.** First validate2026-10-24 natural Cron against that exact deployed source. Only a later separate explicit human approval can deploy the RSS build; a pushed/merged branch is not deployment authority. No claim the future Cron has happened.

## File map and review focus

Runtime: modify only `src/config/rssSources.ts`.
Tests: modify `test/rssDiscovery.test.ts`, `test/workerd/rssFetchReceiver.test.mjs`, `test/workerd/rssFetchReceiver.worker.ts`. The latter two are needed to exercise sequential near-limit documents in actual Workerd rather than infer safety solely from Node parsing. No test config/package changes.
Governance after implementation: backlog.md, plan.md, docs/self-improvement/PROJECT_STATE.md, DAILY_SUMMARY.md, CHANGELOG.md.

Review focus: exact-byte fixtures must not violate field limits accidentally; underreported headers must not bypass streamed limits; overflow must cancel a still-open stream; malformed trailing XML must invalidate retained items; sequential tree-heavy Workerd runs must not retain entire feed trees through results. Tests in Tasks1–2 cover these five concerns.

### Task 1: TDD limit change and collector safety

**Files:** `src/config/rssSources.ts`, `test/rssDiscovery.test.ts`. **Interfaces:** production APIs remain `collectRss({now,fetch,feeds?})` and `parseRssFeed(xml,feed,now)` unchanged. Test-local `documentAtBytes(format: 'rss' | 'atom', bytes: number): string` builds valid fixed-date item(s), then distributes ASCII padding among ignored child elements with text<=4096 bytes; final residual padding makes TextEncoder byte count exact. Do not place1 MiB in one field. Use actual approved fixture hostname/time; no live source data.

- [ ] RED add `accepts_large_complete_rss_and_atom`: valid262145,524288 and1048576-byte bodies, both with missing and accurate Content-Length. Assert reason ok and expected retained item identity, not merely absence of body_limit. Assert fixture byte count exactly matches the numeric target. Update complete RSS_LIMITS deepEqual only for bodyBytes1048576.
- [ ] Add `stream_overflow_cancels_and_isolates`: missing header and underreported header variants, chunks totaling1048576 followed by one extra byte, stream remains open after overflow. Assert body_limit, cancellation called, zero observations from failed feed; following healthy feed succeeds; one fetch per feed and correct failed/succeeded metrics. Rejected/stalled cancel must not replace/delay primary failure; reuse existing fake-timer cancellation patterns.
- [ ] Add `oversized_declared_length_never_reads_body`: Content-Length1048577, body reader/fetch spies prove zero body reads before body_limit; next feed runs. Pin existing safe behavior for non-numeric, negative, fractional and empty header values; missing header is allowed only through actual byte validation. Invalid lengths retain current body_limit classification; do not “fix” header parsing in this task.
- [ ] Add `large_valid_prefix_does_not_allow_invalid_tail`: >256 KiB valid prefix containing first5 valid item positions followed by malformed tail or missing closing tags, total<1 MiB; collector rejects parse, emits no partial observations. Add depth33, elements10001,8193-byte text and attribute fixtures each<1 MiB; assert structure. Include DOCTYPE/entity fixture and URL-metadata canaries; fetch spy must see only configured feed endpoints, never referenced resources.
- [ ] RED command: `./node_modules/.bin/tsx --test test/rssDiscovery.test.ts`. Expected new >256 KiB acceptance/constant assertions fail under262144. Existing safety tests may already pass; do not manufacture failures in those.
- [ ] Minimal GREEN: change only `RSS_LIMITS.bodyBytes` to1048576. Do not change parser/collector. An exact-limit document still must satisfy all other guards; invalid XML cannot be accepted just to make a size test pass.
- [ ] GREEN command: same. Existing fake-clock5000ms header/body timeout and nonblocking cancellation tests stay green; redirects/host/date/first-five-item position tests unchanged. Inspect runtime diff to confirm exactly one numeric value changed.
- [ ] Stage only the two task files; commit `fix: raise bounded RSS document limit to one MiB`.

### Task 2: Local Workerd safety, final verification and governance

**Files:** `test/workerd/rssFetchReceiver.test.mjs`, `test/workerd/rssFetchReceiver.worker.ts`, five governance files above. **Interfaces:** extend existing test-only DiagnosticEnv with optional `RSS_FIXTURE_MODE?: 'single' | 'sequential'`; default single preserves receiver regression. Route through injected receiver-safe fetch to the harness loopback URL only; no production Worker endpoint/config changes.

- [ ] RED add harness scenarios for an exactly1 MiB valid tree-heavy document and streamed1048577 overflow. Generate fixture locally with many bounded ignored elements (e.g.8000 child elements below10000 total, each field<=8192, depth<=32), valid retained item and exact byte padding. Keep response chunks bounded (e.g.16 KiB); use chunked overflow without Content-Length to exercise actual counting. Assert expected runtime observations/outcomes; no external network calls.
- [ ] Add sequential scenario with four distinct validated fixture-feed IDs/endpoints and wrapper mapping them to controlled loopback responses in order: large valid, overflow, large valid, large valid. Assert maximum active fetch/body flow1, four requests total, three successes/one body_limit failure, no runtime resource error, finite completion, unchanged first-five cap. Retain the original native-fetch receiver test and no unexpected secondary requests.
- [ ] RED command: `node test/workerd/rssFetchReceiver.test.mjs`. New scenario wiring initially fails missing fixture-mode/results assertions; acceptance also fails against pre-fix constant if used as a baseline check. No need to modify runtime back to an old value just to force RED. Preserve existing installed Wrangler launch/local-only config, metrics disabled, child/server cleanup and readiness guards; no downloads.
- [ ] Minimal GREEN: implement test-only fixture serving and diagnostic scenario selection. Production collector stays untouched. Near-limit sequential parsing is a practical memory-pressure/Worker compatibility gate, not an exact heap assertion. Avoid brittle elapsed-time SLA tests; no change to production5000ms timeout. If resource/CPU failures appear, STOP and report rather than redesign parser or increase another guard.
- [ ] GREEN commands: `node test/workerd/rssFetchReceiver.test.mjs`; `./node_modules/.bin/tsx --test test/rssDiscovery.test.ts test/batchMonitoring.test.ts test/workerConfiguration.test.ts`. Inspect test scripts before execution; loopback fixtures only.
- [ ] Final verification once after final edits: `npm test`; `npm run build`; `npm run worker:typecheck`; `WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/radar-rss-body-limit-dry-run`; `git diff --check`. Dry-run is bundle validation, not deployment. No production/provider smoke test. Inspect full diff and unchanged config/collector/migration files; preserve generated/unrelated work.
- [ ] Record actual checks and limits in governance as IMPLEMENTED / TESTED / NOT DEPLOYED only when supported. Keep deployed Gemini source/Worker and awaiting-natural-validation status unchanged. RSS successful live acquisition remains unproven; >1 MiB, structural and timeout failures remain possible. Preserve prior historical evidence and permanent Backlog/Plan Actualization Checkpoint.
- [ ] Rehash protected untracked file and confirm excluded from staging. Stage only task test/governance files; commit `test: verify bounded RSS documents under Workerd`. Handoff exact Builder head to independent Analyst review. Later push/merge follow the human-authorized release workflow; this planning turn does neither.

## Release hold and self-review

Every requested acceptance case maps to Task1 (size/header/stream/cancel/full-XML/structure/isolation/telemetry/secondary-fetch/timeout) or Task2 (sequential real-runtime pressure and full verification). The expected production diff is one constant, not a parser change. Memory overhead is bounded but larger than raw bytes; no numerical heap guarantee is claimed. No new migration or runtime dependency.

Separate gates: implementation/test → Analyst → Architect/human review → separately authorized publication/merge as applicable → verify natural Gemini-only Cron2026-10-24 from exact223a1b90b9d64483b47717bd02a9d9c334fd3e0d → later explicit human RSS deployment approval. A failed/inconclusive validation does not auto-release RSS. No manual monitoring as substitute.

Permanent Backlog/Plan Actualization Checkpoint: reconcile backlog.md, plan.md, PROJECT_STATE.md, DAILY_SUMMARY.md and CHANGELOG.md after major merged/deployed/validated milestones, preserving designed/implemented/deployed/naturally validated distinctions. RSS is currently **DESIGNED / PLANNED / NOT IMPLEMENTED YET**; Gemini latency remains **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**.
