# Architect Plan

## Self-improvement Proposal 1 — bounded durable notification replay

Architecture status: REVIEW. The human approved the 72-hour window, immutable activation cutoff `2026-10-06T16:00:00Z`, broader recent-unnotified semantics, and current-policy P4 replay. Builder implementation is ready for independent review; GOV-001 below remains completed historical evidence.

### Verified baseline and architecture-only scope

- On 2026-10-06, `git fetch origin` succeeded and freshly fetched `origin/main` was exactly `e4606faef42e6aff1ba66313c1c0f97d7fc31df2`, as required. No advanced main was found.
- During the architecture-only phase, the checkout was `codex/partial-brave-search-failures` at `7416cb551d08b2444f3aac952dfcbce752695bac`; inspected source, tests, migrations, `plan.md`, and PROJECT_STATE had no diff from that authoritative main. The later human-authorized Builder phase created the Proposal 1 branch recorded below.
- Read the operating contract, role guide, completed governance plan/review, project state, P0–P5 plan, monitoring/notification flows, D1/JSON history adapters, types, migrations, and relevant existing tests. The governance review is historical GOV-001 evidence, not a review of this proposal. Proposal 2 partial-search failure handling and Proposal 3 bounded scheduled summaries are present in the inspected source.
- During that architecture-only phase, only this plan changed. The later human approval authorized the bounded implementation and documentation changes recorded in the Builder handoff; it did not authorize a migration, production configuration/secret change, merge, deployment, or provider execution.

### Root cause and durable eligibility

`recordDiscovery()` stores a validated completed analysis before notification. `notifyDigest()` filters to `status === "new"`; subsequent discovery of the same URL returns `duplicate`. Monitor Phase 3 also runs only when current search processing produced items. Thus an analyzed discovery with no successful email record can be stranded permanently.

Use durable stored analysis plus absence of normalized-URL/email notification history, not rediscovery or a fabricated `new` status. A new delivery-candidate type separates delivery origin from discovery processing:

```ts
type DeliveryCandidate = {
  discovery: StoredDiscovery;
  origin: "fresh" | "replay";
};
```

Keep DiscoveryProcessingResult's existing new/duplicate meanings. An ordinary duplicate does not automatically become deliverable. Only a bounded durable replay lookup admits a prior discovery, and duplicate search results do not cause re-analysis.

### Product approval: window and activation cutoff

Preferred replay window: **72 hours** from immutable `firstSeenAt`, which the current adapters write only when a completed analysis is first inserted. Cron is daily at 08:00 UTC. This normally allows at least two subsequent daily opportunities despite modest timing drift, without retaining a week's backlog. A 48-hour alternative favors freshness but offers fewer recovery opportunities around scheduling delays.

Do not use `lastSeenAt`, which is refreshed on rediscovery; do not reset expiry after failed sends. Do not claim firstSeenAt is a separate analysis-completion column: it is the existing persistence timestamp used as that boundary. Future reanalysis is outside this design.

Capture a single cycle-start UTC instant T before searches. Define cutoff = max(T minus approved window, replayNotBefore). Query **cutoff <= firstSeenAt < T**. Lower bound is inclusive; upper bound is exclusive. Canonical UTC ISO strings are required, with adapter validation and injected clocks in offline tests. Invalid/future timestamps are not eligible and invalid persistence must not silently produce an empty-success result.

Require an explicit immutable UTC `replayNotBefore` approved with activation, stored in reviewed provider-neutral application policy, not recomputed at startup and not based on lastSeenAt. This excludes discoveries from before activation even if they otherwise fit the window. The trade-off is intentional: this first release does not recover historical pre-activation failures. Any backfill needs separate approval.

Approval must cover: 72h (or explicitly selected 48h), exact activation cutoff, normal and P4 replay, and delivery of recent unnotified items regardless of whether they were previously attempted or merely lost a digest slot. Existing data cannot distinguish these cases; do not claim "failed-send-only" selection.

Suggested human approval:

```text
PROPOSAL_1_REPLAY_POLICY
status: APPROVED
windowHours: 72
replayNotBefore: <explicit UTC ISO timestamp>
includeUnattemptedRecentUnnotified: true
allowCurrentPolicyP4Replay: true
acceptedAmbiguity: provider acceptance without persisted history may duplicate delivery
approvedBy: <human owner>
```

Placeholders are not activation values. Missing/invalid policy disables replay, not normal fresh delivery. Builder implementation waits for this product/governance approval; architecture readiness does not activate it.

### Persistence interface and bounded lookup

Prefer extending the existing discovery interface with a bounded recent query, followed by the existing provider-neutral notification lookup. Do not introduce a retry table, delivery-attempt table, or provider-specific state.

```ts
listRecentDiscoveries(options: {
  fromInclusive: string;
  beforeExclusive: string;
  limit: number;
}): Promise<{ discoveries: StoredDiscovery[]; truncated: boolean }>;
```

- Use a fixed replay scan limit of **100**, enforced by adapters (valid limit range 1..100), and no pagination/refill loop within a cycle. The application policy supplies a finite positive interval no larger than the approved window.
- Sort by firstSeenAt DESC, then normalizedUrl ASC using deterministic binary/lexical ordering. Return defensive copies of validated complete analyses.
- D1 uses bound parameters: `WHERE first_seen_at >= ?1 AND first_seen_at < ?2 ORDER BY first_seen_at DESC, normalized_url ASC LIMIT ?3`, with limit + 1 capped at 101 to detect truncation. Do not call the existing unbounded listDiscoveries() in production replay.
- For each returned normalized URL, use getNotificationRecord(url, "email") and exclude any existing record; each point query is keyed by the existing composite primary key. Recheck notification history for the final candidate pool immediately before selection/send. Total checks are bounded by the 100-row replay pool plus at most four fresh analyses; no bulk notification-history load is needed in D1.
- JSON implements the same timestamp filtering, ordering, limits, truncation, copying and validation using its existing whole-file persistence model. Return size is bounded; JSON file parsing itself is not constant-space or a bounded database scan. It remains a local adapter, not the Worker persistence backend. Do not claim a LIMIT bounds storage scan cost.
- A D1 NOT EXISTS join could exclude sent items before LIMIT, but it couples discovery lookup to notification storage. Defer it: at four analyses per daily cycle, 72h is normally about twelve records, comfortably below 100. If the cap is reached, report truncation; do not fetch unlimited history. Delivery guarantees are conditional on scan/slot bounds, not eventual delivery of every imported record.
- Existing discoveries and notifications columns/primary keys suffice. **No D1 schema migration required.** There is no first_seen_at index today, so D1 may scan/sort the table even with bounded output. An index is a separately measured optimization, not a prerequisite or hidden migration.

### Monitoring and notification integration

1. Capture T once. Load replay candidates from durable discovery state, apply time/activation bounds, and exclude successful email history. This requires no Brave result and no Gemini call. Persistence read failure aborts the cycle safely rather than bypassing history; missing production persistence is not treated as empty history.
2. Preserve existing search and analysis behavior: up to ten guarded Brave requests, up to four new analyses, P0 retry rules, P2 quota behavior, and current pre-analysis P3 ordering. Replay does not enter discoveryProcessor/analyzeSearchResult or consume an analysis slot.
3. At monitor Phase 3, merge fresh completed analyses and replay discoveries by normalizeDiscoveryUrl identity. Prefer the fresh-origin representation when both exist; otherwise repeated replay/duplicate occurrences count once. Do not relabel old discoveries as `new` or count them as new discoveries/results processed.
4. Invoke the one digest selection path even when there are no fresh processed items but replay candidates exist. Recovery works with successful empty Brave results, quota-stopped discovery, and partial-search failures that otherwise allow the cycle to reach notification. Preserve Proposal 2's all-search-failed/no-usable-results abort and fatal persistence aborts: these cycles do not deliver replay. This proposal does not turn failed cycles into notification-only runs or add full-cycle retries.
5. Recheck durable notification history and discard already-sent candidates. Candidate age/provenance is admitted by the monitoring delivery boundary; normal relevance is a separate pure score >= 7 check. Adapt the digest API explicitly for DeliveryCandidate; preserve the legacy single-story API's restrictions unless deliberately routed through the same validated boundary. Do not simply remove every status check from isNotificationEligible().
6. All eligible fresh and replay normal candidates share one pool, ranked by existing compareDiscoveryPriority() without changing stored relevance or P3 bonuses. Fresh candidates precede replay only as stable input order when the comparator ties; retain current fresh order and deterministic replay order. Take at most four. No replay slot reservation or extra email.
7. Any eligible normal replay candidate suppresses P4 fallback just like a fresh normal candidate. If the combined normal pool is empty, consider below-threshold fresh/replay candidates passing the CURRENT exact-host source-trust policy. Rank with the same comparator, take up to four, and preserve the `It could be relevant` label. Do not cache trust approval on the discovery; removal from the registry blocks later fallback replay. Do not pad a normal digest with fallback items.
8. Use the existing single-send/per-story recording path. One failed send ends that cycle's delivery attempt; no same-cycle retry, next-candidate send, or second digest. Candidates remain in durable discovery state for a later scheduled cycle within the window.

### Delivery guarantee and ambiguity

- Recovery does not depend on Brave rediscovering the URL. It depends on a later scheduled cycle reaching delivery while the discovery is in-window, inside the bounded scan, policy-eligible, and selected among four slots.
- A normalized URL + email record always excludes the story, for normal and fallback delivery. Successful replay writes the ordinary notification record. Do not create separate replay notification identity.
- Provider acceptance is not confirmed inbox delivery. A successful provider response followed by history-write failure can leave no durable record; replay can then duplicate an already accepted email. The existing schema cannot distinguish this from genuine failure or an unattempted story. Preserve and explicitly disclose the accepted send-before-record ambiguity, including partial per-story recording. Do not advertise exactly-once delivery, rollback accepted email, or retry immediately.
- Provider errors with ambiguous acceptance carry the same residual risk. Concurrent cycles may also race between history checking and sending; this task adds no new locks/idempotency system and does not claim to solve that pre-existing race.
- Permanently failing candidates age out by firstSeenAt. Higher-ranked items may repeatedly occupy slots and lower-ranked items may expire unsent; preserve P3 ordering rather than introducing retry fairness, attempt counters or backoff.

### Minimal observability

Extend MonitoringCycleResult and the existing bounded scheduled summary with aggregate counts for replay candidates considered, replay candidates policy-eligible, fresh stories sent, replay stories sent, and a boolean replayLookupTruncated. Define considered as the loaded in-window rows; expired/out-of-range rows are excluded in persistence and are not counted by extra scan queries. No claim of a known number of truncated rows.

Count delivery candidates once by normalized identity, not once per duplicate search result. Preserve existing search/analysis/outcome fields and their semantics; notification totals must include replay-only sends. Count a story as sent only when the existing success/recording path confirms it; on post-send persistence failure report the bounded failure and do not invent sent counts. Do not add URL/content, publisher names, credentials, or unbounded error arrays to scheduled logs. Preserve Proposal 3 redaction and caps. No new endpoint or monitoring service.

### Likely later Builder files

- `src/services/discoveryHistoryCore.ts`, `discoveryHistory.ts`, `d1DiscoveryHistory.ts`: bounded query contract/adapters.
- New `src/config/notificationReplay.ts`: approved window, activation cutoff, scan bound; no secret or Cloudflare variable.
- `src/services/monitor.ts`, `notificationEligibility.ts`, `notificationOrchestrator.ts`: explicit delivery candidates, shared pool, current P4 policy, single send.
- `src/types/index.ts`, `src/worker.ts`: delivery-origin types, replay counters and bounded scheduled summary. No route/Cron change.
- Tests: discoveryHistory, d1Adapters, notificationEligibility, notificationOrchestrator, monitor, workerConfiguration; new replay-policy tests if useful. Use local fixtures/mocks only.
- Existing notification-history interfaces/adapters should remain unchanged: normalized point lookup and successful record APIs already suffice. Update mocks if needed; do not change their semantics.
- After explicit human approval, update `AGENTS.md` to replace NEW-only notification eligibility with fresh-or-bounded-replay eligibility and make normal replay suppress P4; update `docs/self-improvement/PROJECT_STATE.md`, `plan.md` P1/P4 descriptions, `README.md`, and role-owned plan/summary/changelog/review records. No historical record rewriting. This architecture task changes only ARCHITECT_PLAN.md.

### Builder acceptance tests

1. Persist a completed score >= 7 analysis; fail mocked send; verify discovery remains and no success record is added. Advance to next scheduled day, return no matching Brave URL (including empty successful searches), deliver stored content, and assert no additional Gemini call for replay.
2. Successful replay creates the ordinary normalized-URL/email history record; later cycles and rediscovery never resend it.
3. Verify inclusive cutoff/exclusive T, 72h age, activation floor, invalid timestamps, and unchanged expiry after lastSeenAt touch. An old backlog cannot enter; a pre-activation story cannot replay. Freeze clocks in tests, not operational code.
4. Fresh and replay share four slots and P3 ranking; normalized URL variants cannot appear twice. Fresh-only behavior remains unchanged. A recent unattempted, previously displaced eligible story may replay as explicitly approved.
5. Normal replay suppresses all fallback; below-threshold replay needs current exact-host trust, retains original score and visible fallback label, and is excluded when trust is removed. Unknown normal sources at score >= 7 remain normally eligible.
6. Repeated failed sends produce at most one email attempt per cycle and expire; no second send to replacement candidates. Preserve the accepted provider-accepted/history-write-failed ambiguity in an explicit test without claiming exactly-once behavior.
7. Replay lookup and notification read failures abort safely. No silent fresh-send fallback after unreadable authoritative history. Missing required dependency fails clearly. More than 100 recent rows returns a bounded deterministic pool plus truncation, with no follow-up pagination.
8. D1 and JSON agree on canonical UTC boundary/order semantics and normalized identity. Verify query LIMIT and bounded point lookups. Existing tests/mocks must implement the new method rather than silently omitting replay capability.
9. P0, four-analysis cap, P2 Brave request/usage behavior, P3 ranking and P4 source integrity remain unchanged. Replay adds no Brave queries or Gemini calls. Preserve Proposal 2 all-search-failed rejection and partial-search behavior.
10. Replay-only cycles have accurate notification counts; logs remain capped and secret-free. Tests use mocked send/provider functions, never live monitoring/email calls. Run repository offline tests/build/type checks after inspecting scripts; no deployment or production migration.

### Decision and next-role boundary

The required product decisions were explicitly approved by the human owner. Builder implemented the bounded proposal from authoritative main `e4606faef42e6aff1ba66313c1c0f97d7fc31df2` on `codex/replay-unnotified-discoveries` and returns it for independent Analyst review. No P5, Gemini model fallback, Brave retries, full-cycle retries, provider replacement, quota change, production mutation, or deployment is included.

### Builder implementation handoff

- Added provider-neutral `DeliveryCandidate` origin, a canonical bounded recent-discovery query in JSON and D1, and reviewed replay policy constants: 72 hours, cutoff `2026-10-06T16:00:00.000Z`, maximum scan 100.
- The monitor captures one cycle-start instant, loads replay independently of Brave URL rediscovery, merges fresh and replay candidates by normalized URL, and invokes one existing digest path. Stored replay never invokes Gemini.
- Normal fresh/replay candidates share P3 ranking and four slots. A normal replay suppresses fallback; below-threshold replay rechecks the current exact-host P4 registry and retains the existing label.
- Successful ordinary notification history excludes later replay. Send failure writes no success record. The accepted provider-accepted/history-write-failed ambiguity remains unchanged.
- Worker composition explicitly supplies D1 discovery history for replay. Scheduled summaries add aggregate replay counts only and continue to exclude URLs, titles, content, email bodies, and secrets.
- No schema migration, retry table, provider call, quota change, Cloudflare change, deployment, P5 work, or production merge occurred. Validation evidence and final commit are recorded in the Builder-owned daily summary.

## Active Cycle

- Cycle ID: `GOV-001`
- Revision: `2`
- Status: `COMPLETE`
- Revision-2 baseline: `846392643d039f5304e118d7c87fb91c2a1aaed1`
- Original governance baseline: `3a6946fe07ea3838488c789cba4c69718b2ed328`

Valid plan statuses: EMPTY / READY / IN_PROGRESS / REVIEW / COMPLETE / BLOCKED.

`BLOCKED` means work is stopped because of an unresolved obstacle, rejection, or required human decision.

## Revision 1 History

- Builder commit: `71751da70ac15767fe1356dece3d719ee7f460a4`
- Commit message: `docs: define self-improvement handoff protocol`
- Branch: `self-improvement`
- Original baseline: `3a6946fe07ea3838488c789cba4c69718b2ed328`
- Analyst checkpoint: `846392643d039f5304e118d7c87fb91c2a1aaed1`
- Analyst result: `REVISE`
- Architect decision: `REVISE`

The completed revision-1 Builder and human handoff records that the push and validation succeeded; exactly the nine authorized governance documents changed; tests/build/typecheck were `not run — documentation-only scope`; and there were no production code/configuration, Cloudflare, Cron, provider-limit, deployment, provider-call, merge, or production-behavior changes. These execution facts are attributed to that handoff, not inferred from Git alone.

Revision-1 changed files:

- `AGENTS.md`
- `docs/self-improvement/PROJECT_STATE.md`
- `docs/self-improvement/ARCHITECT.md`
- `docs/self-improvement/BUILDER.md`
- `docs/self-improvement/ANALYST.md`
- `docs/self-improvement/ARCHITECT_PLAN.md`
- `docs/self-improvement/ANALYST_REVIEW.md`
- `docs/self-improvement/DAILY_SUMMARY.md`
- `docs/self-improvement/CHANGELOG.md`

The Analyst observed that `Без назви.md` was absent during review. The human owner later clarified that, after the revision-1 Builder handoff, they intentionally deleted it because it was empty and unrelated. Its absence is not a Builder failure, and there is no current or future preservation, checksum, or recreation requirement.

## Revision 2 Completed Correction

### Motivation

Resolve revision-1 governance evidence gaps without changing production behavior or broadening role authority.

### Current Problem

Revision 1 omitted `BLOCKED` from one valid-status declaration, retained completed-work placeholders, did not reconcile the later human deletion clarification, and did not distinguish historical revision-1 evidence from active revision-2 work.

### Proposed Correction

Correct the status declaration and durable handoff evidence in the five approved governance documents while leaving the Analyst checkpoint unchanged.

### Allowed Files

- `docs/self-improvement/ARCHITECT.md`
- `docs/self-improvement/ARCHITECT_PLAN.md`
- `docs/self-improvement/PROJECT_STATE.md`
- `docs/self-improvement/DAILY_SUMMARY.md`
- `docs/self-improvement/CHANGELOG.md`

### Out of Scope

`ANALYST_REVIEW.md`, all other files, production code/configuration, Cloudflare, Cron, provider limits, secrets, deployments, provider calls, merges, branches, history rewriting, and recreation of the deleted unrelated file.

### Risks

Conflating revisions could allow stale evidence to approve later work; incomplete states could make a blocked cycle appear actionable.

### Safety Constraints

Keep both historical commits separate, preserve role authority and production invariants, and make documentation-only changes on `self-improvement`.

### Required Validation

Inspect full and staged diffs; run `git diff --check` and `git diff --cached --check`; verify only the five allowed paths changed; verify `ANALYST_REVIEW.md` is byte-identical to the revision-2 baseline; check status declarations, revision separation, secrets, and production boundaries. Tests/build/typecheck: `not run — documentation-only scope`.

### Acceptance Criteria

All revision-2 requirements are recorded accurately, the reviewed Builder commit is accepted, no contradictory current statement remains, and no unauthorized file or operational action occurs.

### Builder Instructions

Implement only this correction at the stated baseline. Record the Architect transition REVIEW → READY and Builder transitions READY → IN_PROGRESS → REVIEW. Commit and push normally without rewriting either prior commit.

### Analyst Focus Areas

Verify the exact revision-2 commit and baseline, complete status list, revision separation, historical evidence attribution, deleted-file clarification, allowed paths, unchanged Analyst checkpoint, and absence of production effects.

### Human Approval

Explicitly approved for this bounded documentation-only revision-2 correction.

### Lifecycle and Decisions

- Architect-authorized revision-2 transition: REVIEW → READY.
- Builder transitions: READY → IN_PROGRESS → REVIEW.
- Historical Builder-side status: REVIEW.
- Revision-2 Builder commit: `ab23e28d6d7e8c3a2d55ded8f81a5ce53e4d7744`.
- Revision-2 Analyst checkpoint: `5137631f44f8888fd4690cad368592110bb396c1`.
- Revision-2 Analyst result: `PASS`.
- Final Architect decision: `ACCEPT`.
- Architect-authorized closure transition: REVIEW → COMPLETE.
- Final cycle status: COMPLETE.
- No further implementation, deployment, merge, or new cycle is authorized by this closure.

## Revision 2 Builder Handoff

- Changed files: the five allowed governance documents listed above.
- Validation: full/staged diff inspection, allowlist and Analyst-checkpoint verification, whitespace and secret checks passed; tests/build/typecheck: `not run — documentation-only scope`.
- Deviations: none.
- Blockers: none.
- Review target: `ab23e28d6d7e8c3a2d55ded8f81a5ce53e4d7744`; independently reviewed as PASS at `5137631f44f8888fd4690cad368592110bb396c1`.
