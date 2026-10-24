import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OPENAI_FALLBACK, parseOpenAIFallbackLimits } from "../src/config/openaiFallback.js";
import { D1OpenAIFallbackUsageStore } from "../src/services/d1OpenAIFallbackUsageStore.js";

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
}
class D1 { constructor(readonly db: Database.Database) {} prepare(sql: string) { return new Statement(this.db, sql); } }

const cycleId = "a233dc6e-e951-4c7e-8f24-6cc7a91979f8";
const limits = { dailyRequests: 1, weeklyRequests: 7, monthlyRequests: 31, dailyTokens: 24_576, weeklyTokens: 172_032, monthlyTokens: 761_856 };

async function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  for (const file of ["0001_initial.sql", "0002_controlled_execution_lock.sql", "0003_gemini_usage_model.sql", "0005_gemini_ambiguity_accounting.sql", "0006_gemini_timeout_admission.sql"])
    db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  db.prepare("INSERT INTO gemini_usage(id,timestamp,provider,operation,request_count,input_tokens,output_tokens,total_tokens,model,accounting_status,ambiguity_reason,accounting_through,settled_at,retired_at) VALUES(22,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("2026-10-12T08:00:10.882Z", "gemini", "analysis", 1, 0, 0, 0, "gemini-3.8-flash", "transport_ambiguous", "abandoned_reservation", "2026-10-12T08:00:10.947Z", null, null);
  for (const file of ["0007_row22_exact_recovery.sql", "0008_monitoring_cycle_observability.sql", "0009_openai_fallback_usage.sql"])
    db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const scheduledAt = new Date(Date.now() - 5_000).toISOString();
  db.prepare("INSERT INTO monitoring_cycles(cycle_id,scheduled_at,started_at,updated_at,phase,snapshot_json) VALUES(?,?,?,?,?,?)")
    .run(cycleId, scheduledAt, scheduledAt, scheduledAt, "gemini_complete", JSON.stringify({ version: 1 }));
  const insertUsage = db.prepare("INSERT INTO gemini_usage(timestamp,provider,operation,request_count,input_tokens,output_tokens,total_tokens,model,accounting_status,accounting_through,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const insertAttempt = db.prepare("INSERT INTO monitoring_gemini_attempts(cycle_id,ordinal,usage_id,model,started_at,updated_at,ended_at,dispatch_status,failure_class,http_status,accounting_status,accounting_error,settlement_status,retry_decision,retry_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    const at = new Date(Date.now() - (4 - ordinal) * 1_000).toISOString();
    const id = Number(insertUsage.run(at, "gemini", "analysis", 1, 0, 0, 0, "gemini-3.8-flash", "reserved", at, null).lastInsertRowid);
    insertAttempt.run(cycleId, ordinal, id, "gemini-3.8-flash", at, at, null, "observed", "none", null, "reserved", 0, "pending", "not_evaluated", "none");
    db.prepare("UPDATE gemini_usage SET accounting_status='confirmed_zero',settled_at=?,accounting_through=? WHERE id=?").run(at, at, id);
    db.prepare("UPDATE monitoring_gemini_attempts SET ended_at=?,failure_class='unavailable_503',http_status=503,accounting_status='confirmed_zero',settlement_status='settled',retry_decision=?,retry_reason=? WHERE cycle_id=? AND ordinal=?")
      .run(at, ordinal === 3 ? "stop" : "retry", ordinal === 3 ? "max_attempts" : "retryable_503", cycleId, ordinal);
  }
  return { db, store: new D1OpenAIFallbackUsageStore(new D1(db) as unknown as D1Database), scheduledAt };
}

test("OpenAI fallback configuration is fixed and only accepts six bounded positive limits", () => {
  assert.deepEqual(OPENAI_FALLBACK, { model: "gpt-6-luna", reasoning: "low", maxOutputTokens: 12_288, inputBudget: 12_288, outputBudget: 12_288, reservationTokens: 24_576, timeoutMs: 15_000, admissionMs: 30_000, responseBodyBytes: 131_072 });
  const env = { OPENAI_DAILY_REQUEST_LIMIT: "1", OPENAI_WEEKLY_REQUEST_LIMIT: "7", OPENAI_MONTHLY_REQUEST_LIMIT: "31", OPENAI_DAILY_TOKEN_LIMIT: "24576", OPENAI_WEEKLY_TOKEN_LIMIT: "172032", OPENAI_MONTHLY_TOKEN_LIMIT: "761856", OPENAI_MODEL: "attacker" };
  assert.deepEqual(parseOpenAIFallbackLimits(env), limits);
  assert.equal(parseOpenAIFallbackLimits({ ...env, OPENAI_DAILY_REQUEST_LIMIT: "0" }), null);
  assert.equal(parseOpenAIFallbackLimits({ ...env, OPENAI_DAILY_REQUEST_LIMIT: "2" }), null);
  assert.equal(parseOpenAIFallbackLimits({ ...env, OPENAI_MONTHLY_TOKEN_LIMIT: "9007199254740992" }), null);
  assert.equal(parseOpenAIFallbackLimits({ ...env, OPENAI_WEEKLY_REQUEST_LIMIT: undefined }), null);
});

test("reservation is atomic, durable before dispatch, and same cycle cannot reserve twice", async () => {
  const value = await fixture();
  try {
    const first = await value.store.reserve(cycleId, limits);
    assert.ok(first);
    const row = value.db.prepare("SELECT state,dispatch_status,request_count,reserved_total FROM openai_fallback_usage WHERE cycle_id=?").get(cycleId) as Record<string, unknown>;
    assert.deepEqual(row, { state: "reserved", dispatch_status: "not_dispatched", request_count: 1, reserved_total: 24_576 });
    assert.equal(await value.store.reserve(cycleId, limits), null);
    assert.equal((await value.store.read(cycleId))?.attemptId, first.attemptId);
  } finally { value.db.close(); }
});

test("intent/observed/exact settlement preserves identity and replaces the reservation", async () => {
  const value = await fixture();
  try {
    const ref = (await value.store.reserve(cycleId, limits))!;
    await value.store.markIntent(ref);
    await value.store.markObserved(ref);
    await value.store.settleExact(ref, { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, { outcome: "none", httpStatus: 200, endedAt: new Date().toISOString(), durationMs: 50 });
    const row = await value.store.read(cycleId);
    assert.deepEqual([row?.state, row?.dispatchStatus, row?.requestCount, row?.inputTokens, row?.outputTokens, row?.totalTokens], ["exact", "observed", 1, 10, 20, 30]);
    await value.store.settleExact(ref, { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, { outcome: "none", httpStatus: 200, endedAt: row!.settledAt!, durationMs: 50 });
    await assert.rejects(value.store.settleExact({ ...ref, attemptId: crypto.randomUUID() }, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, { outcome: "none", httpStatus: 200, endedAt: new Date().toISOString(), durationMs: 1 }));
  } finally { value.db.close(); }
});

test("unknown never fabricates zero usage and terminal evidence cannot mutate or delete", async () => {
  const value = await fixture();
  try {
    const ref = (await value.store.reserve(cycleId, limits))!;
    await value.store.markIntent(ref);
    await value.store.markUnknown(ref, { outcome: "timeout", httpStatus: null, endedAt: new Date().toISOString(), durationMs: 15_000 });
    const row = value.db.prepare("SELECT state,input_tokens,output_tokens,total_tokens FROM openai_fallback_usage WHERE cycle_id=?").get(cycleId) as Record<string, unknown>;
    assert.deepEqual(row, { state: "unknown", input_tokens: null, output_tokens: null, total_tokens: null });
    assert.throws(() => value.db.prepare("DELETE FROM openai_fallback_usage WHERE cycle_id=?").run(cycleId));
    assert.throws(() => value.db.prepare("UPDATE openai_fallback_usage SET state='exact',input_tokens=0,output_tokens=0,total_tokens=0 WHERE cycle_id=?").run(cycleId));
    assert.equal(await value.store.reserve("00000000-0000-4000-8000-000000000001", limits), null);
  } finally { value.db.close(); }
});

test("pre-dispatch cancellation is bounded and later migration 0004 remains independent", async () => {
  const value = await fixture();
  try {
    const ref = (await value.store.reserve(cycleId, limits))!;
    await value.store.cancelBeforeDispatch(ref);
    assert.equal((await value.store.read(cycleId))?.state, "cancelled_pre_dispatch");
    value.db.exec(await readFile(new URL("../migrations/0004_x_discovery.sql", import.meta.url), "utf8"));
    assert.ok(value.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='x_request_usage'").get());
  } finally { value.db.close(); }
});

test("admission fails closed without exact three-attempt Gemini proof", async () => {
  const value = await fixture();
  try {
    value.db.prepare("UPDATE monitoring_gemini_attempts SET retry_reason='non_retryable' WHERE cycle_id=? AND ordinal=3").run(cycleId);
    assert.equal(await value.store.reserve(cycleId, limits), null);
  } finally { value.db.close(); }
});
