import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { D1MonitoringTelemetry } from "../src/services/d1MonitoringTelemetry.js";
import { parseCycleSnapshot, serializeCycleSnapshot, validateCycleSnapshot, validateCycleStart, validateThreadsCycleMetrics } from "../src/services/monitoringTelemetry.js";

const encoder = new TextEncoder();

const start = {
  cycleId: "6d46738d-d269-4f9a-9f8f-1f615340fea8",
  scheduledAt: "2026-10-22T08:00:00.000Z",
  startedAt: "2026-10-22T08:00:00.125Z",
  sourceSha: null,
  workerVersion: null,
};

const snapshot = {
  version: 1 as const,
  braveHealth: "healthy" as const,
  rssHealth: "degraded" as const,
  outage: false,
  candidateCounts: { received: 60, unique: 41, submitted: 41 },
  geminiDispatchCount: 1,
  delivery: null,
  accounting: { reserved: 1, exact: 1, confirmedZero: 0, ambiguous: 0, unavailable: false },
};

const latency = {
  version: 1 as const,
  preFilterInputCount: 47,
  selectedCount: 24,
  selectorExcluded: 23,
  byteExcluded: 1,
  submittedCount: 23,
  promptBytes: 11_234,
  snippetBytesLimit: 128 as const,
  thinkingMode: "low" as const,
  executionMode: "synchronous" as const,
  attemptTimings: [
    { ordinal: 1 as const, requestStartedAt: "2026-10-22T08:00:02.125Z", elapsedMs: 75_331 },
    { ordinal: 2 as const, requestStartedAt: null, elapsedMs: null },
  ],
};

const analyzerFailover = {
  version: 1 as const, provider: "openai" as const, model: "gpt-6-luna" as const,
  eligible: true, eligibilityReason: "eligible" as const, attempted: true, dispatchCount: 1 as const,
  startedAt: "2026-10-22T08:01:02.000Z", endedAt: "2026-10-22T08:01:03.000Z", durationMs: 1000,
  outcome: "success" as const, httpStatus: 200, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  accountingState: "exact" as const, finalAnalyzer: "openai" as const,
};

const threads = {
  enabled: true, configured: true, publicApprovalAttested: true,
  health: "degraded" as const, reason: "timeout" as const, authentication: "accepted" as const, rotationDue: false,
  attemptedQueries: 3, succeededQueries: 2, failedQueries: 1, skippedQueries: 0,
  observedPositions: 6, validObservations: 5, rejectedPositions: 1,
  outcomes: [
    { queryId: "ai_agents" as const, reason: "ok" as const, httpStatus: 200, elapsedMs: 10, observedPositions: 3, itemTruncated: false, pagingIgnored: true, bodyTruncated: false },
    { queryId: "claude_code" as const, reason: "timeout" as const, httpStatus: null, elapsedMs: 3000, observedPositions: 0, itemTruncated: false, pagingIgnored: false, bodyTruncated: false },
  ],
  pipeline: { duplicates: 1, retainedOwned: 3, retainedAttributed: 4, submitted: 2, selected: 1, delivered: 1 },
};

test("cycle start accepts trusted null release metadata and rejects malformed identity", () => {
  assert.deepEqual(validateCycleStart(start), start);
  assert.throws(() => validateCycleStart({ ...start, cycleId: "not-uuid" }), /cycle start/i);
  assert.throws(() => validateCycleStart({ ...start, sourceSha: "local-head" }), /cycle start/i);
  assert.throws(() => validateCycleStart({ ...start, workerVersion: "not-uuid" }), /cycle start/i);
  assert.throws(() => validateCycleStart({ ...start, extra: true }), /cycle start/i);
});

test("cycle snapshot is exact, bounded, and free of arbitrary provider text", () => {
  assert.deepEqual(validateCycleSnapshot(snapshot), snapshot);
  assert.equal(serializeCycleSnapshot(snapshot), JSON.stringify(snapshot));
  assert.throws(() => validateCycleSnapshot({ ...snapshot, candidateCounts: { ...snapshot.candidateCounts, submitted: 51 } }), /snapshot/i);
  assert.throws(() => validateCycleSnapshot({ ...snapshot, geminiDispatchCount: 4 }), /snapshot/i);
  assert.throws(() => validateCycleSnapshot({ ...snapshot, providerMessage: "UNIQUE_PRIVATE_PROVIDER_TEXT" }), /snapshot/i);
  assert.throws(() => serializeCycleSnapshot({ ...snapshot, delivery: { arbitrary: "x".repeat(9000) } } as never), /snapshot/i);
});

test("reads legacy and bounded latency snapshots without rewriting legacy shape", () => {
  const legacyJson = JSON.stringify(snapshot);
  assert.deepEqual(parseCycleSnapshot(legacyJson), snapshot);
  assert.equal(serializeCycleSnapshot(parseCycleSnapshot(legacyJson)), legacyJson);
  assert.equal(parseCycleSnapshot(legacyJson).latency, undefined);

  const extended = { ...snapshot, latency };
  const serialized = serializeCycleSnapshot(extended);
  assert.ok(encoder.encode(serialized).byteLength <= 8192);
  assert.deepEqual(parseCycleSnapshot(serialized), extended);
});

test("optional Threads telemetry is exact, bounded, and legacy-compatible", () => {
  assert.deepEqual(validateThreadsCycleMetrics(threads), threads);
  const extended = { ...snapshot, threads };
  assert.deepEqual(parseCycleSnapshot(serializeCycleSnapshot(extended)), extended);
  assert.equal(parseCycleSnapshot(JSON.stringify(snapshot)).threads, undefined);
  for (const malformed of [
    { ...threads, token: "private" },
    { ...threads, outcomes: [...threads.outcomes, { ...threads.outcomes[0] }, { ...threads.outcomes[0] }] },
    { ...threads, outcomes: [threads.outcomes[0], { ...threads.outcomes[0] }] },
    { ...threads, observedPositions: 16 },
    { ...threads, pipeline: { ...threads.pipeline, submitted: 25 } },
    { ...threads, outcomes: [{ ...threads.outcomes[0], postId: "123" }] },
  ]) assert.throws(() => validateThreadsCycleMetrics(malformed), /Threads/i);
});

test("rejects unknown, inconsistent, unbounded, or sensitive latency fields", () => {
  const extended = { ...snapshot, latency };
  for (const badLatency of [
    { ...latency, prompt: "private prompt" },
    { ...latency, body: "provider body" },
    { ...latency, message: "provider message" },
    { ...latency, headers: { authorization: "secret" } },
    { ...latency, arbitrary: true },
    { ...latency, preFilterInputCount: 51 },
    { ...latency, selectedCount: 25 },
    { ...latency, submittedCount: 25 },
    { ...latency, promptBytes: 12_289 },
    { ...latency, snippetBytesLimit: 64 },
    { ...latency, thinkingMode: "high" },
    { ...latency, executionMode: "background" },
    { ...latency, selectorExcluded: 22 },
    { ...latency, byteExcluded: 0 },
    { ...latency, attemptTimings: [...latency.attemptTimings, { ordinal: 3, requestStartedAt: null, elapsedMs: null }, { ordinal: 3, requestStartedAt: null, elapsedMs: null }] },
    { ...latency, attemptTimings: [{ ordinal: 2, requestStartedAt: null, elapsedMs: 180_001 }] },
    { ...latency, attemptTimings: [{ ordinal: 2, requestStartedAt: "not-iso", elapsedMs: 1 }] },
    { ...latency, attemptTimings: [{ ordinal: 2, requestStartedAt: "2026-99-23T08:00:02.125Z", elapsedMs: 1 }] },
  ]) assert.throws(() => validateCycleSnapshot({ ...extended, latency: badLatency }), /snapshot/i);
});

test("bounded analyzer failover snapshot round-trips and rejects arbitrary provider content", () => {
  const extended={...snapshot,analyzerFailover};
  const serialized=serializeCycleSnapshot(extended);
  assert.ok(encoder.encode(JSON.stringify(analyzerFailover)).byteLength<=1024);
  assert.deepEqual(parseCycleSnapshot(serialized),extended);
  for(const bad of [
    {...analyzerFailover,model:"attacker"}, {...analyzerFailover,outcome:"private provider body"},
    {...analyzerFailover,prompt:"secret"}, {...analyzerFailover,usage:{inputTokens:1,outputTokens:2,totalTokens:4}},
    {...analyzerFailover,dispatchCount:2}, {...analyzerFailover,startedAt:"not-utc"},
  ]) assert.throws(()=>validateCycleSnapshot({...snapshot,analyzerFailover:bad}),/snapshot/i);
});

test("delivery snapshot allowlists only bounded finalizer evidence", () => {
  const delivery = {
    deliveryMode: "degraded" as const,
    deliveryReason: "ai_unavailable" as const,
    analyzedStories: 0,
    rawStories: 4,
    replayStories: 0,
    emailAttempts: 1 as const,
    emailOutcome: "accepted" as const,
    historyOutcome: "recorded" as const,
    finalizationReached: true,
  };
  assert.deepEqual(validateCycleSnapshot({ ...snapshot, delivery }).delivery, delivery);
  assert.throws(() => validateCycleSnapshot({ ...snapshot, delivery: { ...delivery, rawStories: 5 } }), /snapshot/i);
  assert.throws(() => validateCycleSnapshot({ ...snapshot, delivery: { ...delivery, message: "provider prose" } }), /snapshot/i);
});

class Statement {
  constructor(private readonly db: Database.Database, private readonly sql: string, private readonly values: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  private compiled() { const bound: unknown[] = []; const sql = this.sql.replace(/\?(\d+)/g, (_match, raw: string) => { bound.push(this.values[Number(raw) - 1]); return "?"; }); return { sql, bound }; }
  async first<T>() { const value=this.compiled(); return (this.db.prepare(value.sql).get(...value.bound) as T | undefined) ?? null; }
  async all<T>() { const value=this.compiled(); return { success: true, results: this.db.prepare(value.sql).all(...value.bound) as T[], meta: {} as D1Meta }; }
  async run() { const value=this.compiled(); const result = this.db.prepare(value.sql).run(...value.bound); return { success: true, results: [], meta: { changes: result.changes } as D1Meta }; }
}
class D1 { constructor(private readonly db: Database.Database) {} prepare(sql: string) { return new Statement(this.db, sql); } }

test("D1 telemetry preserves two same-day invocations and recovers ordered attempt evidence from a fresh instance", async () => {
  const database = new Database(":memory:");
  try {
    for (const file of ["0001_initial.sql", "0003_gemini_usage_model.sql", "0005_gemini_ambiguity_accounting.sql", "0006_gemini_timeout_admission.sql", "0008_monitoring_cycle_observability.sql"])
      database.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    const d1 = new D1(database) as unknown as D1Database;
    const now = new Date("2026-10-22T08:00:02.000Z");
    const repository = new D1MonitoringTelemetry(d1, () => now);
    await repository.createCycle(start);
    const second = { ...start, cycleId: "855a313a-2168-4a8f-8f8e-621f91d47f9c", startedAt: "2026-10-22T08:00:00.250Z" };
    await repository.createCycle(second);
    await repository.checkpoint(start.cycleId, "sources_complete", snapshot);
    await assert.rejects(repository.completeCycle(start.cycleId, snapshot), /before delivery finalization/i);
    database.prepare("INSERT INTO gemini_usage(timestamp,provider,operation,request_count,input_tokens,output_tokens,total_tokens,model,accounting_status,accounting_through) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("2026-10-22T08:00:01.000Z", "gemini", "analysis", 1, 0, 0, 0, "gemini-3.8-flash", "reserved", "2026-10-22T08:00:01.000Z");
    const id = (database.prepare("SELECT max(id) AS id FROM gemini_usage").get() as { id: number }).id;
    await repository.bindAttempt({ cycleId: start.cycleId, ordinal: 1 }, { id: `d1:${id}`, record: { id, timestamp: "2026-10-22T08:00:01.000Z", provider: "gemini", operation: "analysis", requestCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash", accountingStatus: "reserved", accountingThrough: "2026-10-22T08:00:01.000Z" } });
    await repository.markDispatchIntent({ cycleId: start.cycleId, ordinal: 1 });
    await repository.recordEvidence({ cycleId: start.cycleId, ordinal: 1 }, { failureClass: "none", httpStatus: null, accountingError: false, observedAt: now.toISOString() });
    const recovered = await new D1MonitoringTelemetry(d1).readCycle(start.cycleId);
    assert.equal(recovered?.phase, "sources_complete");
    assert.deepEqual(recovered?.snapshot, snapshot);
    assert.deepEqual(recovered?.snapshot && {
      brave: recovered.snapshot.braveHealth,
      rss: recovered.snapshot.rssHealth,
      outage: recovered.snapshot.outage,
    }, { brave: "healthy", rss: "degraded", outage: false }, "source health survives without console evidence");
    assert.deepEqual(recovered?.attempts.map(item => [item.ordinal, item.dispatchStatus, item.failureClass]), [[1, "intent", "none"]]);
    assert.equal((database.prepare("SELECT count(*) AS count FROM monitoring_cycles").get() as { count: number }).count, 2);
    const finalSnapshot = { ...snapshot, delivery: { deliveryMode: "status_only" as const, deliveryReason: "no_eligible_stories" as const,
      analyzedStories: 0, rawStories: 0, replayStories: 0, emailAttempts: 1 as const, emailOutcome: "accepted" as const,
      historyOutcome: "not_required" as const, finalizationReached: true } };
    await repository.completeCycle(start.cycleId, finalSnapshot);
    assert.equal((await repository.readCycle(start.cycleId))?.phase, "completed");
  } finally { database.close(); }
});
