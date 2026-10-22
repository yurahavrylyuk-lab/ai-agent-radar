import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { D1MonitoringTelemetry } from "../src/services/d1MonitoringTelemetry.js";
import { serializeCycleSnapshot, validateCycleSnapshot, validateCycleStart } from "../src/services/monitoringTelemetry.js";

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
    assert.deepEqual(recovered?.attempts.map(item => [item.ordinal, item.dispatchStatus, item.failureClass]), [[1, "intent", "none"]]);
    assert.equal((database.prepare("SELECT count(*) AS count FROM monitoring_cycles").get() as { count: number }).count, 2);
    const finalSnapshot = { ...snapshot, delivery: { deliveryMode: "status_only" as const, deliveryReason: "no_eligible_stories" as const,
      analyzedStories: 0, rawStories: 0, replayStories: 0, emailAttempts: 1 as const, emailOutcome: "accepted" as const,
      historyOutcome: "not_required" as const, finalizationReached: true } };
    await repository.completeCycle(start.cycleId, finalSnapshot);
    assert.equal((await repository.readCycle(start.cycleId))?.phase, "completed");
  } finally { database.close(); }
});
