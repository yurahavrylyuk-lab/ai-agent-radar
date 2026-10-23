# RSS BODY_LIMIT reliability — bounded design amendment

Date: 2026-10-23. Status: **DESIGNED / PLANNED / NOT IMPLEMENTED YET**. The human has chosen the approach; this amendment makes its safety and release gates explicit. No broad RSS redesign or runtime implementation.

## Baseline and evidence

Local main/HEAD verified at `353c718a146252be47a2d6fbf926fdfbf3e81598`, a docs-only governance commit preserved as branch base. Branch: `codex/rss-body-limit-reliability`; no worktree. Protected untracked `docs/superpowers/specs/2026-10-12-batch-gemini-daily-radar-design.md` SHA-256 before work: `67ebe90fdda67d9312f952cb477d38e5c78fff69396f8e4bbbc6bc6405d09a66`; preserve byte-identically and exclude from staging.

Human-verified production source is `223a1b90b9d64483b47717bd02a9d9c334fd3e0d`, Worker `b8f02106-f558-43a2-a428-529b2051512f`, deployment `44a6b945-07ba-4154-877a-433949ce4e5f`. Gemini Latency Reliability remains **DEPLOYED / AWAITING NATURAL PRODUCTION VALIDATION**. No production/feed access was performed here.

Supplied 2026-10-23 natural evidence: four RSS feeds, GitHub Changelog/Chrome succeeded, OpenAI News/Cloudflare AI failed with body_limit. This identifies a size rejection, not proof those documents will pass every other safeguard at 1 MiB. Do not claim the fix is naturally validated before release.

## Exact change

Only runtime edit: `src/config/rssSources.ts`, `RSS_LIMITS.bodyBytes: 262144 → 1048576` (256 KiB → 1 MiB). The constant remains global, frozen and source-controlled, with a hard streamed-byte ceiling inclusive at exactly1048576. No per-feed or environment override.

Inspected `rssDiscovery.ts`: collector rejects oversized Content-Length before reading; boundedXml also validates numeric length and counts actual streamed bytes before decoding/append. Overflow cancels the reader without awaiting cancellation, then releases its lock. The complete bounded document is parsed before selecting the first five item positions. Feed loop is sequential. No collector/parser runtime change is needed.

Preserve feeds<=5, itemsPerFeed5, timeout5000ms, depth32, elements10000, field8192 bytes, title256, snippet768, URL2048, age604800000ms (7 days), exact article host validation, fatal UTF-8 decoder, redirect rejection, no retries and existing safe cancellation. Preserve current timeout mechanics: timer covers network/body; synchronous XML parsing is not preempted by the timer. Structural limits remain the CPU/memory guard for parsing; do not claim a new hard parser deadline.

Invalid/non-numeric Content-Length remains fail-closed with existing body_limit classification at collector boundary. Numeric header<=cap is not trusted over actual streamed bytes. Do not normalize bad headers into acceptance or change missing-header behavior.

## Acceptance criteria

1. Valid RSS and Atom bodies above262144 and at/below1048576 are accepted, including exactly1048576 bytes, provided all other guards pass.
2. Streamed1048577 bytes rejects as body_limit, cancels the still-open reader, returns no observations from that feed, and continues later feeds. Early Content-Length1048577 rejects before reading/parsing.
3. Missing/underreported length still uses actual bytes; non-numeric/negative/fractional length fails closed. Overflow cancellation rejection/stall cannot replace or delay the primary failure. Existing timeout regressions remain green at5000ms.
4. Valid first-five-item prefix followed by malformed XML or missing final close tag rejects the entire feed, including in the newly admitted size band. No partial observations escape.
5. Depth33, elements10001, text/attribute field8193 violations reject inside a body below1 MiB; existing DOCTYPE/entity and URL/secondary-fetch guards hold. Other valid feeds still run sequentially once.
6. Telemetry retains body_limit and correct succeeded/failed counts; item extraction still takes five positions, not five arbitrary successful items. No article/entity/secondary requests.

## Memory/Worker assessment

Wire allowance grows4x, not to an unbounded buffer. At most one feed body/tree is actively parsed at a time; retained output remains at most25 bounded positions. A1 MiB valid UTF-8 document can require multiple MiB for decoder/string/parser/tree copies, plus object/attribute overhead; the byte cap is not an exact heap bound. Tree node count<=10000, depth<=32 and per-field<=8192 remain fixed. No external entity expansion or article-body acquisition is added. Garbage collection may retain prior feed allocations temporarily; sequential operation does not prove immediate release.

Architect assessment: this remains a reasonable bounded increase with no concrete blocker in the current sequential design. Require a local Workerd smoke gate for sequential near-limit tree-heavy fixtures and overflow/isolation, not just comment-padding acceptance in Node. It is a functional runtime/memory-pressure check, not a measured production heap guarantee. On a local resource/CPU failure, stop and report; do not silently redesign the parser, parallelize feeds or raise another limit. No live-feed fetch is needed.

## Rejected alternatives and release gate

Do not use prefix parsing, partial XML, HTTP Range, per-feed caps, retries, changed timeout/age/items/registry/structure limits, new parser, parallel collection or source/Gemini changes. No Threads, semantic dedupe, email idempotency or migration/D1 work.

Build/test/review and later authorized publishing/merge may proceed independently of deployment. **NO RSS DEPLOYMENT ON 2026-10-23.** First validate the 2026-10-24 natural Cron from exact currently deployed Gemini-only source `223a1b90b9d64483b47717bd02a9d9c334fd3e0d`. Then obtain a separate explicit human deployment approval for the reviewed RSS build. A merge/new main does not change which source generated that Cron. If the Cron did not run on that source or its validation is inconclusive, deployment stays held for human disposition. No manual cycle substitutes for it.

This task creates documentation only: no push, PR, merge, deploy, provider/feed call, D1 or migration action. Migration required: **no**. Future Builder changes only the one runtime constant and focused tests, with governance updated truthfully after verification.
