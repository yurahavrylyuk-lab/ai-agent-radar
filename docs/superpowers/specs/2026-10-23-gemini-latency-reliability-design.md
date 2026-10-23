# Gemini latency reliability design

Date: 2026-10-23. Status: ARCHITECTURE_READY, recommended design for human review. Architecture/docs only; no implementation plan, runtime change or release authorization. Main baseline: `4eb3cf049f222b1193d827b94b93f88196b03880`; branch: `codex/gemini-latency-reliability-design`.

## Reconciled production evidence

The human handoff verifies Worker `04ffb752-0e5e-4e15-be37-26af010fa503`, deployment `309f3faf-72b7-4c09-bbd1-ad839efa2155`, D1 `9fb545e2-2f43-4922-8b21-2d79a8de9556`. Migration 0008 is applied;0004 intentionally unapplied. Daily email guarantee, polished degraded design, durable cycle and attempt telemetry are naturally validated. V2 is deployed/partially naturally validated: timeout/accounting/fallback proven, 503 retries not naturally exercised.

Scheduled `2026-10-23T08:00:49.466Z`, completed `2026-10-23T08:03:06.914Z`. Reported execution runtime ~136.4s; these two timestamps span137.448s, so do not equate scheduled time with execution start. Brave healthy:10/10 searches,50 results. RSS degraded:2/4 successful feeds.60 raw observations→47 submitted candidates→24,303-byte prompt. One gemini-3.8-flash dispatch,75.331s, timeout/transport_ambiguous, no retry; one accepted degraded email attempt. No production query was made here.

Measured bottleneck: Gemini exhausted its75s allowance. Exact provider queue/prefill/thinking/output split is unavailable; input size and default thinking are controllable contributors, not proven exclusive causes. There is no evidence of a fixed transport-layer disconnect independent of workload. Optimize work before adding asynchronous infrastructure.

## Inspected implementation

- `batchCandidates.ts`: validates bounded Brave/RSS positions, groups normalized URL/fragment aliases, checks all aliases against discovery and notification history, touches known discoveries, then alternates Brave-backed and RSS-only groups and caps at50. IDs and full observations are application-owned.
- `batchPrompt.ts`: measured static instructions3028 UTF-8 bytes; fields per candidate are ID/title/snippet/full URL/date/query ordinals. Current title cap256 bytes, snippet768, total32768; smaller snippet stages activate only when total exceeds the cap. The handoff's24,303 bytes are below that cap, so the initial768-byte stage can retain unnecessary volume. At this source,3028 instructions +2 newline bytes leave21,273 bytes for JSON in that reported prompt. Actual article distribution was not retrieved; no per-field production attribution is claimed.
- `monitor.ts`: prepares the prompt after pool construction; `prepared.candidates` constrains analysis validation, but `pool.candidates` and `observedAliases` feed raw fallback. Preserve that separation.
- `gemini.ts`: native fetch POST to `https://generativelanguage.googleapis.com/v1beta/interactions`, body exactly `{ model, input }`; no SDK, explicit thinking, output-token limit, tools or background flag. Existing response text/usage validation and V2 accounting remain authoritative.
- `monitoringTelemetry.ts` / applied 0008: snapshot_json accepts valid JSON <=8192 bytes in SQL; schema_version is constrained to1. TypeScript currently enforces exact snapshot keys. Existing attempt timestamps include reservation/settlement overhead; they are not pure inference timing.

## Approaches and decision

| Approach | Benefit | Cost/risk | Decision |
| --- | --- | --- | --- |
| A: smaller synchronous Batch + low thinking | Reduces input and reasoning work without new inference/state lifecycle | Fewer candidates can reduce recall; low effort may reduce analysis quality; speedup unproven | **Recommend now** |
| B: background interaction + polling | Can outlive an HTTP wait and retrieve a later result | Stored jobs, privacy/lifecycle/accounting/recovery, polling, uncertain-create identity; does not make generation faster | Defer |
| C: second Gemini model/hybrid | Could recover safe zero503 failures | Cannot follow today's ambiguous timeout; adds model/quality/accounting policy with little benefit for this incident | Defer |

Recommended flow: unchanged10 Brave searches + unchanged RSS → unchanged shared history/URL dedupe and50-candidate pool → deterministic24-candidate analysis subset → compact <=12 KiB prompt → synchronous gemini-3.8-flash with explicit low thinking → existing validated normal digest; terminal failure→unchanged full-pool polished degraded/status finalizer. No second analysis lane. These are Architect recommendations, not a claim of already approved implementation details.

## Deterministic pre-Gemini selection

New pure selection boundary immediately after prepareBatchCandidates and before prepareBatchPrompt; input is at most 50 fresh safe unsent candidates with existing provenance, output at most24, with original IDs, aliases and source object preserved. It cannot mutate full pool/history or mark excluded items analyzed/notified. Excluded candidates remain eligible for existing raw fallback and future rediscovery under unchanged history rules.

Exact policy, no semantic score:

1. Assign each candidate to one bucket. If any Brave provenance exists, use the lowest queryOrdinal and lowest resultOrdinal within it (Brave-backed ownership); otherwise use first approved feed in registry order and lowest itemOrdinal. Dual-provenance items occur once and retain both origins for telemetry.
2. Brave has10 query queues; RSS has4 approved feed queues (registry remains max5). Sort each queue by result/item ordinal, then original candidate index, then candidateId. No locale-sensitive comparison. Invalid provenance cannot be invented; input was already validated.
3. Service queues round-robin within each source with rotating cursor. Source slots repeat `Brave, Brave, Brave, RSS`, aiming at18 Brave-backed +6 RSS-only for24 slots when both supplies permit. If a source has no selectable item, immediately borrow its slot from the other. Start cursors at query1 and first approved feed. No artificial empty slots or requirement for24 if fewer exist.
4. First pass permits at most2 selections per exact normalized hostname across both source types. Deferred same-host items stay in their original queues. A queue with only deferred items is skipped. If a complete source/query/feed sweep makes no progress before24, second pass relaxes the hostname cap and continues the same queue cursors until24 or exhaustion. This soft cap avoids monopolization without discarding useful sole-source days. Count hostnames exactly, no registrable-domain guessing.
5. Return selection order as the stable prompt/byte-tail order. No randomness, new AI call, keyword weighting, embeddings, trust bonus or freshness invention. Source trust is not relevance; existing provenance/rank already supports the smallest explainable rule. Missing snippets/dates do not disqualify a valid item. Repeated identical input yields identical IDs/order.

This preserves acquisition and source opportunities, not every candidate's chance of reaching Gemini. Query/feed diversity and host cap are deliberate recall tradeoffs; severe domain concentration can override nominal source allocations through the soft-cap rule. Test that explicitly. Keep full metadata locally and use the original application-owned link/title when delivering a selection.

## Prompt reduction and output quality

Hard Gemini subset cap24; desired20–24 when enough diverse items exist. Hard prompt cap12,288 UTF-8 bytes, including instructions, delimiters and serialized JSON. Typical target8–12 KiB. This is at least49.4% smaller than the incident's24,303-byte prompt at the hard cap; candidate count24 is48.9% below47. Neither percentage predicts the latency speedup.

Candidate wire representation: `{candidateId,title,snippet,sourceHost,publishedAt}`. Remove full URL and queryOrdinals from model input; application keeps original link/title and complete provenance for validation/delivery. sourceHost is exact normalized hostname when <=128 UTF-8 bytes, otherwise null; never truncate it into a different hostname. publishedAt keeps existing validated ISO-or-null rule. Title limit160 bytes; initial snippet limit192 bytes, whitespace-normalized at Unicode boundaries. No article fetch, body ingestion or new snippet HTML subsystem. All fields remain untrusted reference data.

Keep instruction block <=3072 bytes. Remove only input descriptions for deleted fields/redundant wording; retain injection boundary, topic coverage, no-filler, full closed schema/categories, score1–10 and non-increasing order, original-ID uniqueness, no invented facts/URLs, educationalValue/projectOpportunities and current first-detailed/later-concise output limits. No schema relaxation or new output repair call. Do not add a tight max_output_tokens cap that can truncate valid structured output.

Byte packing: serialize all24 selected candidates with160-byte titles and192-byte snippets; if over12,288, shrink snippets uniformly to128,96,0, then titles128, then remove tail candidates one by one. Preserve diversity order through packing; never replace tail with unrelated fill. JSON escaping counts against actual bytes. If no item fits, existing preparation failure→fallback; no dispatch. IDs are never renumbered. Track selector exclusions separately from byte exclusions.

Token target is not measurable exactly offline with this repo: no model tokenizer/count API is invoked. For mostly English input,8–12 KiB is a rough planning range of2–4k input tokens, not quota evidence or a hard guarantee; use returned actual usage for accounting. Output remains up to4 stories: #1 detailed, #2–4 concise, relevance score, educational value and project relevance. Scores below7 retain `It could be relevant` on analyzed stories only. Reduced recall/nuance must be reviewed in the natural validation window.

## Exact thinking configuration

CURRENT: no generation_config in native REST body; documented gemini-3.8-flash default is medium. TARGET: add `generation_config: { thinking_level: "low" }` to scheduled Batch requests only, leaving the existing API path/model and V2 retry/accounting unchanged. Official REST example uses precisely this snake_case nesting. Low is the lowest supported level for this model; minimal is rejected. Expected benefit is less reasoning work, with no promised numeric speedup. Risk is poorer ranking/grounding; test request shape offline and review actual outputs naturally. [Thinking guide](https://ai.google.dev/gemini-api/docs/thinking), [model capabilities](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

No guessed thinkingBudget/camelCase GenerateContent fields, temperature/seed change, model substitution, tools, output-token clamp or retry-on-configuration-error. Keep background false by existing default; do not change store/retention settings in this latency change. Documentation notes max_output_tokens includes thinking and can terminate output; lowering thinking is the chosen lever. [Interactions REST reference](https://ai.google.dev/api/interactions-api), [thinking guide](https://ai.google.dev/gemini-api/docs/thinking). Sources checked2026-10-23; recheck the contract at future implementation without an inference probe.

## Background execution assessment (record only)

Official documentation explicitly supports gemini-3.8-flash on the repo's v1beta Interactions path, returns an interaction ID and continues execution server-side. Background requires store=true; free-tier retention is1 day, paid default55 days (configurable). Existing requests already omit store, whose documented default is true; do not falsely describe current production as stateless. This is provider retention, distinct from content-free D1 telemetry. [Background execution](https://ai.google.dev/gemini-api/docs/background-execution), [storage policy](https://ai.google.dev/gemini-api/docs/interactions-overview#data-storage-and-retention).

Architect assessment of what adoption would require:

- One accepted submission remains one inference/accounting attempt; polling is retrieval, not another inference reservation. Retrieval pricing/quota and cancellation final-usage guarantees were not established by the reviewed pages; no free polling/billing exemption is assumed. Standard token accounting remains necessary even if Worker waiting ends; background is not the discounted Batch API.
- A bounded candidate protocol would poll the same durably saved ID every5s, at most12 GETs and never beyond the existing75s decision cutoff; all requests have remaining-budget timeouts. This buys reconnectability, not faster inference or a same-day late email. A job still running at cutoff remains unresolved, never confirmed_zero. Durable recovery beyond that cutoff would need separately approved scheduling/lifecycle design.
- To prevent duplicates, persist submission intent/ownership first, save returned ID before polling and never automatically resubmit on lost create acknowledgement or poll timeout. Cancellation request is not proof of zero usage. Provider idempotency cannot be assumed. Restart handling must locate the same job or preserve uncertainty; no second email after an earlier fallback.
- Applied0008 can record attempt diagnostics but has no durable provider-job identity, pending-background lifecycle, poll ownership or recovery contract. Its existing usage state machine cannot safely express accepted continuing background work with later exact reconciliation. A separate reviewed additive migration/accounting design would be needed; do not hide operational job state in telemetry JSON.

Conclusion: no evidence yet that transport, rather than unoptimized workload, is the remaining limit. At the same 75s cutoff background may still yield fallback. Increasing it or recovering later would expand scope/latency/privacy/accounting requirements. Defer until optimized A has repeat timeout evidence. No background polling/client/scheduler or migration is included now.

## Model fallback assessment and accounting

Defer second-model fallback. It could only follow a safely classified durable confirmed-zero failure such as503, within the same total3-dispatch allowance, unchanged quotas and deadline. That is not today's timeout. Never advance models after timeout/transport_ambiguous,429 or accounting uncertainty. No unknown execution triggers a duplicate inference.

Retain V2 max 3 same-model dispatches after unavailable_503 plus atomic confirmed_zero evidence, delays 1500–2000ms and3000–4000ms, >=10s remaining after backoff, one 90s envelope and75s Gemini cutoff. Separate reservation per dispatch, exact model attribution, unchanged accounting intervals, timeout-day guard and prior rows. No runtime budget/paid tier/secret changes. More compact input does not authorize token estimates or early zero settlement. Configuration errors are terminal under existing validation/accounting rules. Daily fallback and email finalization stay outside provider cancellation.

## Telemetry without a new migration

Reuse applied 0008 snapshot_json; keep schema_version=1, existing keys and8192-byte bound. No SQL edit/new migration. Add a strictly allowlisted optional `latency` extension, `latency.version=1`; reader accepts precisely legacy key-set or legacy+latency, never arbitrary extras. SQL validates JSON/size, not this key-set. Missing extension on historical rows means unknown, not zero/default-low.

Extension fields: `preFilterInputCount`0..50; `selectedCount`0..24; `selectorExcluded`0..50; `byteExcluded`0..24; `submittedCount`0..24; `promptBytes`0..12288; `snippetBytesLimit` enum192/128/96/0; `thinkingMode` enum low; `executionMode` enum synchronous; `attemptTimings` array max 3 of `{ordinal:1|2|3, requestStartedAt:UTC ISO or null, elapsedMs:integer0..180000 or null}`. Stage-unknown scalar fields are null; no inference is falsely attributed when none dispatched. No background poll field for a disabled feature. Existing attempt table supplies terminal failure/accounting/retry reasons; existing delivery reason supplies final fallback reason.

Capture real requestStartedAt immediately before fetch, elapsed via monotonic clock through response processing/error on each attempt; do not reuse existing cumulative/clamped elapsed fields or equate usage-row timestamps with network latency. Preserve untruncated measured cleanup overrun (e.g.75.331s) within the bound; beyond180000 use null plus incomplete evidence rather than an invented value. Freeze request timing before settlement latency; overall cycle timestamps remain separate. Per-attempt snapshots accumulate within the existing snapshot, no raw content or identifiers beyond existing approved IDs.

Persist workload/mode before dispatch in sources_complete; update timings after each completed/terminal attempt before another dispatch and again at final checkpoint. Retain all prior timing entries through finalization. Existing telemetry failure behavior remains: failure before admission blocks Gemini but finalizes delivery; after dispatch settle accounting safely, stop retries on lost evidence, and never initiate replacement email. This is observation, not the deferred telemetry-degraded continuity redesign.

Current candidateCounts.unique is populated from acceptedObservations in source; do not silently interpret it as deduped cardinality or broaden into a metrics cleanup. New preFilterInputCount explicitly uses pool.candidates.length.

Compatibility: new reader reads old rows; old V2 parseCycleSnapshot rejects the extension. A rollback Worker creates only new legacy-shaped records and the current runtime does not read historical cycle rows for admission; it must not rewrite new-format records. Operational inspection after rollback uses the updated reader/raw bounded query, not the old strict reader. Offline tests must prove old Worker paths ignore historical extensions and new reader preserves both. If implementation discovers a historical read dependency, stop for a compatibility amendment rather than editing applied 0008 or claiming transparent old-reader compatibility.

## Performance and quality acceptance

| Measure | Baseline | Initial target / rule |
| --- | --- | --- |
| Candidates |47| Max24;20–24 when supply and byte packing permit |
| Prompt |24,303 bytes| Hard12,288, aim8–12 KiB |
| Gemini completion |timeout75.331s| Goal median <=45s for successful dispatched cycles; aim typical30–45s, not an SLA |
| Provider cutoff |75s| Unchanged75s; any cleanup overrun measured honestly |
| Total cycle |reported~136.4s| Goal median <=110s with comparable acquisition; slow discovery/provider conditions can miss it |
| Delivery |one accepted degraded attempt| Always <=1 attempt; normal on valid analyzed selections, polished degraded/status otherwise |

No offline test can prove lower provider latency. Run first 3 eligible natural Cron cycles after separately approved release; extend to5 if any timeout/invalid output or too little evidence. Initial success criterion: all3 if stopping at3, otherwise >=4/5 dispatched cycles produce valid structured completions before cutoff; median successful latency<=45s, median total<=110s on comparable source conditions. Report censored timeouts separately, every cycle and sample denominator, normal/degraded split, and distinguish zero valid selections from provider failure. Do not claim statistical SLA proof from this small window.

Admission-blocked days are recorded but excluded from dispatched completion denominator; no probe/manual cycle to fill gaps. If fewer than3 dispatched observations within5 natural scheduled cycles, call evidence insufficient and ask for a later observation window, not silently extend indefinitely. Two timeouts or clear quality regression triggers architectural review, not automatic background/model fallback. Preserve all uncertain accounting evidence.

Quality review of emitted content: correct source binding, no unsupported facts, detailed first/concise later content, useful educational/project implications, score/label consistency and no duplicate delivery. Offline fixed candidate fixtures cover query/feed/topic diversity and reference-worthy items near source positions; they cannot prove real model quality. Do not ship prompt simplification that drops required schema/injection protections. No A/B double inference or provider benchmark is authorized.

## Verification, file scope and later handoff

Likely future changes: `src/services/batchCandidates.ts` or a small pure `batchCandidateSelection.ts`; `batchPrompt.ts`; scheduled-only request assembly in `src/tools/llm/gemini.ts`; minimal `monitor.ts`, `worker.ts`, `types/index.ts` and `monitoringTelemetry.ts` plumbing; D1 repository typing only if needed for the optional extension. No discovery collector, accounting SQL, migration, config/secret, formatter or ranking/replay change.

Required offline acceptance: deterministic shuffled-observation/duplicate-alias/dual-provenance behavior;10 query/4 feed round-robin, borrowing, domain-cap relaxation, empty/single-source/poor-snippet inputs; unchanged full-pool fallback;24 cap; UTF-8/JSON escaping and12 KiB packing; application link/title integrity and excluded-ID rejection; exact low-thinking REST body; unchanged503/429/timeout/uncertainty gates; one final email; old/new snapshot round-trip/privacy/size and rollback-path compatibility; full existing suite/build/Worker typecheck/local Workerd evidence as applicable. No live provider tests.

Later implementation sequence, not an implementation plan: pure selection/prompt contracts → scheduled thinking config → bounded telemetry extension → offline regression/quality fixtures → independent Analyst review → explicit human release → natural window. No runtime code or new implementation-plan document is produced now.

## Governance and unresolved facts

Five authority documents were reconciled before design. Earlier release-pending claims remain only in clearly historical entries. New 13-item order: latency reliability; latency natural validation; RSS BODY_LIMIT; Threads; combined source proof; idempotent email; cross-source event dedupe; telemetry-degraded continuity; Workerd CI; legacy cleanup; centralize limits; P7/relevance+feedback; stabilization/V1.0.

Future event dedupe must group only confidently same events, preserve distinct and uncertain pairs; current URL/alias behavior stays. All future items are recorded, not implemented. Permanent Backlog/Plan Actualization Checkpoint applies after major merged/deployed/validated milestones.

No unresolved decision blocks recommended A. Performance remains a hypothesis and needs natural evidence; exact provider latency split is unknown. Background billing/recovery details remain unresolved for deferred B and are not implementation authority. Human review of this written recommendation is required before creating an implementation plan. No runtime/provider/D1/deployment action is authorized by ARCHITECTURE_READY.
