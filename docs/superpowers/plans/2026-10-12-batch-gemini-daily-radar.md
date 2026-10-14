# Batch Gemini Daily Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-story Gemini analysis with one bounded whole-pool batch analysis that returns up to four useful daily stories.

**Architecture:** Ten quota-permitted Brave searches are combined, validated, normalized, deduplicated and history-filtered. One Gemini provider dispatch ranks and analyzes the bounded fresh pool; the application validates source IDs, persists qualifying stories, fills remaining positions with eligible replay, and sends at most one deterministic digest.

**Tech Stack:** TypeScript, Node.js, Cloudflare Workers, D1, Brave Search, Gemini, Resend, Vitest/existing test stack.

**Spec:** `docs/superpowers/specs/2026-10-12-batch-gemini-daily-radar-design.md`

Stack clarification: the actual repository uses Node 24, `node:test`, `node:assert/strict`, and `tsx --test`, not Vitest. Use the existing stack; do not install Vitest or another dependency. The header above preserves the human-required wording.

Approved source baseline: `801f6d2be1c542d96939fdc8ad75017110126030`. Local HEAD/main matched during plan authoring. The approved spec exists as an untracked document and must be preserved. Production/deployment facts are human-provided; no live verification occurred. This plan is ready for human review, not execution authorization. Only this plan is being authored now.

## Global Constraints

```text
Brave requests per normal cycle <= 10
Gemini provider dispatches for fresh batch <= 1
Resend sends per cycle <= 1
Selected stories <= 4
Normal relevance threshold = 7
Gemini cannot choose source URLs
No new D1 schema migration
X remains disabled and independent
No manual monitoring endpoint
```

- Batch primary model: `gemini-3.8-flash`; no Gemini retry, model fallback, second ranking, repair, or lead enrichment.
- Retain the existing 90-second full interaction deadline and exact/confirmed-zero/reserved/ambiguity semantics, same-day timeout block, guarded next-day admission, and unchanged quota ceilings.
- One batch reservation/request is distinct from up to four selected stories. Actual fetch dispatch is distinct from an abandoned reservation.
- Ten searches precede batch admission; each uses existing Brave quota protection, at most five accepted provider positions, no retries/pagination. Partial failures retain successes.
- Reject root homepages; no P4 below-threshold fallback or final ranking bonus in the scheduled batch path.
- Replay: 72 hours, cutoff `2026-10-06T16:00:00Z`, scan 100, immutable `firstSeenAt`, no reanalysis, notified stories excluded.
- No dependency on `0004`, no X activation, no OpenAI provider path, no changes to Cron (`0 8 * * *`) or the HTTP health response.
- No dependencies, schema changes, quota changes, secrets/configuration changes, provider probes, or automatic recovery. Prompt byte bounds do not assert a hard prospective token guarantee.
- Existing main physical repository only; no worktree/copy. Do not touch `.git/local-backups/ARCHITECT_PLAN.pre-sync.md` or reconcile old Architect records.
- Future tests use fake providers and local fixtures only. Do not execute `monitor`, `dev`, or any `*:test` live-provider scripts. `npm test` is the offline test runner; inspect scripts before execution.
- Production main is protected. The local commit checkpoints below apply only after human approval of this plan and an explicitly authorized execution checkout/branch. This plan does not authorize committing implementation on main, switching branches now, or merging/pushing/deploying. If no compliant execution branch is designated, resolve that before Task 1; do not invent a worktree or change main to satisfy a checkpoint.

## Review Focus

1. Near-limit Unicode and JSON-escaped input: count the complete serialized prompt, keep code points intact, and never restore snippets during later shrinking stages — Task 2, `RF1 Unicode and escaping at the prompt boundary`.
2. Historical fragment aliases and notifications: evidence on any observed alias blocks fresh reanalysis/delivery; durable keys and `firstSeenAt` remain unchanged — Tasks 1/6, `RF2 notified alias excludes the group`.
3. Provider success with invalid batch content: exact usage stays settled once, no discovery is persisted, no repair request occurs — Tasks 3/4/7, `RF3 invalid analysis after exact provider settlement`.
4. Reservation without dispatch and concurrent accidental invocations: an abandoned reservation consumes its existing allowance, fetch count stays zero, and a second invocation cannot obtain a second reservation — Task 4, `RF4 reservation is not dispatch`.
5. Partial persistence and last-moment notification evidence: unpersisted/notified leads are excluded, existing eligible content is promoted, replay fills gaps, and no second model/send occurs — Tasks 5/6/7, `RF5 persistence and final eligibility race`.

## File structure and execution boundaries

Implement eight sequential, independently testable tasks. Fresh review gates are useful between them; do not parallelize edits to shared types or Worker/monitor files.

| Files | Responsibility / owning task |
| --- | --- |
| `src/types/index.ts` | In-memory batch, page, selection, delivery, and metrics types; Tasks 1–3/6–8 |
| `src/tools/webSearch.ts` | Bounded page result/provenance without extra request; Task 1 |
| `src/services/batchCandidates.ts` (new) | Runtime-neutral URL grouping, source evidence, stable IDs; Task 1 |
| `src/services/batchPrompt.ts` (new) | Pure prompt serialization/UTF-8 bounding; Task 2 |
| `src/services/analysisAgent.ts` | Strict batch parser and single generator call; Task 3 |
| `src/tools/llm/gemini.ts` | Batch execution policy around existing accounting machinery; Task 4 |
| `src/services/discoveryProcessor.ts` | Persist already-validated analysis without generation; Task 5 |
| `src/services/notificationOrchestrator.ts` | Batch-only fresh/replay delivery entry point; Task 6 |
| `src/services/discoveryEmailFormatter.ts` | Batch digest presentation using current blocks; Task 6 |
| `src/services/monitor.ts`, `src/worker.ts` | Scheduled batch composition and metrics; Tasks 7–8 |
| `test/batchCandidates.test.ts`, `test/batchPrompt.test.ts`, `test/batchAnalysis.test.ts`, `test/batchMonitoring.test.ts` (new) | Focused offline batch contracts |
| Existing tests listed in each task | Adapter/accounting/persistence/delivery/Worker regressions |
| `docs/superpowers/plans/2026-10-12-batch-gemini-daily-radar.md` | Later task progress and validation evidence, without modifying the approved spec |

Keep `AgentAnalysis`, discovery DB serialization, canonical normalization, migrations, quota guards, and replay constants unchanged. Reuse existing history interfaces. New helpers are in-process code, not services or dependencies.

Compatibility boundary: current `runMonitoringCycle`, `processSearchResult`, `analyzeSearchResult`, and `generateWithGemini` have local/legacy/X callers. Keep their public contracts and unrelated tests intact. Add explicit batch entry points and wire the scheduled Worker exclusively to them. This is the approved bypass of obsolete behavior in the active scheduled path, not permission to enable another path or remove X implementation. No dynamic error fallback from a batch entry point to a legacy entry point is allowed. Retaining legacy code is limited to avoiding unrelated changes.

## Test conventions and preflight for future execution

Each task follows RED → minimal change → GREEN → related regressions → checkpoint. A RED run must fail for the intended missing behavior, not environment errors. Test names below are normative; assertion excerpts use local fixtures named in that task. Fixtures use reserved `example.test` URLs, fake credentials, fixed dates, and injected fetch/history/send functions. No test imports a live local runner.

Before execution, verify baseline ancestry, approved spec, branch authorization, working/staged changes, installed Node 24 and locked dependencies. Preserve unrelated files. Do not run install commands during plan authoring. Future setup may use the locked offline command under Final Verification; if cache is incomplete, stop and report the setup blocker instead of downloading without authorization.

Each checkpoint means: pass the listed tests and `git diff --check`; inspect only the task's explicit file diff; stage only those paths; inspect `git diff --cached` and `git diff --cached --check`; commit using the given message on the authorized experimental branch. Never use `git add .`. Exclude generated outputs, unrelated work, the protected backup, and pre-existing untracked docs unless separately authorized to checkpoint them. Do not push.

### Task 1: Bounded Brave observations and history-filtered candidate IDs

**Files:** Modify `src/tools/webSearch.ts`, `src/types/index.ts`, `test/webSearch.test.ts`; create `src/services/batchCandidates.ts`, `test/batchCandidates.test.ts`.

**Interfaces:** Add the following in-memory types to `src/types/index.ts`:

```ts
interface BraveSearchPage {
  rawCount: number;
  positions: Array<{ resultOrdinal: number; result: SearchResult | null }>;
}
interface BatchObservation { queryOrdinal: number; resultOrdinal: number; result: SearchResult | null }
interface BatchCandidate {
  candidateId: string;
  source: SearchResult;
  normalizedUrl: string;
  aliasKey: string;
  aliases: string[];
  provenance: Array<{ queryOrdinal: number; resultOrdinal: number }>;
}
interface CandidatePool {
  candidates: BatchCandidate[];
  observedAliases: ReadonlyMap<string, readonly string[]>;
  counts: { acceptedObservations: number; invalid: number; homepages: number; duplicates: number; known: number };
}
```

Add `searchWebPage(query: string, dependencies?: SearchWebDependencies): Promise<BraveSearchPage>` in `webSearch.ts`. Preserve `searchWeb(...): Promise<SearchResult[]>` as a projection of the same single request, not a second fetch. Slice raw result positions to five before field filtering; `null` represents unusable source fields and preserves result ordinals. `rawCount` is the parsed result-array length. Map only those five positions; reject malformed non-array results safely. Optional description/date fields are strings or absent, never untrusted objects.

Add in `batchCandidates.ts`:

```ts
function batchAliasKey(url: string): string; // canonical URL with fragment cleared; throws if invalid
function isBatchNewsUrl(url: string): boolean; // HTTP(S), no credentials, <=2048 bytes, non-root
async function prepareBatchCandidates(
  observations: readonly BatchObservation[],
  dependencies: {
    history: DiscoveryHistory;
    notificationHistory: NotificationHistory;
    seenAt: Date;
  }
): Promise<CandidatePool>;
```

**Decisions:** Valid ordinals are queries 1–10/results 1–5; duplicate ordinal pairs are invalid input, not extra capacity. Sort by ordinal pair, maximum fifty positions. Count invalid/null fields once as `invalid`, root URLs once as `homepages`, redundant valid observations once as `duplicates`, and groups excluded by history once as `known`. Retain first valid original source and all observed canonical aliases/provenance. Read discovery and email notification evidence for every alias without short-circuiting required evidence; touch only existing observed discoveries. Reject the operation on unverifiable history. Assign IDs after history filtering. `observedAliases` includes valid groups removed as known so replay can still use their alias evidence. No persisted alias rows.

- [ ] **Write failing tests:** `Brave retains only first five provider positions`; positions 1 invalid/2–5 valid/6 valid must never admit position 6. Assert rawCount 6, positions length 5, original ordinals, one fetch and existing usage record. Add credential/non-HTTP/2049-byte URL rejection, root-with-query/fragment rejection, allowed non-root paths, canonical trailing-slash duplicates, fragment grouping, stable input reordering by ordinals, and fifty-position limit tests.
- [ ] **Write RF2 failing test:** source aliases `https://example.test/news#a` and `#b`, with notification only on `#b`; assert zero candidates, known count 1, retained alias map, and no fabricated discovery writes. A known discovery is touched without changing `firstSeenAt`; a lookup failure rejects. Example assertions:

```ts
assert.equal(pool.candidates.length, 0);
assert.equal(pool.counts.known, 1);
assert.equal(recordDiscoveryCalls, 0);
assert.equal(existing.firstSeenAt, originalFirstSeenAt);
```

- [ ] **RED:** Run `./node_modules/.bin/tsx --test test/webSearch.test.ts test/batchCandidates.test.ts`; expect failure on missing bounded-page/preparation behavior.
- [ ] **Implement:** Add the page projection and preparation helper with the exact interfaces above; reuse `normalizeDiscoveryUrl`, existing history, and notification interfaces. No semantic matching, new URL-key rules, or provider lookup.
- [ ] **GREEN/regression:** Rerun that command, then `./node_modules/.bin/tsx --test test/discoveryHistory.test.ts test/notificationHistory.test.ts test/usageGuard.test.ts`; expect all pass and original durable keys unchanged.
- [ ] **Checkpoint:** Stage only this task's five files after inspection; commit `feat: prepare bounded Brave batch candidates`.

### Task 2: Deterministic complete-prompt bounding

**Files:** Create `src/services/batchPrompt.ts`, `test/batchPrompt.test.ts`; modify `src/types/index.ts`.

**Interfaces:** Consume `BatchCandidate` from Task 1. Add:

```ts
type BatchTruncationStage = 'initial' | 'snippet384' | 'snippet192' | 'snippet96' | 'snippet0' | 'title128' | 'tail';
interface PreparedBatch {
  prompt: string;
  candidates: readonly BatchCandidate[]; // only submitted candidates, original source records
  promptBytes: number;
  sizeExcluded: number;
  truncationStage: BatchTruncationStage;
}
```

In `batchPrompt.ts`, export `BATCH_ANALYSIS_INSTRUCTIONS: string`, `utf8Length(value: string): number`, `truncateUtf8(value: string, maximumBytes: number): string`, and `prepareBatchPrompt(candidates: readonly BatchCandidate[], instructions?: string): PreparedBatch`. The optional instruction argument is a pure-test seam; production always uses the fixed exported instruction. Reject empty input or an instruction-only overflow without provider activity. Use `TextEncoder`, not Node Buffer/filesystem.

Fixed JSON property order: envelope `schemaVersion,candidates`; candidate `candidateId,title,snippet,url,publishedAt,queryOrdinals`. Serialize once per trial using the same template. Normalize text whitespace only for prompt fields. Validate absolute dates as specified; invalid/relative/timezone-ambiguous values are null. UTF-8 title/snippet initial limits 256/768; prompt <=32768. Reduce all snippets 384→192→96→0, then titles 128, then tail removal. Prior reductions remain active. Never alter original source fields or renumber IDs. This is a byte safety bound, not a token-count API or provider generation cap.

- [ ] **Write failing tests:** `normal fifty-result pool is submitted together`, fixed-key serialization and sorted unique query ordinals, date-only UTC/invalid/null, byte caps 256/768, every truncation stage, fixed-instruction overflow, original-source preservation, and retained IDs after tail removal. Use fifty short varied URLs/titles/snippets for the normal fixture; assert all fifty IDs are retained.
- [ ] **Write RF1 failing test:** escaped quotes/backslashes and multi-byte emoji near the 32768-byte boundary. Use the pure instruction seam to reach each stage deterministically. Assertions:

```ts
assert.equal(batch.promptBytes, new TextEncoder().encode(batch.prompt).length);
assert.ok(batch.promptBytes <= 32768);
assert.equal(truncateUtf8('😀a', 4), '😀');
assert.equal(truncateUtf8('😀a', 3), '');
assert.deepEqual(batch.candidates.map(c => c.candidateId), input.slice(0, batch.candidates.length).map(c => c.candidateId));
```

Also assert empty snippets remain empty at title/tail stages and original source title/URL are byte-identical after preparation.
- [ ] **RED:** Run `./node_modules/.bin/tsx --test test/batchPrompt.test.ts`; expect missing preparation/bounds failures.
- [ ] **Implement:** Pure deterministic preparation with exact spec input schema, untrusted-data instructions, topic guidance, score >=7 guidance, and first-story/secondary output requirements. No field/URL fabrication or second request.
- [ ] **GREEN/regression:** Run `./node_modules/.bin/tsx --test test/batchPrompt.test.ts test/batchCandidates.test.ts`; expect all pass including each stage and fifty-result fixture.
- [ ] **Checkpoint:** Stage only these three files; commit `feat: bound the complete Gemini batch prompt`.

### Task 3: Strict batch analysis contract and source mapping

**Files:** Modify `src/services/analysisAgent.ts`, `src/types/index.ts`; create `test/batchAnalysis.test.ts`; preserve `test/analysisAgent.test.ts` legacy coverage.

**Interfaces:** Consume `PreparedBatch`/`BatchCandidate`. Add to types:

```ts
interface BatchSelection { candidate: BatchCandidate; analysis: AgentAnalysis }
interface BatchAnalysisResult { returnedCount: number; selections: BatchSelection[] }
```

Export `parseBatchAnalysis(outputText: string, batch: PreparedBatch): BatchAnalysisResult` and `analyzeBatch(batch: PreparedBatch, dependencies: { generate: (input: string) => Promise<Pick<LlmResult, 'outputText'>> }): Promise<BatchAnalysisResult>`. Export `class BatchAnalysisError extends Error` for contract failures, with only a fixed content-free message; propagate generator failures unchanged so orchestration can distinguish invalid output from provider failure without inspecting arbitrary text. `generate` is required: no default per-story/provider fallback. `analyzeBatch` invokes it once and then parses. Keep `analyzeSearchResult` unchanged for unrelated callers.

Exact JSON envelope/story keys, existing category enum, integer scores 1–10, zero–four stories, unique submitted IDs, non-increasing score order/equal-score stability are mandatory. Check <=24576 UTF-8 output bytes before JSON parsing. Reject entire output on extra keys, invalid types, empty/whitespace-only required strings, unknown/duplicate IDs, bad rank, or any byte/item bound. Do not trim/truncate/repair a bad result into validity. No `sourceUrl`/`sourceTitle` output keys. After whole-result validation, filter scores <7 and map original source fields into existing `AgentAnalysis` objects.

Bounds: name 240; lead summary/why/education 1600/800/800; secondary 480/320/320; technology arrays <=8 ×80 bytes; projects lead <=3 ×240, secondary <=2 ×160. Empty arrays permitted. All strings measured as returned; arrays of nonempty strings only. No additional schema library.

- [ ] **Write failing tests:** table-driven exact schema errors (envelope/story extras, missing keys, wrong types, fractional/out-of-range scores, invalid category, whitespace strings, five entries), known/unknown/size-excluded/duplicate IDs, ascending-score rejection, equal-score stability, all output/field limits at boundary and boundary+1, zero/fewer-than-four, score6 exclusion, detailed lead and concise secondary enforcement. Include an example model URL/title key and injection-looking source data; assert no source replacement.
- [ ] **Write RF3 parser test:** valid outer provider outputText is invalid analysis JSON; a fake generator increments once; `analyzeBatch` rejects with a bounded content-free error and never calls another generator. Assert:

```ts
assert.equal(generateCalls, 1);
assert.equal(parsed.selections[0].analysis.sourceUrl, batch.candidates[0].source.url);
assert.equal(parsed.selections[0].analysis.sourceTitle, batch.candidates[0].source.title);
assert.equal(parsed.returnedCount, 4); // fixture contains one valid score6 entry
assert.equal(parsed.selections.length, 3);
```

Use separate success/error fixtures for these assertions; never access a rejected parse result.
- [ ] **RED:** Run `./node_modules/.bin/tsx --test test/batchAnalysis.test.ts`; expect missing batch entry points/contract failures.
- [ ] **Implement:** Exact runtime validator and source mapping; no persistence or network default inside parsing. Validate all entries before producing eligible selections.
- [ ] **GREEN/regression:** Run `./node_modules/.bin/tsx --test test/batchAnalysis.test.ts test/analysisAgent.test.ts test/batchPrompt.test.ts`; expect all pass.
- [ ] **Checkpoint:** Stage only these three files; commit `feat: validate ranked Gemini batch analyses`.

### Task 4: Single-dispatch Gemini execution with unchanged accounting

**Files:** Modify `src/tools/llm/gemini.ts`, `test/geminiUsageGuard.test.ts`, `test/geminiAmbiguityAccounting.test.ts`; no migration/store/guard behavior changes.

**Interfaces:** Export:

```ts
interface GeminiBatchCycleContext extends GeminiCycleContext {
  batchStarted: boolean;
  reservationAttempts: number;
  reservations: number;
  providerDispatches: number;
}
function createGeminiBatchCycleContext(): GeminiBatchCycleContext;
function generateBatchWithGemini(
  input: string,
  dependencies: Omit<GeminiDependencies, 'cycleContext'> & { cycleContext: GeminiBatchCycleContext }
): Promise<LlmResult>;
```

Initialize batch fields false/0. Consume the invocation latch synchronously at entry before any await; a second call sharing the context fails without reservation/fetch, including concurrent calls and calls following failure. Use one primary model, one attempt; retain existing API shape, usage extraction, final guarded reservation, accounting-window check, timer/body/parse deadline, exact settlement, confirmed-zero classification, and ambiguity preservation. A small private execution-policy helper may be shared with legacy `generateWithGemini`; do not duplicate or weaken the accounting state machine. Legacy API behavior/tests remain unchanged.

Increment `reservationAttempts` immediately before reserve, `reservations` only after reserve succeeds, and `providerDispatches` immediately before the single fetch handoff. A synchronous fetch throw still counts as one dispatch. Existing legacy `providerAttempts` is reservation-based; do not relabel it as actual dispatch. Batch summaries use the new explicit counters. Apply a new context only to a new cycle, never to retry inside the same cycle.

- [ ] **Write failing adapter tests:** parameterize success/503 verified unavailable/model-specific429/ambiguous429/transport error/invalid provider JSON/timeout; assert exactly one fetch, primary model only, zero fallbacks. Admission denied and reserve failure assert zero fetch. Valid usage settles once; confirmed-zero errors remain appropriately classified. Missing usage and settlement failure fail closed.
- [ ] **Write RF4 failing test:** existing `beforeDispatch`/clock seams force an accounting-window boundary after reservation and before fetch; assert preserved abandoned/unresolved evidence, `reservations===1`, `providerDispatches===0`, no second reserve even on another invocation. Also `Promise.allSettled` two calls sharing context must produce at most one reservation attempt and fetch.
- [ ] **Write RF3 accounting test:** use `analyzeBatch` with `generateBatchWithGemini` returning valid usage but invalid analysis JSON. Assert one exact record/settlement, one fetch, zero output selections; no mark-ambiguous solely for analysis content failure.
- [ ] **Write deadline regressions:** retain the 90000 default, simulate stalled body and elapsed monotonic parse boundary, assert timeout ambiguity and later same-context rejection. Exercise existing D1/local-fixture next-day admission with unknown tokens unchanged; fresh day is allowed only if all other guards allow it. Do not rely solely on the in-memory test tracker, which has simplified unresolved-state admission.

Assertion excerpts for the separate success, pre-dispatch-stop, and timeout fixtures respectively:

```ts
assert.equal(successContext.providerDispatches, 1);
assert.equal(successTracker.settlementCalls, 1);
assert.equal(stoppedContext.reservations, 1);
assert.equal(stoppedContext.providerDispatches, 0);
assert.equal(timeoutRecord.accountingStatus, 'transport_ambiguous');
assert.equal(timeoutRecord.ambiguityReason, 'timeout');
assert.equal(GEMINI_TIMEOUT_MS, 90000);
```

- [ ] **RED:** Run `./node_modules/.bin/tsx --test test/geminiUsageGuard.test.ts test/geminiAmbiguityAccounting.test.ts`; expect missing batch policy/counters to fail.
- [ ] **Implement:** Add explicit batch entry/policy and counters around the existing attempt machinery, retaining all legacy regressions. No sleep/retry/fallback branch reachable under batch policy. No token-count request or schema change.
- [ ] **GREEN/regression:** Rerun that command plus `./node_modules/.bin/tsx --test test/batchAnalysis.test.ts test/d1Adapters.test.ts`; expect all pass. Inspect fetch paths, not only wrapper call counts.
- [ ] **Checkpoint:** Stage only this task's three files; commit `feat: enforce one accounted Gemini batch dispatch`.

### Task 5: Persist validated selections without per-story generation

**Files:** Modify `src/services/discoveryProcessor.ts`, `test/discoveryProcessor.test.ts`, `test/d1Adapters.test.ts`.

**Interfaces:** Consume `BatchSelection`. Export `recordBatchSelection(selection: BatchSelection, dependencies: { history: DiscoveryHistory; seenAt: Date }): Promise<DiscoveryProcessingResult>`.

Validate existing `AgentAnalysis`, score >=7, candidate/source equality, normalized identity, and batch-news URL eligibility before recording. Reuse history lookup/touch for an already-existing identity and return `duplicate`; otherwise record/retrieve through the existing adapter. A concurrent insert resulting in an existing returned row must never overwrite its original analysis or `firstSeenAt`. The orchestrator will classify a pre-existing row as replay-eligible only under the existing replay window, never falsely fresh. No generator argument/default exists in this helper.

- [ ] **Write failing tests:** four selected analyses produce at most four discovery records and zero analyzer calls; richer existing fields round-trip without schema changes; low score/source mismatch/root reject before write; record failure rejects and provides no sendable result; existing discovery retains identity/timestamps/content. Stored JSON contains only existing analysis fields/provenance, no prompt/candidate pool or batch envelope.
- [ ] **Write RF5 persistence test:** second of three recordings fails; caller receives first/third successful results only and no fabricated second result. Assert `recordedUrls` excludes the failed URL and a later task's delivery set cannot include it. D1 insert-race fixture returns an earlier row without overwriting it.

```ts
assert.equal(analyzeCalls, 0);
assert.ok(!recordedUrls.includes(failedUrl));
assert.equal(raced.discovery.firstSeenAt, originalFirstSeenAt);
assert.deepEqual(raced.discovery.analysis, originalAnalysis);
```

- [ ] **RED:** Run `./node_modules/.bin/tsx --test test/discoveryProcessor.test.ts test/d1Adapters.test.ts`; expect missing helper/behavior failures.
- [ ] **Implement:** Reuse existing verification/recording primitives, keeping `processSearchResult` for legacy callers. Do not modify D1 table schema or copy routines, or force all-or-nothing batch transactions.
- [ ] **GREEN/regression:** Rerun that command plus `./node_modules/.bin/tsx --test test/discoveryHistory.test.ts test/batchAnalysis.test.ts`; expect all pass.
- [ ] **Checkpoint:** Stage only these three files; commit `feat: persist validated batch selections without reanalysis`.

### Task 6: Threshold-only fresh-first digest with replay and lead layout

**Files:** Modify `src/services/notificationOrchestrator.ts`, `src/services/discoveryEmailFormatter.ts`, `src/types/index.ts`, `test/notificationOrchestrator.test.ts`, `test/discoveryEmailFormatter.test.ts`, `test/notificationReplay.test.ts`.

**Interfaces:** Add `BatchDeliveryCandidate extends DeliveryCandidate { aliases: readonly string[] }` to types. Add `notifyBatchDeliveryDigest(candidates: readonly BatchDeliveryCandidate[], dependencies: NotificationOrchestratorDependencies): Promise<DigestDeliveryResult>`; reuse result shape with `mode: 'normal'` only for a sent batch digest. Add `formatBatchDigestEmail(stories: StoredDiscovery[]): DiscoveryEmailContent` in the formatter, reusing escaped lead/secondary blocks. Do not change unrelated legacy notification contracts.

The batch notifier enforces score >=7 and `isBatchNewsUrl` itself; a permissive injected legacy `isEligible` must not admit score6. Preserve incoming fresh order, then replay score descending/firstSeenAt descending/normalized URL lexicographic ascending (no locale-dependent comparison). Union aliases before collapsing normalized/fragment groups; any observed notified alias excludes the group. Prefer fresh over replay for the same group. Check notification evidence initially and again before final selection/send; a failed read fails closed. Fill only from the already-bounded candidate list, maximum four, no new history scan or model call.

Dependencies must include notification history and injected sender in tests. Production wiring supplies Resend. Existing send-then-record and try-all recording semantics remain; no resend on failure. Reuse same analysis fields, exact subject/title `AI Agent Radar — Daily Digest`, label `MOST RELEVANT`, detailed first position, concise others. No model URL source, raw HTML interpretation, or P4 mode in this new entry point.

- [ ] **Write failing delivery tests:** fresh scores8/7 remain before replay10; replay tie sorting is deterministic; total <=4; score6 trusted hosts and root URLs excluded; permissive `isEligible` cannot bypass hard gates; previously notified URLs never sent; empty result sends zero; replay-only sends once. Assert no sourceTrust/priority bonus changes selection in the batch path.
- [ ] **Write RF2/RF5 tests:** notification appears on the lead's observed alias between initial/final reads; lead excluded and next candidate promoted, replay fills gap, exactly one sender call. Any final history read error yields zero sends. A partial-persistence fixture omits failed fresh rows and does not rediscover them through delivery. No extra model dependency exists here.
- [ ] **Write failing layout tests:** label and subject exact, first summary/why/education/projects rendered fully, positions2–4 concise, one/two/four stories and replay-only supported, malicious model/source strings escaped, href uses stored source URL. Assertions:

```ts
assert.equal(email.subject, 'AI Agent Radar — Daily Digest');
assert.ok(email.text.includes('MOST RELEVANT'));
assert.equal(sendCalls, 1);
assert.deepEqual(sentUrls, expectedFreshThenReplayUrls);
assert.ok(!email.html.includes('<script>'));
```

- [ ] **RED:** Run `./node_modules/.bin/tsx --test test/notificationOrchestrator.test.ts test/discoveryEmailFormatter.test.ts test/notificationReplay.test.ts`; expect new entry/layout failures.
- [ ] **Implement:** Batch-only selection and formatter entry point, reuse existing recording/rendering code. Keep replay constants/window and notification DB keys unchanged. Do not remove trust registry or unrelated legacy helper tests.
- [ ] **GREEN/regression:** Rerun the command plus `./node_modules/.bin/tsx --test test/notificationHistory.test.ts test/notificationEligibility.test.ts`; expect all pass, no second send on Resend or post-send recording failure.
- [ ] **Checkpoint:** Stage only the six files above; commit `feat: deliver quality-first batch digests with replay`.

### Task 7: Wire the natural scheduled Worker to the batch pipeline

**Files:** Modify `src/services/monitor.ts`, `src/worker.ts`, `src/types/index.ts`, `test/workerConfiguration.test.ts`; create `test/batchMonitoring.test.ts`. Existing `test/monitor.test.ts` and `test/xIntegration.test.ts` remain regression coverage for legacy callers.

**Interfaces:** Add in `monitor.ts`:

```ts
interface BatchMonitoringDependencies {
  searchPage: (query: string, options?: MonitoringSearchOptions) => Promise<BraveSearchPage>;
  history: DiscoveryHistory;
  notification: NotificationOrchestratorDependencies & { history: NotificationHistory };
  geminiPreflight: (now: Date) => Promise<GeminiAvailability>;
  analyze: (batch: PreparedBatch) => Promise<BatchAnalysisResult>;
  geminiCycleContext: GeminiBatchCycleContext;
  now?: () => Date;
}
function runBatchMonitoringCycle(dependencies: BatchMonitoringDependencies): Promise<MonitoringCycleResult>;
```

Keep legacy `runMonitoringCycle` public contract. The new scheduled path has no `process`, `collectX`, retry, or per-story generator dependency. It calls Tasks 1/2/3/5/6 explicitly. Add optional `batch?: BatchCycleMetrics` to `MonitoringCycleResult`; Task 8 completes metrics/serialization, with the full type defined below before implementation so interfaces do not diverge.

In `worker.ts`, change `createWorkerMonitoringDependencies(env, overrides?): BatchMonitoringDependencies`; override shape becomes `{ searchPage?: typeof searchWebPage }`, updating its test callers. Wire one shared `createGeminiBatchCycleContext` and `analyzeBatch(... generateBatchWithGemini ...)`. `runScheduledMonitoring` uses `runBatchMonitoringCycle` by default; preserve its existing injected `runCycle` signature/result shape and health-only handlers. `createWorkerPersistence` still uses D1. No local modules enter the Worker graph.

**Algorithm decisions:** One cycle start; existing bounded replay lookup; sequential ten configured Brave descriptors before Gemini preflight, partial failures retained, quota error stops; build observations and candidate pool; prepare only nonempty pool; preflight then at most one analyze invocation; persist validated selections individually; no failed row enters delivery. Existing/racing rows join replay only if their immutable firstSeenAt falls within the approved window, subject to the same bounded set and dedupe. Merge observed aliases into fresh/replay candidates. Notify once. History uncertainty aborts unverifiable delivery. Classify errors without a second Gemini call. All-search failure can still deliver replay and remains a failure metric.

No X calls/tables are needed in the new active path. Leave dormant X/local legacy execution code intact, without making it an alternate automatic path. This release targets X disabled; future enabled-X composition remains separate approval, not a fifth lane.

- [ ] **Write failing flow tests:** fifty observations across ten queries reach one batch; ordered event log proves every allowed search precedes admission; blocked Gemini still searches and can replay; quota cutoff/non-quota partial/all-failure paths; empty/known pool gives zero analyze calls. A high-ranked result from query10 must be selectable, proving no old four-slot lane remains.
- [ ] **Write RF3 integrated test:** successful provider usage with invalid analysis yields zero fresh persistence, exact accounting, one dispatch and optional replay-only digest. No replacement analysis.
- [ ] **Write RF5 integrated test:** second persist fails and first becomes notified before final check; assert excluded URLs, promoted eligible content, replay fill, at most four stories, one model dispatch and one sender invocation. Include existing-row race outside replay window excluded from fresh delivery.
- [ ] **Write Worker regressions:** scheduled default path calls batch entry with one context; HTTP GET/POST/paths still return health only and invoke no provider. Disabled X with D1 fixture missing `0004` works; X spies remain zero. All legacy `processSearchResult`, preferred-lane, P4 and fallback spies stay unreachable from scheduled execution. Preserve the existing replay 72h/cutoff/100 assertions.

```ts
assert.equal(searchCalls, 10);
assert.ok(events.indexOf('admission') > events.lastIndexOf('search'));
assert.equal(analyzeCalls, 1);
assert.equal(geminiFetchCalls, 1);
assert.equal(legacyProcessCalls, 0);
assert.equal(xFetchCalls, 0);
assert.equal(await healthResponse.text(), 'AI Agent Radar worker ready');
```

Use the normal fifty-result fixture for search/analysis assertions and a separate fresh HTTP-only fixture for zero provider calls. Set batch status `invalid_output` only for `BatchAnalysisError`; identify timeout from the cycle context's timeout flag, not untrusted error text.
- [ ] **RED:** Run `./node_modules/.bin/tsx --test test/batchMonitoring.test.ts test/workerConfiguration.test.ts`; expect missing batch wiring/ordering failures.
- [ ] **Implement:** Compose existing stores/providers through explicit batch functions. Remove old per-story imports/dependencies from Worker composition. Bypass `MAX_NEW_ANALYSES_PER_CYCLE`, reserved lanes and post-score bonuses in the scheduled flow; keep their unrelated local/X callers intact. Populate baseline batch metrics for Task 8. No migration/config change.
- [ ] **GREEN/regression:** Rerun that command, then `./node_modules/.bin/tsx --test test/monitor.test.ts test/xIntegration.test.ts test/notificationReplay.test.ts test/d1Adapters.test.ts`; run `npm run build`. Expect all pass with no legacy caller type breaks.
- [ ] **Checkpoint:** Stage only the five task files; commit `feat: run scheduled radar through one Gemini batch`.

### Task 8: Bounded diagnostics and complete release validation

**Files:** Modify `src/types/index.ts`, `src/services/monitor.ts`, `src/worker.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`; update only task evidence/checkmarks in this plan during future execution. No new observability table or operational configuration.

**Interfaces:** Define `BatchCycleMetrics` in `src/types/index.ts` and use it consistently from Task 7:

```ts
interface BatchCycleMetrics {
  searchAttempts: number; searchSuccesses: number; searchFailures: number;
  rawObservations: number; acceptedObservations: number;
  invalid: number; homepages: number; duplicates: number; known: number;
  sizeExcluded: number; submittedCandidates: number; promptBytes: number;
  truncationStage: BatchTruncationStage | null;
  status: 'empty' | 'blocked' | 'preparation_failed' | 'provider_failed' | 'timeout' | 'invalid_output' | 'validated';
  reservationAttempts: number; reservations: number; providerDispatches: number;
  returnedStories: number; acceptedStories: number;
  selected: Array<{
    candidateId: string; hostname: string; score: number;
    provenance: Array<{ queryOrdinal: number; resultOrdinal: number }>;
  }>;
  freshDelivered: number; replayDelivered: number; emailCount: number;
}
```

Counters start at zero. Search attempts count application query attempts including guard-denied attempts; actual Brave dispatches remain governed by adapter/quota evidence, never claimed from that counter alone. Success is a safely accounted/parsed search response. Accepted observations are first-five positions including null invalid fields; `invalid` counts malformed/unsafe sources, separate from homepages, duplicates, and known groups. `returnedStories` counts entries only after structurally validating the envelope/list, capped at four; invalid uncountable output leaves zero with `invalid_output`. `acceptedStories` is all fully validated score>=7 selections, not successful writes or sent stories. `selected` describes those accepted selections, capped at four; never manufacture selected evidence for invalid output.

Keep the legacy summary fields compatible but explicit: scheduled `analysesAttempted` means batch-analysis invocation count (0/1), `newDiscoveries` counts durable new selected stories, `stoppedByAnalysisCap=false`, batch fallback counts zero, and batch `geminiProviderAttempts`/model request counters reflect actual dispatches. Do not copy legacy reservation-based `providerAttempts` into actual-dispatch metrics. Durable usage/request counts remain unchanged. `notificationsSent`/`emailCount` count externally accepted emails, even if later record writes fail; failed attempts are failures, not accepted deliveries. Track acceptance via an injected sender wrapper before notification-record work so post-send errors cannot silently report zero sends. Per-story delivered counts count included stories in the accepted email, distinct from successfully recorded notifications.

Add `batch?: BatchCycleMetrics` to `ScheduledCycleSummary`. Preserve `createScheduledCycleSummary(result, env): ScheduledCycleSummary`, explicitly copying an allowlist instead of logging raw in-memory maps. Select at most four entries/50 provenance pairs in total, hostname <=253 characters, IDs c001–c050, ordinal/score validation and secret redaction on every logged string. No sourceTitle/URL, prompt, snippet, response, secret or address in the summary. Retain existing accounting/timeout diagnostics. Surface post-send and partial failures without retrying.

- [x] **Write failing metrics tests:** reservation-without-dispatch reports 1/0, four selected stories report one dispatch, invalid JSON distinguishes exact usage from invalid content, known/size exclusions and truncation stage match preparation. Malicious injected summary strings/arrays are bounded/redacted; include fake secret in hostname/error and a notification address in source text. Assert:

```ts
assert.equal(summary.batch.providerDispatches, 1);
assert.equal(summary.batch.acceptedStories, 4);
assert.ok(summary.batch.selected.length <= 4);
assert.ok(!JSON.stringify(summary).includes(fakeSecret));
assert.ok(!JSON.stringify(summary).includes(fullSourceUrl));
```

Also prove accepted email followed by record failure reports emailCount1/failure and never causes another send. Prove failed send reports emailCount0/failure.
- [x] **RED:** Run `./node_modules/.bin/tsx --test test/batchMonitoring.test.ts test/workerConfiguration.test.ts`; expect metric distinctions/redaction failures.
- [x] **Implement:** Complete typed counter wiring and explicit bounded serialization, using existing redaction and notification error evidence. Record actual validation evidence, limitations and remaining release gates in this plan; no historical Architect-plan reconciliation.
- [x] **GREEN/regression:** Rerun targeted tests, then execute the Final Verification block. All checks must pass or be explicitly reported blocked; no fabricated completion. Inspect that scheduled imports cannot reach local JSON persistence/OpenAI, P4, or per-story generation.
- [x] **Checkpoint:** Stage only these task files and this plan's execution evidence after diff inspection; commit `feat: report bounded batch radar diagnostics`. Preserve approved spec bytes; its independent documentation checkpoint requires separate authorization if still untracked.

Task 8 execution evidence (2026-10-14): focused RED reported 31 tests, 27 passing and four expected failures (missing batch summary, unsafe injected summary fields, and post-send recording-failure delivery counts). Focused GREEN passed 31/31. Final complete offline suite passed 569/569, with zero failures/cancellations/skips/todo. The locked offline `npm ci --offline --no-audit --no-fund`, build, Worker type generation/typecheck, dependency inventory, and both diff checks passed. Generated `worker-configuration.d.ts` and the lockfile remained unchanged. npm reported its existing `prebuild-install` deprecation and unapproved lifecycle-script notices; no new scripts were approved or dependency downloaded.

The available macOS sandbox boundary was verified with disposable non-provider probes: inbound and outbound IP operations both failed with EPERM; local Unix IPC remained permitted for the test runner. The final install/build/test/Worker checks and local Wrangler dry run ran inside that boundary. Dry run exited successfully without upload at `/tmp/ai-radar-batch-gemini-dry-run` (132.21 KiB, gzip 29.25 KiB). Bundle inspection found D1 stores, the batch-only scheduled call, and the single-dispatch batch adapter; no local JSON persistence, Node filesystem/path imports, dotenv, OpenAI provider module, X tables/readers, legacy per-story entry, P4 delivery predicate, or legacy notification entry was emitted. Inert legacy trusted-host/X registry constants remain from shared imports; they do not enable execution or require migration 0004.

The recorded narrow scope ruling permits the optional notifier acceptance hook used to capture the exact externally accepted candidate list before record writes. Tests prove one accepted email still reports two fresh/one replay delivered stories when all three notification writes fail, and a failed sender reports zero accepted emails/stories with no recording or retry. Summary serialization explicitly copies all allowed metrics, at most four valid candidate IDs/scores, and at most fifty valid provenance pairs; hostnames are at most 253 characters and sanitized, errors remain at most 160 characters, and arbitrary enum/map properties cannot leak. Exact usage settlement remains distinguishable from invalid output and reservations remain distinguishable from actual dispatches.

Remaining gates: independent whole-branch/Analyst review, Architect disposition, and separate human publication/release approval. Byte/token and transport caveats, cycle-local alias limits, and the accepted send-before-history duplicate-risk window remain as documented. No worktree, push, PR, merge, deployment, production migration, manual monitoring, provider request, quota/configuration/secret change, X activation, or historical-row mutation occurred. The binding specification remains untracked and byte-identical; the protected Architect backup remains recoverable and uncommitted.

## Final Verification (future Builder execution only)

Inspect `package.json`/lockfile first. Actual scripts are `build: tsc`, `test: tsx --test test/**/*.test.ts`, and `worker:typecheck: npm run worker:types && tsc -p tsconfig.worker.json` (`worker:types` runs local Wrangler type generation). No Vitest. No live `gemini:test`, `analysis:test`, `email:test`, `monitor:test`, `e2e:test`, or monitoring scripts.

The requested canonical commands are `npm ci`, `npm run build`, `npm test`, `npm run worker:typecheck`, `git diff --check`, `npm ls --depth=0`, and `npx wrangler deploy --dry-run`. Use the restricted local/offline forms below; do not fetch missing tools or dependencies implicitly:

```bash
npm ci --offline --no-audit --no-fund
npm run build
npm test
WRANGLER_SEND_METRICS=false npm run worker:typecheck
git diff --check
npm ls --depth=0
WRANGLER_SEND_METRICS=false npx --no-install wrangler deploy --dry-run --outdir /tmp/ai-radar-batch-gemini-dry-run
git diff --cached --check
GIT_OPTIONAL_LOCKS=0 git status --short --untracked-files=all
```

`npm ci` is future locked-environment setup, not a new dependency authorization; inspect lifecycle scripts and run with provider/network isolation. If caches/native build prerequisites are missing, report that blocker instead of downloading or widening permissions. Use an available unused temporary output directory; do not overwrite another task's artifacts. Dry-run must exit after local bundling and must not upload or query production. Run validation with network denied where the execution environment supports it; do not supply production secret values. No `--remote`, migration commands, or actual deployment.

Expected: all existing and new offline tests pass, TypeScript/Worker checks pass, no dependency drift, no whitespace errors, dry-run bundle builds locally. Inspect emitted Worker bundle/import graph for exclusion of local JSON persistence, Node filesystem, dotenv, and OpenAI provider code; inspect scheduled composition for no X-table requirement or hidden legacy analysis call. Treat local package presence as distinct from inclusion in the Worker bundle. Preserve generated files without committing unrelated artifacts; investigate unexpected tracked changes rather than resetting indiscriminately.

## Spec coverage and plan self-review

| Spec coverage | Owning tasks |
| --- | --- |
| Brave collection, source identity, URL/history/alias rules (§7–9) | 1, 7 |
| Input schema and complete prompt bounds (§10–11) | 2 |
| Output schema, validation, lead content (§14–18) | 3, 6 |
| Provider policy/accounting/timeout (§12–13) | 4, 7 |
| Persistence and schema compatibility (§20,25–26) | 5 |
| Replay, email, relevance, failures (§16–22) | 6, 7 |
| Observability/security (§23–24) | 1–4, 6, 8 |
| Obsolete scheduled behavior, Worker invariants (§27–31) | 7, 8 |
| All offline acceptance cases (§29) | 1–8 |

Self-review completed during authoring: spec coverage mapped; steps specify files, interfaces, tests, commands and checkpoints; shared type/function names agree; exactly five Review Focus items each have concrete owning tests; plan contains contracts/assertion excerpts rather than large function bodies. No material spec contradiction or required schema/provider-policy amendment was discovered. The test-stack wording was clarified from actual package scripts. Legacy entry points are retained only outside scheduled batch execution; they cannot be a failure escape route. Prompt/output acceptance bounds are not represented as token/transport guarantees.

No implementation, test execution, dependency installation, branch operation, commit, push, provider call, production mutation, or deployment occurred during plan authoring.

## Human review and execution handoff

Recommend **superpowers:subagent-driven-development**, with sequential tasks and a fresh review gate after each task, then whole-change independent review. The accounting adapter, source mapping, and final eligibility boundaries merit separate reviewers; shared files make concurrent implementation inappropriate.

Human approval of this written plan and execution method remains required before Builder work. The execution checkout/branch must also satisfy repository governance; do not infer authorization to implement on protected main from this documentation task. After implementation: Builder evidence → independent Analyst review → Architect disposition → human release decision. No checkpoint authorizes publication/deployment, migration, manual monitoring, or latch recovery. The approved baseline is schema-compatible rollback, but rollback restores old runtime policies and requires its own human authorization.
