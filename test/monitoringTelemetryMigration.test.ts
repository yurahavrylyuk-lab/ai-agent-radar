import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function migration(name: string): Promise<string> {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

async function productionShape(): Promise<Database.Database> {
  const database = new Database(":memory:");
  database.exec(await migration("0001_initial.sql"));
  database.exec(await migration("0002_controlled_execution_lock.sql"));
  database.exec(await migration("0003_gemini_usage_model.sql"));
  database.exec(await migration("0005_gemini_ambiguity_accounting.sql"));
  database.exec(await migration("0006_gemini_timeout_admission.sql"));
  database.prepare("INSERT INTO gemini_usage (id,timestamp,provider,operation,request_count,input_tokens,output_tokens,total_tokens,model,accounting_status,ambiguity_reason,accounting_through,settled_at,retired_at) VALUES (22,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("2026-10-12T08:00:10.882Z", "gemini", "analysis", 1, 0, 0, 0, "gemini-3.8-flash", "transport_ambiguous", "abandoned_reservation", "2026-10-12T08:00:10.947Z", null, null);
  database.exec(await migration("0007_row22_exact_recovery.sql"));
  return database;
}

test("0008 creates only bounded cycle and attempt telemetry beside production-shape accounting", async () => {
  const database = await productionShape();
  try {
    database.exec(await migration("0008_monitoring_cycle_observability.sql"));
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'monitoring_%' ORDER BY name").all();
    assert.deepEqual(tables, [{ name: "monitoring_cycles" }, { name: "monitoring_gemini_attempts" }]);
    const row22 = database.prepare("SELECT accounting_status, settled_at FROM gemini_usage WHERE id=22").get();
    assert.deepEqual(row22, { accounting_status: "confirmed_zero", settled_at: "2026-10-12T08:00:10.947Z" });
    const index = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='monitoring_cycles_scheduled_at_idx'").get() as { sql: string };
    assert.match(index.sql, /scheduled_at,\s*cycle_id/i);
  } finally { database.close(); }
});

test("0008 rejects invalid cycle, duplicate usage, ordinal four, identity mutation, and inconsistent settlement", async () => {
  const database = await productionShape();
  try {
    database.exec(await migration("0008_monitoring_cycle_observability.sql"));
    const empty = JSON.stringify({ version: 1, braveHealth: null, rssHealth: null, outage: null,
      candidateCounts: { received: null, unique: null, submitted: null }, geminiDispatchCount: null, delivery: null,
      accounting: { reserved: 0, exact: 0, confirmedZero: 0, ambiguous: 0, unavailable: false } });
    database.prepare("INSERT INTO monitoring_cycles(cycle_id,scheduled_at,started_at,updated_at,phase,snapshot_json) VALUES(?,?,?,?,?,?)")
      .run("6d46738d-d269-4f9a-9f8f-1f615340fea8", "2026-10-22T08:00:00.000Z", "2026-10-22T08:00:00.100Z", "2026-10-22T08:00:00.100Z", "started", empty);
    database.prepare("INSERT INTO gemini_usage(timestamp,provider,operation,request_count,input_tokens,output_tokens,total_tokens,model,accounting_status,accounting_through) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("2026-10-22T08:00:01.000Z", "gemini", "analysis", 1, 0, 0, 0, "gemini-3.8-flash", "reserved", "2026-10-22T08:00:01.000Z");
    const usageId = Number(database.prepare("SELECT max(id) AS id FROM gemini_usage").get()?.id);
    const insert = database.prepare("INSERT INTO monitoring_gemini_attempts(cycle_id,ordinal,usage_id,model,started_at,updated_at,dispatch_status,failure_class,http_status,accounting_status,accounting_error,settlement_status,retry_decision,retry_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    assert.throws(() => insert.run("6d46738d-d269-4f9a-9f8f-1f615340fea8", 4, usageId, "gemini-3.8-flash", "2026-10-22T08:00:01.000Z", "2026-10-22T08:00:01.000Z", "not_dispatched", "none", null, "reserved", 0, "pending", "not_evaluated", "none"));
    insert.run("6d46738d-d269-4f9a-9f8f-1f615340fea8", 1, usageId, "gemini-3.8-flash", "2026-10-22T08:00:01.000Z", "2026-10-22T08:00:01.000Z", "not_dispatched", "none", null, "reserved", 0, "pending", "not_evaluated", "none");
    assert.throws(() => insert.run("6d46738d-d269-4f9a-9f8f-1f615340fea8", 2, usageId, "gemini-3.8-flash", "2026-10-22T08:00:01.000Z", "2026-10-22T08:00:01.000Z", "not_dispatched", "none", null, "reserved", 0, "pending", "not_evaluated", "none"));
    assert.throws(() => database.prepare("UPDATE monitoring_gemini_attempts SET model='gemini-3.6-flash' WHERE ordinal=1").run());
    assert.throws(() => database.prepare("UPDATE monitoring_gemini_attempts SET accounting_status='confirmed_zero', settlement_status='settled' WHERE ordinal=1").run());
    database.prepare("UPDATE monitoring_cycles SET phase='sources_complete' WHERE phase='started'").run();
    assert.throws(() => database.prepare("UPDATE monitoring_cycles SET phase='started' WHERE phase='sources_complete'").run());
  } finally { database.close(); }
});
