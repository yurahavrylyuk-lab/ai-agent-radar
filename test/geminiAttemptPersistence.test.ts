import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { D1GeminiUsageStore } from "../src/services/d1GeminiUsageStore.js";
import { D1MonitoringTelemetry } from "../src/services/d1MonitoringTelemetry.js";
import { createGeminiBatchCycleContext, generateBatchWithGemini } from "../src/tools/llm/gemini.js";
import type { MonitoringTelemetry } from "../src/services/monitoringTelemetry.js";
import type { GeminiUsageReservation, GeminiUsageStore } from "../src/services/geminiUsageTracker.js";

class Statement {
  constructor(readonly db: Database.Database, readonly sql: string, readonly values: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  private compiled() {
    const bound: unknown[] = [];
    const sql = this.sql.replace(/\?(\d+)/g, (_match, ordinal: string) => { bound.push(this.values[Number(ordinal) - 1]); return "?"; });
    return { sql, bound };
  }
  async first<T>() { const value = this.compiled(); return (this.db.prepare(value.sql).get(...value.bound) as T | undefined) ?? null; }
  async all<T>() { const value = this.compiled(); return { success: true, results: this.db.prepare(value.sql).all(...value.bound) as T[], meta: {} as D1Meta }; }
  async run() { const value = this.compiled(); const result = this.db.prepare(value.sql).run(...value.bound); return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } as D1Meta }; }
  async batchResult() {
    if (/\bRETURNING\b/i.test(this.sql)) { const value = this.compiled(); const results = this.db.prepare(value.sql).all(...value.bound); return { success: true, results, meta: { changes: results.length } as D1Meta }; }
    return this.run();
  }
}
class D1 {
  constructor(readonly db: Database.Database) {}
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(items: Statement[]) {
    this.db.exec("BEGIN");
    try { const results = []; for (const item of items) results.push(await item.batchResult()); this.db.exec("COMMIT"); return results; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

const cycleId = "6d46738d-d269-4f9a-9f8f-1f615340fea8";
async function fixture() {
  const db = new Database(":memory:");
  for (const file of ["0001_initial.sql", "0003_gemini_usage_model.sql", "0005_gemini_ambiguity_accounting.sql", "0006_gemini_timeout_admission.sql", "0008_monitoring_cycle_observability.sql"])
    db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const d1 = new D1(db) as unknown as D1Database;
  const telemetry = new D1MonitoringTelemetry(d1);
  await telemetry.createCycle({ cycleId, scheduledAt: "2026-10-22T08:00:00.000Z", startedAt: "2026-10-22T08:00:00.100Z", sourceSha: null, workerVersion: null });
  const usage = new D1GeminiUsageStore(d1);
  const reservation = await usage.reserveRequest({ timestamp: "2026-10-22T08:00:01.000Z", provider: "gemini", operation: "analysis", requestCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash" }, {
    limits: { dailyRequests: 100, weeklyRequests: 100, monthlyRequests: 100, dailyTokens: 100_000, weeklyTokens: 100_000, monthlyTokens: 100_000 }, cycleRequestsRemaining: 3,
  });
  await telemetry.bindAttempt({ cycleId, ordinal: 1 }, reservation);
  await telemetry.markDispatchIntent({ cycleId, ordinal: 1 });
  await telemetry.markDispatchObserved({ cycleId, ordinal: 1 });
  const observedAt = new Date(new Date(reservation.record.timestamp).getTime() + 1_000).toISOString();
  return { db, d1, usage, telemetry, reservation, observedAt };
}

test("zero_settlement_and_class_are_atomic and replay is idempotent", async () => {
  const value = await fixture();
  try {
    const outcome = { kind: "confirmed_zero" as const, evidence: { failureClass: "unavailable_503" as const, httpStatus: 503, accountingError: false, observedAt: value.observedAt } };
    await value.usage.settleObservedAttempt({ cycleId, ordinal: 1 }, value.reservation, outcome);
    await value.usage.settleObservedAttempt({ cycleId, ordinal: 1 }, value.reservation, outcome);
    const record = (await value.usage.getUsageData()).records.at(-1);
    assert.equal(record?.accountingStatus, "confirmed_zero");
    assert.equal(record?.requestCount, 1);
    assert.deepEqual([record?.inputTokens, record?.outputTokens, record?.totalTokens], [0, 0, 0]);
    const attempt = (await new D1MonitoringTelemetry(value.d1).readCycle(cycleId))?.attempts[0];
    assert.deepEqual([attempt?.failureClass, attempt?.httpStatus, attempt?.accountingStatus, attempt?.settlementStatus], ["unavailable_503", 503, "confirmed_zero", "settled"]);
  } finally { value.db.close(); }
});

test("CAS failure and attempt-write failure rollback both sides", async (t) => {
  await t.test("wrong reservation identity", async () => {
    const value = await fixture();
    try {
      const wrong = { ...value.reservation, record: { ...value.reservation.record, timestamp: "2026-10-22T08:00:01.001Z" } };
      await assert.rejects(value.usage.settleObservedAttempt({ cycleId, ordinal: 1 }, wrong, { kind: "confirmed_zero", evidence: { failureClass: "unavailable_503", httpStatus: 503, accountingError: false, observedAt: value.observedAt } }), /safely|identity/i);
      assert.equal((await value.usage.getUsageData()).records.at(-1)?.accountingStatus, "reserved");
    } finally { value.db.close(); }
  });
  await t.test("attempt write abort", async () => {
    const value = await fixture();
    try {
      value.db.exec("CREATE TRIGGER fail_attempt_update BEFORE UPDATE ON monitoring_gemini_attempts BEGIN SELECT RAISE(ABORT,'injected'); END");
      await assert.rejects(value.usage.settleObservedAttempt({ cycleId, ordinal: 1 }, value.reservation, { kind: "exact", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, evidence: { failureClass: "none", httpStatus: 200, accountingError: false, observedAt: value.observedAt } }));
      assert.equal((await value.usage.getUsageData()).records.at(-1)?.accountingStatus, "reserved");
    } finally { value.db.close(); }
  });
});

test("ambiguity remains unknown and conflicting replay rejects", async () => {
  const value = await fixture();
  try {
    await value.usage.settleObservedAttempt({ cycleId, ordinal: 1 }, value.reservation, { kind: "transport_ambiguous", reason: "network_error", evidence: { failureClass: "transport_error", httpStatus: null, accountingError: false, observedAt: value.observedAt } });
    assert.equal((await value.usage.getUsageData()).records.at(-1)?.accountingStatus, "transport_ambiguous");
    await assert.rejects(value.usage.settleObservedAttempt({ cycleId, ordinal: 1 }, value.reservation, { kind: "confirmed_zero", evidence: { failureClass: "unavailable_503", httpStatus: 503, accountingError: false, observedAt: value.observedAt } }));
  } finally { value.db.close(); }
});

test("successful usage may be refined only from none to response_invalid after Batch validation", async () => {
  const value = await fixture();
  try {
    const ref = { cycleId, ordinal: 1 as const };
    await value.usage.settleObservedAttempt(ref, value.reservation, { kind: "exact", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      evidence: { failureClass: "none", httpStatus: 200, accountingError: false, observedAt: value.observedAt } });
    await value.telemetry.recordEvidence(ref, { failureClass: "response_invalid", httpStatus: 200, accountingError: false, observedAt: value.observedAt });
    assert.equal((await value.telemetry.readCycle(cycleId))?.attempts[0]?.failureClass, "response_invalid");
    await assert.rejects(value.telemetry.recordEvidence(ref, { failureClass: "unavailable_503", httpStatus: 503, accountingError: false, observedAt: value.observedAt }), /terminal evidence/i);
    assert.equal((await value.usage.getUsageData()).records.at(-1)?.accountingStatus, "exact");
  } finally { value.db.close(); }
});

class MemoryUsage implements GeminiUsageStore {
  reservation: GeminiUsageReservation = { id: "memory:1", record: { id: 1, timestamp: "2026-10-22T08:00:01.000Z", provider: "gemini", operation: "analysis", requestCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash", accountingStatus: "reserved", accountingThrough: "2026-10-22T08:00:01.000Z" } };
  status: "none" | "reserved" | "exact" | "confirmed_zero" | "transport_ambiguous" = "none";
  async getUsageData() { return { records: this.status === "none" ? [] : [{ ...this.reservation.record, accountingStatus: this.status }], usageUnknown: false }; }
  async recordRequest() {} async markUsageUnknown() {}
  async reserveRequest() { this.status = "reserved"; return this.reservation; }
  async settleRequest() { this.status = "exact"; }
  async confirmZeroRequest() { this.status = "confirmed_zero"; }
  async markRequestAmbiguous() { this.status = "transport_ambiguous"; }
  async reconcileAbandonedReservation() { return "reconciled" as const; }
  async retireAmbiguousRequest() { return "retired" as const; }
}

test("attempt bind failure confirms zero and never dispatches", async () => {
  const usage = new MemoryUsage(); let fetches = 0;
  const repository = { bindAttempt: async () => { throw new Error("bind failed"); } } as unknown as MonitoringTelemetry;
  await assert.rejects(generateBatchWithGemini("batch", {
    usageTracker: usage,
    environment: { GEMINI_API_KEY: "test", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50", GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000" },
    cycleContext: createGeminiBatchCycleContext(), attemptTelemetry: { repository, cycleId, settle: async () => {} },
    fetchImplementation: (async () => { fetches++; return new Response(); }) as typeof fetch,
  }), /telemetry|bind/i);
  assert.equal(fetches, 0);
  assert.equal(usage.status, "confirmed_zero");
});

test("post_bind_pre_dispatch_zero_settles_attempt_atomically", async () => {
  const db = new Database(":memory:");
  try {
    for (const file of ["0001_initial.sql", "0003_gemini_usage_model.sql", "0005_gemini_ambiguity_accounting.sql", "0006_gemini_timeout_admission.sql", "0008_monitoring_cycle_observability.sql"])
      db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    const d1 = new D1(db) as unknown as D1Database;
    const telemetry = new D1MonitoringTelemetry(d1);
    await telemetry.createCycle({ cycleId, scheduledAt: "2026-10-22T08:00:00.000Z", startedAt: "2026-10-22T08:00:00.100Z", sourceSha: null, workerVersion: null });
    const usage = new D1GeminiUsageStore(d1);
    const moments = [
      new Date("2026-10-22T23:59:59.000Z"),
      new Date("2026-10-22T23:59:59.000Z"),
      new Date("2026-10-23T00:00:00.000Z"),
      new Date("2026-10-23T00:00:00.000Z"),
    ];
    let moment = 0;
    let fetches = 0;

    await assert.rejects(generateBatchWithGemini("batch", {
      usageTracker: usage,
      environment: { GEMINI_API_KEY: "test", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50", GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000" },
      cycleContext: createGeminiBatchCycleContext(),
      now: () => moments[Math.min(moment++, moments.length - 1)]!,
      attemptTelemetry: { repository: telemetry, cycleId, settle: usage.settleObservedAttempt.bind(usage) },
      fetchImplementation: (async () => { fetches += 1; return new Response(); }) as typeof fetch,
    }), /accounting window changed/);

    assert.equal(fetches, 0);
    const usageRecord = (await usage.getUsageData()).records.at(-1);
    const attempt = (await new D1MonitoringTelemetry(d1).readCycle(cycleId))?.attempts.at(-1);
    assert.equal(usageRecord?.accountingStatus, "confirmed_zero");
    assert.deepEqual(
      [attempt?.dispatchStatus, attempt?.failureClass, attempt?.accountingStatus, attempt?.settlementStatus],
      ["not_dispatched", "none", "confirmed_zero", "settled"],
    );
    assert.equal(db.prepare("SELECT count(*) AS count FROM monitoring_gemini_attempts WHERE settlement_status='pending' OR accounting_status='reserved'").get().count, 0);
  } finally { db.close(); }
});
