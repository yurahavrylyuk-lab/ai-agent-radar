# RSS Discovery Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for native Builder execution after plan approval. Follow checkbox steps task by task. No subagents or worktrees; ONE independent final Analyst review after implementation and verification, with no per-task review gates.

**Goal:** Add approved RSS/Atom feeds to the existing Brave candidate pool without creating another Gemini dispatch or delivery lane.

**Architecture:** A bounded RSS collector returns existing SearchResult records with application-owned provenance. The shared candidate preparation normalizes/deduplicates both sources against history, interleaves new candidates under existing batch limits, and feeds the unchanged analysis/delivery path.

**Tech stack:** TypeScript, Node 24 offline tests, Cloudflare Worker fetch/ReadableStream/TextDecoder, pinned `sax` parser API, existing D1 adapters unchanged.

**Spec:** [Approved RSS discovery design](../specs/2026-10-16-rss-discovery-design.md). Read both documents; this plan implements that spec without changing its decisions.

## Global constraints

- Four approved feeds in the order below; max five feeds, five observed positions/feed, one GET/feed, 5,000 ms/feed through body reading, 262,144 decoded body bytes/feed. No retries, redirects, pagination, article retrieval or runtime feed expansion.
- Initial registry: at most 20 RSS/70 combined observations. Hard ceilings: 25 RSS/75 combined, 50 submitted candidates (c001–c050), complete prompt <= 32,768 UTF-8 bytes.
- One Gemini provider dispatch maximum; no retry/model fallback, score >= 7, at most four stories and one email including replay. Keep quota/accounting and preflight ordering unchanged.
- Shared normalization/history checks remain authoritative. No D1 schema, stored provenance, X/0004, Threads, legacy per-story pipeline, Cron, secrets or Cloudflare configuration changes.
- No live feed/provider/monitoring test, remote migration, deployment or production mutation during implementation verification. A dry-run is packaging only; inspect its command first.
- Preserve existing user changes in backlog.md, plan.md, PROJECT_STATE.md and existing specs. Record the execution baseline before edits; do not reset or absorb unrelated changes. Git commit/publication authority follows the separately approved Builder handoff, not this plan. No commit/push is required between tasks.
- Only this plan is created now. Execution begins after human plan approval; release remains a separate human decision.

## File map

| Files | Responsibility |
| --- | --- |
| Add `src/config/rssSources.ts` | Approved registry, validation, fixed acquisition/parser limits |
| Add `src/services/rssDiscovery.ts` | RSS/Atom parsing, normalization, bounded fetch, collection outcomes |
| Modify `src/types/index.ts` | DiscoveryProvenance union, BatchObservation, candidate and summary contracts |
| Modify `src/services/batchCandidates.ts` | Shared grouping/history, interleaving, pool cutoff |
| Modify `src/services/batchPrompt.ts` | Extract queryOrdinals from Brave provenance only |
| Modify `src/services/monitor.ts` | RSS collection in batch path and metric aggregation |
| Modify `src/worker.ts` | Collector composition, overrides, sanitized telemetry |
| Modify `package.json`, `package-lock.json` | Pinned parser and development typings if required |
| Add `test/rssDiscovery.test.ts`, `test/fixtures/rss/` | Offline collector/parser fixtures and tests |
| Modify `test/batchCandidates.test.ts`, `test/batchPrompt.test.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts` | Shared pool, prompt, integration and telemetry regressions |
| Modify only relevant section of `docs/self-improvement/PROJECT_STATE.md` at handoff | Implemented/verified behavior, clearly distinguished from deployed state |

No change expected to analysisAgent, persistence, formatter, Gemini transport or migrations. Existing test fixtures elsewhere may only receive mechanical provenance-shape updates if TypeScript requires them; list any such paths in the handoff, without changing assertions or expanding behavior.

## Review focus

1. A feed fails after emitting apparently valid items: discard its buffered observations (Tasks 2–3).
2. Network headers return promptly but body never completes: deadline still aborts/cancels (Task 3).
3. Both sources contain a previously notified alias: no reanalysis or resend (Tasks 4 and 7).
4. RSS-only inputs have no Brave query ordinal: valid prompt and retained RSS telemetry (Tasks 4 and 6).
5. Feed or dependency supplies forged provenance/errors: no invented approved source or raw sensitive log data (Tasks 4 and 6).

## Task 1 — Approved registry and validation

**Files:** Add `src/config/rssSources.ts`, `test/rssDiscovery.test.ts`.

**Interfaces:** Export `RssFeedDefinition` as specified, `RSS_FEEDS`, `RSS_LIMITS`, and `validateRssFeeds(feeds: readonly RssFeedDefinition[]): void` (throws on invalid configuration; collector catches it).

- [ ] Write failing tests asserting the exact ordered registry tuples:

  | id | label | url | articleHostnames |
  | --- | --- | --- | --- |
  | openai_news | OpenAI News | https://openai.com/news/rss.xml | [openai.com] |
  | github_changelog | GitHub Changelog | https://github.blog/changelog/feed/ | [github.blog] |
  | cloudflare_ai | Cloudflare AI | https://blog.cloudflare.com/tag/ai/rss/ | [blog.cloudflare.com] |
  | chrome_developers | Chrome for Developers | https://developer.chrome.com/static/blog/feed.xml | [developer.chrome.com] |

- [ ] Assert empty registry is valid; six feeds, duplicate IDs/endpoints, non-HTTPS endpoints, credentials, non-default ports, fragments, IP/local/internal hosts and wildcard article hosts are invalid. Require nonempty exact ASCII hostname lists and unique ASCII-slug IDs. Test deceptive hostname suffixes and www/subdomains as nonmatches unless explicitly listed.
- [ ] Run `./node_modules/.bin/tsx --test test/rssDiscovery.test.ts`; confirm failures identify missing registry/validation behavior.
- [ ] Implement the registry with approval provenance dated 2026-10-16 and fixed limits: feeds 5, items 5, timeoutMs 5000, bodyBytes 262144, depth 32, elements 10000, fieldBytes 8192, titleBytes 256, snippetBytes 768, urlBytes 2048, ageMs 604800000. No environment overrides or fifth registry entry.
- [ ] Rerun the focused command; expect all registry tests PASS.

## Task 2 — Pure bounded RSS/Atom parsing and normalization

**Files:** `src/services/rssDiscovery.ts`, `test/rssDiscovery.test.ts`, `test/fixtures/rss/`, package manifest/lock.

**Interfaces:** Export `parseRssFeed(xml: string, feed: RssFeedDefinition, now: Date): RssParseResult`. Result has `positions: Array<{itemOrdinal: number; result: SearchResult | null}>`, `rejectedItems: number`, `itemsTruncated: boolean`. It retains only positions 1–5. Document errors throw an internal typed error carrying only a fixed reason; no raw parser error is exposed to logs.

- [ ] Write failing fixture tests for RSS 2.0 and namespace-correct Atom 1.0, relative links, unique HTML alternate links, CDATA/predefined entities, explicit timezone dates, seven-day inclusive boundaries, missing snippets and UTF-8-safe text caps. Assert exact normalized SearchResult values, including source label from registry.
- [ ] Add rejection tests: missing/HTML-bearing title, unknown article host, userinfo/non-default port, URL overflow/homepage, duplicate distinct alternate links, xml:base-dependent relative URL, missing/invalid/future dates. Assert invalid positions remain null and consume the first-five allowance; item six cannot replace them. Ignore guid/content:encoded/self/enclosure as article evidence. Omit HTML-bearing summaries; reject Atom XHTML title content.
- [ ] Add document failure tests for unsupported RSS/RDF roots, missing/multiple channel, namespace spoofing, multiple roots, unmatched/truncated XML after five valid entries, DOCTYPE/entity declarations, depth 33, 10001 elements and fields over 8192 bytes. Accept limit boundaries. Retain no candidates when document validation fails.
- [ ] Run the focused RSS test command; confirm RED for parser behavior.
- [ ] Select/pin the reviewed `sax` release and lock its resolution; add development typings only if needed. Implement strict namespace-aware/strictEntities parser events, explicit root/structure guards and resource counters. Do not use Node streams, DOM, network entity resolution, error resume or regex feed parsing. Validate the complete bounded document even after five positions. Resolve links against the fixed endpoint; use existing batch homepage validation and UTF-8 helpers. Normalize RSS RFC-style timezone dates and Atom RFC3339 to UTC, rejecting calendar rollover/ambiguous dates. Do not fetch any content.
- [ ] Rerun RSS tests and `npm run build`; expect PASS. Inspect an early Worker dry-run bundle using the final verification command in Task 7. A parser compatibility failure is an acceptance failure requiring the spec's bounded dependency amendment, not permission to write a custom parser.

## Task 3 — Bounded fetch and isolated collection

**Files:** `src/services/rssDiscovery.ts`, `test/rssDiscovery.test.ts`.

**Interfaces:** Export `collectRss(options: {now: Date; fetch: typeof fetch; feeds?: readonly RssFeedDefinition[]}): Promise<RssDiscoveryResult>`. `feeds` is an injection seam for offline fixtures; production omits it and always uses RSS_FEEDS. Result has `observations: Array<{result: SearchResult | null; provenance: {kind: 'rss'; feedId: string; itemOrdinal: number}}>`, plus `metrics: RssCycleMetrics` (defined below). No exception from feed acquisition escapes the collector.

`RssCycleMetrics`: `status: 'disabled' | 'configuration' | 'collected'`; numeric `configuredFeeds`, `attemptedFeeds`, `succeededFeeds`, `failedFeeds`, `observedPositions`, `validCandidates`, `rejectedItems`, `itemLimitTruncations`; `outcomes` capped at five `{feedId, reason, httpStatus?, elapsedMs}` entries. Reason is exactly the spec enum: disabled/configuration/http/redirect/timeout/body_limit/encoding/parse/structure/ok. Classify generic transport failure as http without a status; redirect:error may surface as that transport failure when Fetch does not expose its cause. Do not claim unavailable redirect diagnostics.

- [ ] Write failing mock-fetch tests for exact registry order/destinations, one GET each, redirect:error, no credentials, HTTP 200/XML media types, optional UTF-8 charset/BOM and a healthy empty feed. Assert the initial registry makes <= 4 requests and <= 20 observations; five-entry fixture <= 5/25.
- [ ] Test non-200/HTML/conflicting encoding, invalid UTF-8, body without Content-Length, oversized declared length and streamed decoded bytes >262144. Test both stalled headers and a stalled body with fake timers at 5000 ms; assert abort, reader cancellation, timer cleanup and no retry. No entity/article/pagination URL may reach fetch.
- [ ] Test malformed late XML discards a feed, next feed still runs; all feeds failing returns bounded diagnostics. Empty registry returns disabled/no fetch; invalid registry returns configuration/no fetch. Unexpected per-feed exceptions become sanitized failure outcomes.
- [ ] Run RSS tests to confirm RED, then implement sequential collection. Read bounded chunks with fatal UTF-8 decoding; count decoded response-body bytes, validate headers/encoding, and call Task 2 only with bounded input. Retain original positional provenance, including invalid null positions. Clear timers in finally and cancel on overflow/abort without allowing cancellation failure to replace the outcome.
- [ ] Rerun RSS tests; expect PASS. No live endpoint requests.

## Task 4 — Shared provenance, dedupe and deterministic batch admission

**Files:** `src/types/index.ts`, `src/services/batchCandidates.ts`, `src/services/batchPrompt.ts`, associated batch candidate/prompt tests. Mechanically adapt Brave observation construction in monitor and provenance discrimination in Worker so the new contract compiles; functional wiring/telemetry is completed in Tasks 5–6.

**Interfaces:** Introduce the spec's `DiscoveryProvenance` union and `BatchObservation {result, provenance}`. Use the union in BatchCandidate and selected metrics. Keep `prepareBatchCandidates` signature; add `poolCapExcluded` to pool counts. Existing history and notification dependencies remain required. Move/share RSS metric types from Task 3 in `src/types/index.ts` as needed without changing their names.

- [ ] Write failing tests with unordered Brave/RSS inputs: group by existing batchAliasKey, choose first Brave content over RSS regardless of arrival, union provenance/aliases deterministically, and retain first RSS content otherwise. Reject forged/unknown feed IDs, duplicate positions and out-of-range ordinals; enforce hard observation bounds without unbounded history work. Verify host/slash/fragment behavior and deliberately distinct query strings.
- [ ] Test every alias against both history stores, touch known discoveries, exclude any known/notified group and propagate read/touch errors. Interleave only after exclusion: Brave-backed and RSS-only alternation, Brave first, drain remainder, max 50, then assign sequential IDs. Assert overlap counts once, 70 unique input groups from the four approved feeds plus Brave produce 20 cap exclusions; forged fifth-feed observations are rejected rather than filling the unused ceiling, and zero RSS preserves existing Brave ordering.
- [ ] Test prompt queryOrdinals contain only sorted valid Brave ordinals, RSS-only gives `[]`, source title/URL are preserved, all prepared prompts <=32768 bytes and existing truncation stages/ID range remain unchanged.
- [ ] Run `./node_modules/.bin/tsx --test test/batchCandidates.test.ts test/batchPrompt.test.ts`; confirm RED, then implement the spec's grouping/history/interleaving algorithm. Preserve observedAliases for all groups, including excluded groups used by replay. Keep model schemas, response validator and durable URL normalizer unchanged.
- [ ] Rerun those tests and `npm run build`; expect PASS. Update only mechanical old provenance fixtures needed for compilation; do not relax assertions.

## Task 5 — Scheduled Worker integration and failure isolation

**Files:** `src/services/monitor.ts`, `src/worker.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`.

**Interfaces:** Add required `collectRss: (now: Date) => Promise<RssDiscoveryResult>` to BatchMonitoringDependencies. Add a matching collector override to WorkerMonitoringDependencyOverrides. Production closure calls Task 3 with cycle time and global fetch; tests supply an empty or controlled collector. Add optional `rss: RssCycleMetrics` to MonitoringCycleResult (legacy path does not acquire RSS).

- [ ] Write failing event-order tests: replay lookup → existing Brave loop → RSS collector → shared pool preparation → existing Gemini preflight/analyze → existing persistence/digest. Assert both sources enter one PreparedBatch and no RSS dispatch/analysis function exists.
- [ ] Test Brave quota stop/non-quota errors with healthy RSS; RSS failures with healthy Brave; RSS-only, empty combined, all sources failing, blocked preflight and replay-only behavior. Preserve current batch failure semantics, rather than importing the legacy all-search-failed exception. Failed feeds increment total failures once; item rejection does not.
- [ ] Test unexpected injected collector rejection is isolated: record an RSS collection failure (configuration status, zero candidates, no invented per-feed outcomes) and proceed with Brave/replay. Keep history errors outside this catch and assert they abort before analysis/send. Do not default a missing production dependency to a silent disabled collector.
- [ ] Run `./node_modules/.bin/tsx --test test/batchMonitoring.test.ts test/workerConfiguration.test.ts`; confirm RED, then implement only batch-path composition. Pass the captured cycleStartedAt for RSS age checks. Populate combined counts while preserving Brave-only search counters.
- [ ] Rerun focused tests and build; expect PASS. Assert Worker composition requires no X store/credential/0004 and legacy local monitor remains untouched.

## Task 6 — Bounded production telemetry

**Files:** `src/types/index.ts`, `src/services/monitor.ts`, `src/worker.ts`, `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`.

**Interfaces:** ScheduledCycleSummary exposes sanitized `rss`; BatchCycleMetrics exposes `poolCapExcluded` and `submittedBySource: {brave: number; rss: number}`. Source counts include overlap and are not additive. Selected provenance uses DiscoveryProvenance; no persistent analysis/D1 shape changes.

- [ ] Write failing summary tests: approved feed IDs only, at most five outcomes, enum reasons only, bounded HTTP status/elapsedMs (0–5000), no raw errors/feed URLs/content or secrets. Exercise forged IDs, oversized counts, invalid ordinals and mixed selected provenance. Global selected provenance <=75; per-source ranges still Brave 10×5/RSS registry×5.
- [ ] Assert combined pool counters <=75, poolCapExcluded <=75, submitted counts <=50, prompt <=32768, selected <=4, dispatch <=1, email <=1. RSS-only selected stories retain RSS provenance while queryOrdinals remain empty. Brave counters keep their existing meaning.
- [ ] Run the Task 5 focused command; confirm RED. Implement whitelisting/redaction using existing Worker summary conventions, not raw object spread; aggregate from actual collector/pool/prepared results. Keep candidate IDs validated against c001–c050.
- [ ] Rerun focused tests; expect PASS, including existing summary redaction tests.

## Task 7 — End-to-end offline regressions and final verification

**Files:** `test/batchMonitoring.test.ts`, `test/workerConfiguration.test.ts`, relevant existing tests from earlier tasks; bounded handoff update in PROJECT_STATE.md.

- [ ] Before fixes, add final regression cases proving the complete mixed-source path: mocked Gemini transport observes exactly one fetch dispatch, score below 7 cannot be delivered, <=4 fresh/replay stories, <=1 email, timeout/invalid output never triggers a second call, repeated cycles do not reanalyze known URLs or resend notifications. Exercise production-shaped persistence without migration 0004. Run the focused test command and record failures; fix only missing approved RSS behavior. If cases already pass, record that fact without manufacturing a failure.
- [ ] Run `npm run build` and `npm test`; all tests must PASS. Inspect scripts first; do not run monitor, dev, *:test provider/demo scripts, migrations or a live Worker invocation.
- [ ] Run `npm run worker:typecheck`; expect success. Inspect generated worker types and avoid unrelated generated-file churn. Run `npm ls --depth=0` and inspect the parser lockfile/dependency diff.
- [ ] Run local packaging only: `./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/ai-agent-radar-rss-dry-run`. Inspect the emitted bundle for unwanted Node filesystem/HTTP/stream, dotenv, local JSON or OpenAI dependencies; parser integration must not require new runtime polyfills/configuration. No deployment or provider access. Record artifact path, checks and actual results.
- [ ] Run `git diff --check`; inspect scoped diff/status, untracked additions and dependency changes. Verify no migration (especially 0004), X, Threads, secrets, Cron, Gemini accounting/transport, model output schema, or unrelated user file was changed. Inspect new files directly as untracked files are not covered by ordinary git diff.
- [ ] Update only relevant PROJECT_STATE text to distinguish implemented RSS from deployed production and preserve user edits. Record exact baseline/final revision, tests/results, deviations, parser pin/bundle evidence and changed files in the Builder handoff. No live-feed success or deployment claims without evidence.
- [ ] Submit the complete implementation for ONE independent final Analyst review, then Architect disposition. No per-task independent review gates. Production release and natural-Cron observation remain separately authorized; do not activate monitoring to prove the integration.

## Plan self-review

- Registry/approval/hostname policy: Task 1; all four approved tuples retained, fifth slot not automatically populated.
- Fetch/parser/date/text/resource limits and failure isolation: Tasks 2–3 and 5; no live fetching required for tests.
- Provenance, shared history/URL identity, 50-candidate interleaving and 32 KiB prompt: Task 4; source types remain consistent through Tasks 5–6.
- Single-dispatch/digest/replay invariants, telemetry and Worker compatibility: Tasks 5–7. No schema or X/0004 changes.
- No unresolved design decisions. Parser pin/Worker compatibility and runtime endpoint behavior are validation gates already required by the spec, not redesign permission.
- Execution is native Builder after plan approval, followed by one final independent Analyst review. This planning task implements nothing.
