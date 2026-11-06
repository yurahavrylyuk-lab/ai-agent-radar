import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const approvedMigrations = [
  "0001_initial.sql",
  "0002_controlled_execution_lock.sql",
  "0003_gemini_usage_model.sql",
  "0005_gemini_ambiguity_accounting.sql",
  "0006_gemini_timeout_admission.sql",
  "0007_row22_exact_recovery.sql",
  "0008_monitoring_cycle_observability.sql",
  "0009_openai_fallback_usage.sql",
  "0010_email_delivery_ledger.sql",
] as const;

test("production D1 migration discovery is an explicit reviewed allowlist", () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as {
    d1_databases?: Array<Record<string, unknown>>;
  };
  assert.equal(config.d1_databases?.length, 1);
  const database = config.d1_databases![0];
  assert.deepEqual({
    binding: database.binding,
    database_name: database.database_name,
    database_id: database.database_id,
    migrations_dir: database.migrations_dir,
    migrations_table: database.migrations_table,
  }, {
    binding: "DB",
    database_name: "ai-agent-radar",
    database_id: "9fb545e2-2f43-4922-8b21-2d79a8de9556",
    migrations_dir: "migrations",
    migrations_table: undefined,
  });

  const expectedPattern = `migrations/{${approvedMigrations.map(name => name.slice(0, -4)).join(",")}}.sql`;
  assert.equal(database.migrations_pattern, expectedPattern);
  const repositoryMigrations = readdirSync(new URL("../migrations", import.meta.url)).filter(name => name.endsWith(".sql"));
  for (const name of approvedMigrations) assert.ok(repositoryMigrations.includes(name), `${name} must exist`);
  assert.equal(approvedMigrations.includes("0004_x_discovery.sql" as typeof approvedMigrations[number]), false);
  assert.equal(approvedMigrations.includes("0011_unapproved_future.sql" as typeof approvedMigrations[number]), false);
});
