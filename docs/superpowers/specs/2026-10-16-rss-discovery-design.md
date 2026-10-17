# RSS discovery design — 2026-10-16

Status: RSS_SPEC_FINALIZED — architecture and initial feed registry approved by the human owner on 2026-10-16. This is not production activation authority.

## Purpose and inspected baseline

Add curated first-party RSS/Atom observations to Brave's existing fresh candidate pool, then use the same single Gemini batch and digest. No Threads design, crawling, article fetching, X dependency, migration, new D1 schema, or accounting change.

Inspected local main: `846489e` (row-22 recovery merge). Current PROJECT_STATE reports deployed source `131a262e9ae959c6120603c8b4b566644854f4c2`, applied migrations 0001/0002/0003/0005/0006/0007, and disabled X with 0004 unapplied. Production was not queried for this design. Existing edits to backlog.md, plan.md, PROJECT_STATE.md and the existing untracked batch spec are preserved.

Relevant implementation: `runBatchMonitoringCycle`, `prepareBatchCandidates`, `prepareBatchPrompt`, batch validation/persistence, and Worker composition/summary. Candidate IDs currently span c001–c050; complete prompt limit is 32,768 UTF-8 bytes. The scheduled batch has one dispatch, no retry/fallback, score >= 7, at most four stories and one email, including replay. RSS must preserve these rules, not revive historical P4 below-threshold delivery or per-story analysis.

Documentation discrepancy: older PROJECT_STATE/Architect prose describes pre-discovery Gemini preflight and all-search-failed rejection. Current batch code collects Brave, prepares the pool, then checks Gemini availability, and records isolated search failures. Preserve current batch behavior; correcting unrelated historical prose is outside this task.

## Decision and flow

Use one small RSS collector plus a typed extension of the existing batch observation/provenance. A separate RSS analysis lane violates the dispatch constraint. A pluggable provider framework, durable feed cursor/cache and generic ingestion service add unnecessary state; do not build them.

1. Load bounded replay as today. Run the unchanged quota-guarded Brave collection.
2. Collect RSS once, sequentially in registry order, after Brave and before `prepareBatchCandidates`. This gives Brave no new acquisition failure dependency. A Brave quota stop or isolated search failures do not prevent RSS collection.
3. Combine both bounded observation arrays; normalize, group URL aliases and consult discovery AND notification history in the shared pool preparation step.
4. Keep at most 50 new unique candidates, assign c001–c050, and run the unchanged prompt byte reduction. Do not raise token/request limits to fit more inputs.
5. Existing Gemini preflight and atomic reservation remain authoritative. Zero or one batch dispatch; no RSS retries through Gemini. Persist validated selections and pass them to the existing merged fresh/replay digest.

RSS-only results can proceed when Brave yields no candidates. Failed/empty RSS leaves Brave and replay usable. Empty combined fresh pool skips Gemini. History read/touch failures still abort safely; they are not RSS failures to swallow.

## Registry and minimal contracts

Add `src/config/rssSources.ts` with a readonly ordered `RSS_FEEDS` array and hard limits. An empty array disables RSS without a secret or Cloudflare configuration change. Production composition always supplies the collector; tests inject it. No runtime URL input, remote registry or environment-controlled feed expansion.

```ts
interface RssFeedDefinition {
  readonly id: string;                 // unique stable ASCII slug
  readonly label: string;              // approved publisher label
  readonly url: string;                // exact public HTTPS endpoint
  readonly articleHostnames: readonly string[]; // exact approved hosts
}
type DiscoveryProvenance =
  | { kind: 'brave'; queryOrdinal: number; resultOrdinal: number }
  | { kind: 'rss'; feedId: string; itemOrdinal: number };
type BatchObservation = {
  result: SearchResult | null;
  provenance: DiscoveryProvenance;
};
// collectRss({ now, fetch }): Promise<RssDiscoveryResult>
// RssDiscoveryResult: observations plus bounded counts/per-feed outcomes.
```

Reuse `SearchResult` (title, url, optional snippet/publishedAt/source); do not create another article model. `BatchCandidate.provenance` and selected-story telemetry use the union. Registry position supplies feed ordering; feed content cannot assert its feedId or origin. This explicit union and collector return shape are the only future-source seam. Do not add Threads cases, interfaces, credentials or stubs now.

### Approved initial registry

The human owner explicitly approved these first-party endpoints and exact article hostnames on 2026-10-16. Preserve this registry order and these stable IDs. The approval supplied in this task is the provenance for the initial list; live endpoint availability has not been tested by this documentation task.

| ID | Publisher label | Exact feed URL | Exact allowed article hostname |
| --- | --- | --- | --- |
| `openai_news` | OpenAI News | `https://openai.com/news/rss.xml` | `openai.com` |
| `github_changelog` | GitHub Changelog | `https://github.blog/changelog/feed/` | `github.blog` |
| `cloudflare_ai` | Cloudflare AI | `https://blog.cloudflare.com/tag/ai/rss/` | `blog.cloudflare.com` |
| `chrome_developers` | Chrome for Developers | `https://developer.chrome.com/static/blog/feed.xml` | `developer.chrome.com` |

These four entries are approved for the later source-controlled registry; the five-feed ceiling does not authorize adding a fifth feed. For future additions or endpoint/hostname changes, record first-party ownership evidence, human approver and approval date through source-control review. Feed delivery and article hosts may differ only when explicitly approved. No wildcard/subdomain inheritance, aggregators, proxies, auto-discovery or subscription imports. RSS admission does not modify the separate trusted-source registry or confer a relevance bonus.

## Acquisition and parsing bounds

Approved fixed v1 limits: five feeds, one GET per feed, five observed item positions per feed, at most 25 RSS observations and 75 combined observations. The initial four-feed registry yields at most 20 RSS observations and 70 combined observations within those ceilings. Invalid/stale items consume their positions; do not scan deeper to refill them. Registry validation rejects duplicate IDs/endpoints or more than five entries; invalid RSS configuration disables RSS with an explicit configuration outcome while Brave continues.

Each feed has a five-second deadline covering headers and body reading. Sequential collection adds at most 25 seconds of network waiting (20 seconds for the approved initial four feeds); no retry, pagination, conditional cache or background work. Abort and cancel the reader on timeout/overflow; clear timers in finally. Use redirect:error, no credentials, no cookies or authorization. Only exact approved public HTTPS endpoints, default port, no userinfo, fragments, IP literals or local/internal hostnames. Never fetch an item's URL, enclosure, stylesheet, DTD, entity or Atom pagination link. The initial endpoint approval is recorded above; hostname validation alone does not establish first-party ownership for future additions.

Require HTTP 200 and XML/RSS/Atom content type (`application/rss+xml`, `application/atom+xml`, `application/xml`, `text/xml`, optional charset). Reject HTML and unsupported encodings. Accept UTF-8 (including BOM); reject conflicting encoding declarations. Limit actual decoded response-body bytes to 256 KiB; Content-Length is only an early rejection aid. Enforce this on streaming reads, not after an unbounded response.text().

Use one small XML parser dependency, not regex-based feed parsing or a Node HTTP RSS client. Recommended: `sax` parser API in strict, namespace-aware, strictEntities mode; no Node stream API. [Upstream documentation](https://github.com/isaacs/sax-js) documents these modes and browser use, but does not claim full XML validation. Builder must pin/review the resolved release, enforce document/feed structure independently and prove Worker bundling before acceptance. No dependency installed by this design.

Reject DOCTYPE/entity declarations, parser errors, multiple roots, unclosed/truncated XML and namespace spoofing. No error recovery/resume. Enforce depth <= 32 and <= 10,000 element openings, with bounded field buffers (8 KiB each); reject overflow. Parse the complete bounded document to validate it, retaining only the first five RSS channel/item or Atom feed/entry positions. Later items are not candidates. Discard the whole feed's buffered candidates on document failure, while invalid individual items in a valid feed are skipped. Byte/depth/element limits bound synchronous parser work; a timer alone cannot interrupt synchronous parsing.

Support RSS 2.0 and Atom 1.0 only. RSS needs one channel; Atom root and core elements must use the Atom namespace. Ignore unrelated extension fields. No RDF/RSS 1.0 support in v1.

## Item normalization and deduplication

- RSS: title, link, description, pubDate. Do not use guid as an alternative URL or fetch content:encoded. Atom: title, summary, published (updated only if published is absent), and one distinct HTML alternate link (rel absent or alternate, type absent or text/html). Reject missing/ambiguous article links; never use self/enclosure links as article identity.
- Resolve relative article links against the fixed feed endpoint; reject xml:base-dependent relative links rather than implementing inherited bases. Require HTTP(S), no userinfo, default port and exact approved article hostname; URL length <= 2,048 UTF-8 bytes. Reject homepage URLs using the shared batch rule.
- Normalize whitespace; require a nonempty title, capped at 256 UTF-8 bytes. Optional snippet <= 768 bytes, Unicode-safe. Text/CDATA is untrusted data, never rendered as HTML. For HTML-bearing summaries/titles, conservatively omit the snippet or reject the unusable title instead of adding an HTML extraction engine. Missing snippet is valid. Atom XHTML content is not supported in v1.
- Require an explicit valid publication date with timezone, normalize to UTC, and admit only `[cycleStart - 7 days, cycleStart]`. Missing, invalid or future dates are skipped. RSS date parsing must accept documented RFC-style dates with numeric offsets/GMT/UT; reject ambiguous local dates rather than guessing. Atom uses validated RFC3339. Preserve document position; no date sorting or replacement scan.
- Canonical identity is the existing `normalizeDiscoveryUrl` plus `batchAliasKey` fragment grouping. Host case/default ports/trailing slashes normalize as today. Do not strip arbitrary queries/UTM parameters, merge www/non-www, equate HTTP/HTTPS, resolve redirects or introduce URL alias storage. Differing query strings remain distinct by design; curated feeds must expose stable direct article links.
- Sort Brave observations by query/result position and RSS by registry/item position. Group all 75 possible observations before selecting: Brave wins representative title/URL when both sources observe the same key; otherwise first RSS occurrence wins. Union validated provenance and observed normalized aliases in that deterministic order. Preserve source title/URL binding against model substitution.
- Apply existing history/notification reads to every observed alias and touch known discoveries before exclusion. Keep durable keys and replay semantics unchanged; this adds no stronger cross-cycle alias guarantees than the existing normalizer.
- After known groups are removed, split groups into Brave-backed (including overlaps) and RSS-only, then alternate Brave-backed/RSS-only, beginning with Brave, preserving each list's order. Drain the nonempty list when the other ends. Take 50, record pool-cap exclusions, then assign IDs. Disabled/empty RSS preserves Brave order exactly. This modest deterministic allocation prevents systematic RSS starvation without relevance scores or reserved output slots.

## Provenance, prompt and observability

Provenance remains cycle-local in candidates and the persisted Worker log summary. Do not extend XSourceProvenance, D1 discovery schemas or stored analysis payloads. The article URL/title already survives persistence and replay; replay need not retain its acquisition channel in v1.

Keep model input/output schema and response validator unchanged. Derive existing queryOrdinals only from Brave provenance; RSS-only inputs use an empty array. The model needs article evidence, not registry authority labels. It cannot assign provenance or relax score >= 7.

Extend existing scheduled summary with an `rss` object: configured/attempted/succeeded/failed feeds, observed positions, valid candidates, rejected items, item-limit truncations, and at most five per-feed outcomes keyed by approved feedId. Outcomes use fixed reason enums (disabled/configuration/http/redirect/timeout/body_limit/encoding/parse/structure/ok), optional HTTP status and bounded elapsed milliseconds; no raw exceptions/content/URLs. Add `poolCapExcluded` and source-kind counts for submitted candidates, plus source union in selected-story provenance. Multi-source counts overlap and must be labelled as such. Keep existing Brave counters Brave-only; combined pool counters accept up to 75, submitted IDs stay <= 50, prompt bytes <= 32,768, provenance total <= 75, selected <= 4, dispatch <= 1 and email <= 1. RSS feed failures increment the overall failure count once per feed; ordinary rejected items are diagnostics, not cycle failures.

Production verification, only after separately approved release: inspect a natural scheduled summary for RSS outcomes, shared dedupe/known counts, submitted/selected RSS provenance and dispatch/email ceilings. No manual monitoring endpoint or test provider dispatch. An RSS candidate being submitted but not selected is valid behavior, not proof of a broken integration.

## Acceptance tests

All tests offline with injected fetch/clock and XML fixtures:

1. Valid RSS 2.0/Atom, namespaces, CDATA/XML entities, relative links, alternate-link selection, dates/7-day edges, omitted summaries; malformed/unsupported/ambiguous items fail safely.
2. Five-feed/five-position limits, invalid positions consuming slots, deterministic registry order, no follow-up pagination/refill, byte/depth/element/field overflow, truncated XML after retained items, DTD/entity rejection and namespace spoofing.
3. Slow headers AND slow streaming body abort, reader cancellation, redirects/non-200/HTML/encoding rejection, thrown fetch, one failed feed with four healthy feeds, all feeds failing while Brave still succeeds. Assert exact request destinations and zero article/entity requests.
4. Brave/RSS duplicate variants produce one candidate with combined provenance and Brave source evidence; distinct query URLs remain distinct. History/notified aliases exclude both; history errors abort. Repeat discovery across cycles never reanalyzes stored URLs or resends notified ones.
5. Deterministic interleaving after history exclusion, overlapping groups counted once, 75 observations capped at 50 candidates, stable IDs, zero RSS preserves existing Brave behavior. Prompt reduction/byte ceiling and validator ID ceiling remain intact.
6. RSS-only, Brave-only, combined, empty, all failures, blocked Gemini, timeout and invalid model output: zero or one actual Gemini dispatch, never retries/fallback; score >= 7, max four fresh/replay stories, max one email; source integrity and replay regressions pass.
7. Summary bounds/redaction, forged provenance/unknown feed IDs, correct Brave-only vs combined counts. Worker wiring uses RSS without any X store/credential or migration 0004. Worker dry-run bundle contains no Node filesystem/HTTP/stream requirement from the parser.

## Expected Builder files and sequence

Add: `src/config/rssSources.ts`, `src/services/rssDiscovery.ts`, `test/rssDiscovery.test.ts`, and small fixtures under `test/fixtures/rss/`.

Modify: `src/types/index.ts`, `src/services/batchCandidates.ts`, `src/services/batchPrompt.ts` (Brave provenance extraction only), `src/services/monitor.ts` (batch path only), `src/worker.ts` (composition and sanitized summary), `package.json`/`package-lock.json`; tests `batchCandidates.test.ts`, `batchPrompt.test.ts`, `batchMonitoring.test.ts`, `workerConfiguration.test.ts` as needed. Record the approved behavior in PROJECT_STATE.md during Builder handoff without replacing unrelated edits. No change expected to analysisAgent, Gemini transport/accounting, persistence, formatter, legacy local monitoring or any migration.

1. Use the recorded architecture/feed approval; preserve current user edits and establish the approved Builder baseline. Carry the approved registry and its provenance into implementation; implement registry validation and limits.
2. Add pinned parser and bounded collector with offline fixture/fetch tests; verify Worker compatibility early. If the selected parser cannot meet the contract, return for a bounded dependency amendment rather than inventing a custom XML parser.
3. Extend observation/provenance, shared grouping/history checks and the 50-candidate selection; retain prompt/validator ceilings.
4. Wire RSS into scheduled batch before preparation and add bounded summary telemetry. No changes to legacy per-story/X paths or runtime accounting rules.
5. Run relevant tests, full offline suite, TypeScript/Worker checks and an inspected deployment dry-run/bundle audit; inspect diff for scope and untouched migrations. Independent Analyst review, then Architect disposition and separate human release authority. Do not call monitoring/provider scripts.

This task finalizes this specification only. No runtime implementation, dependency installation, runtime registry file creation, implementation plan, commit, deployment or production action is performed. No unresolved design decision remains. Parser release verification and endpoint/runtime compatibility tests remain implementation acceptance gates, not missing feed approval. A failing endpoint must fail closed under this spec; it does not authorize a replacement URL or redirects.
