import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function migration(name: string): Promise<string> {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

async function productionShape(includeX = false): Promise<Database.Database> {
  const database = new Database(":memory:");
  for (const name of ["0001_initial.sql", "0002_controlled_execution_lock.sql", "0003_gemini_usage_model.sql",
    "0005_gemini_ambiguity_accounting.sql", "0006_gemini_timeout_admission.sql"]) {
    database.exec(await migration(name));
  }
  database.prepare("INSERT INTO gemini_usage (id,timestamp,provider,operation,request_count,input_tokens,output_tokens,total_tokens,model,accounting_status,ambiguity_reason,accounting_through,settled_at,retired_at) VALUES (22,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("2026-10-12T08:00:10.882Z", "gemini", "analysis", 1, 0, 0, 0, "gemini-3.8-flash", "transport_ambiguous", "abandoned_reservation", "2026-10-12T08:00:10.947Z", null, null);
  for (const name of ["0007_row22_exact_recovery.sql", "0008_monitoring_cycle_observability.sql", "0009_openai_fallback_usage.sql"]) {
    database.exec(await migration(name));
  }
  if (includeX) database.exec(await migration("0004_x_discovery.sql"));
  return database;
}

function schema(database: Database.Database): Array<{ type: string; name: string; sql: string | null }> {
  return database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{ type: string; name: string; sql: string | null }>;
}

const prepared = {
  delivery_key: "daily-digest/2026-11-04", logical_date: "2026-11-04", state: "prepared", payload_version: 1,
  content_json: JSON.stringify({ from: "AI Radar <radar@example.test>", subject: "Daily", text: "Text", html: "<p>Text</p>" }),
  payload_sha256: "a".repeat(64), mode: "normal", reason: "selected", aliases_json: JSON.stringify(["https://example.test/story"]),
  created_at: "2026-11-04T08:00:00.000Z", updated_at: "2026-11-04T08:00:00.000Z", dispatch_evidence_json: "[]", last_reason: "prepared",
};

function insertPrepared(database: Database.Database): void {
  database.prepare(`INSERT INTO email_deliveries(
    delivery_key,logical_date,state,payload_version,content_json,payload_sha256,mode,reason,aliases_json,
    created_at,updated_at,dispatch_evidence_json,last_reason
  ) VALUES(@delivery_key,@logical_date,@state,@payload_version,@content_json,@payload_sha256,@mode,@reason,@aliases_json,
    @created_at,@updated_at,@dispatch_evidence_json,@last_reason)`).run(prepared);
}

test("0010 adds only the bounded email delivery ledger to production shape", async () => {
  const database = await productionShape();
  try {
    const before = schema(database);
    const row22Before = database.prepare("SELECT * FROM gemini_usage WHERE id=22").get();
    database.exec(await migration("0010_email_delivery_ledger.sql"));
    const added = schema(database).filter(entry => !before.some(old => old.type === entry.type && old.name === entry.name));
    assert.deepEqual(added.map(({ type, name }) => ({ type, name })), [
      { type: "index", name: "email_deliveries_accepted_unreconciled_idx" },
      { type: "table", name: "email_deliveries" },
      { type: "trigger", name: "email_deliveries_immutable_payload" },
      { type: "trigger", name: "email_deliveries_protect_delete" },
      { type: "trigger", name: "email_deliveries_validate_transition" },
    ]);
    assert.deepEqual(database.prepare("SELECT * FROM gemini_usage WHERE id=22").get(), row22Before);
  } finally { database.close(); }
});

test("0010 enforces daily identity, bounds, immutability, and terminal acceptance", async () => {
  const database = await productionShape();
  try {
    database.exec(await migration("0010_email_delivery_ledger.sql"));
    insertPrepared(database);
    assert.throws(() => insertPrepared(database));
    assert.throws(() => database.prepare("UPDATE email_deliveries SET content_json=? WHERE delivery_key=?")
      .run(JSON.stringify({ changed: true }), prepared.delivery_key));
    assert.throws(() => database.prepare("UPDATE email_deliveries SET dispatch_evidence_json=? WHERE delivery_key=?")
      .run(JSON.stringify([1, 2, 3, 4]), prepared.delivery_key));
    assert.throws(() => database.prepare("DELETE FROM email_deliveries WHERE delivery_key=?").run(prepared.delivery_key));
    database.prepare(`UPDATE email_deliveries SET state='attempting',claim_token='token',claim_generation=1,
      lease_until='2026-11-04T08:02:00.000Z',updated_at='2026-11-04T08:00:01.000Z',last_reason='claimed' WHERE delivery_key=?`).run(prepared.delivery_key);
    database.prepare(`UPDATE email_deliveries SET state='accepted',provider_message_id='email_1',accepted_at='2026-11-04T08:00:02.000Z',
      updated_at='2026-11-04T08:00:02.000Z',last_reason='provider_accepted' WHERE delivery_key=?`).run(prepared.delivery_key);
    assert.throws(() => database.prepare("UPDATE email_deliveries SET state='ambiguous' WHERE delivery_key=?").run(prepared.delivery_key));
  } finally { database.close(); }
});

test("0010 remains independent when 0004 is applied only to a disposable database", async () => {
  const database = await productionShape(true);
  try {
    const sql = await migration("0010_email_delivery_ledger.sql");
    assert.doesNotThrow(() => database.exec(sql));
    assert.equal(database.prepare("SELECT count(*) AS count FROM email_deliveries").get()?.count, 0);
  } finally { database.close(); }
});
