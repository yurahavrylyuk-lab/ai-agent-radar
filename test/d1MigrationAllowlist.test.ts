import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(repositoryRoot, "node_modules", ".bin", "wrangler");

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
  "0011_email_feedback.sql",
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

type WranglerQueryResult = {
  results?: Array<Record<string, unknown>>;
  success?: boolean;
  error?: string;
};

test("real local Wrangler applies only the production-shaped approved migration sequence", { timeout: 60_000 }, () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "ai-radar-d1-release-safeguard-"));
  const migrationsDirectory = join(temporaryRoot, "migrations");
  const persistenceDirectory = join(temporaryRoot, "state");
  const configPath = join(temporaryRoot, "wrangler.jsonc");
  mkdirSync(migrationsDirectory);
  mkdirSync(persistenceDirectory);

  const runWrangler = (arguments_: string[]): { stdout: string; stderr: string } => {
    const result = spawnSync(wrangler, arguments_, {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_LOG_PATH: join(temporaryRoot, "wrangler.log"),
        WRANGLER_SEND_METRICS: "false",
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    assert.equal(result.signal, null, `Wrangler was terminated by ${result.signal ?? "an unknown signal"}`);
    assert.equal(result.status, 0, `Wrangler failed (${arguments_.join(" ")}):\n${result.stdout}\n${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
  };

  const writeConfig = (migrations: readonly string[]): void => {
    writeFileSync(configPath, JSON.stringify({
      $schema: join(repositoryRoot, "node_modules", "wrangler", "config-schema.json"),
      name: "ai-radar-d1-release-safeguard-test",
      compatibility_date: "2026-09-20",
      d1_databases: [{
        binding: "DB",
        database_name: "ai-agent-radar",
        database_id: "9fb545e2-2f43-4922-8b21-2d79a8de9556",
        migrations_dir: "migrations",
        migrations_pattern: `migrations/{${migrations.map(name => name.slice(0, -4)).join(",")}}.sql`,
      }],
    }, null, 2));
  };

  const migrationArguments = (operation: "apply" | "list"): string[] => [
    "d1", "migrations", operation, "ai-agent-radar", "--local", "--config", configPath,
    "--persist-to", persistenceDirectory,
  ];

  const query = (sql: string): Array<Record<string, unknown>> => {
    const { stdout } = runWrangler([
      "d1", "execute", "ai-agent-radar", "--local", "--config", configPath,
      "--persist-to", persistenceDirectory, "--command", sql, "--json",
    ]);
    const jsonStart = stdout.indexOf("[");
    const jsonEnd = stdout.lastIndexOf("]");
    assert.notEqual(jsonStart, -1, `Wrangler JSON output was missing: ${stdout}`);
    assert.notEqual(jsonEnd, -1, `Wrangler JSON output was incomplete: ${stdout}`);
    const response = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1)) as WranglerQueryResult[];
    for (const entry of response) assert.equal(entry.success, true, entry.error ?? "Wrangler query failed");
    return response.flatMap(entry => entry.results ?? []);
  };

  try {
    for (const name of readdirSync(join(repositoryRoot, "migrations")).filter(name => name.endsWith(".sql"))) {
      copyFileSync(join(repositoryRoot, "migrations", name), join(migrationsDirectory, name));
    }
    writeFileSync(join(migrationsDirectory, "0011_unapproved_future.sql"),
      "CREATE TABLE unapproved_future_migration_should_not_run (id INTEGER PRIMARY KEY);\n");

    const beforeRow22 = approvedMigrations.slice(0, 5);
    writeConfig(beforeRow22);
    runWrangler(migrationArguments("apply"));
    query(`INSERT INTO gemini_usage(
        id,timestamp,provider,operation,request_count,input_tokens,output_tokens,total_tokens,model,
        accounting_status,ambiguity_reason,accounting_through,settled_at,retired_at
      ) VALUES(
        22,'2026-10-12T08:00:10.882Z','gemini','analysis',1,0,0,0,'gemini-3.8-flash',
        'transport_ambiguous','abandoned_reservation','2026-10-12T08:00:10.947Z',NULL,NULL
      );
      INSERT INTO discoveries(normalized_url,first_seen_at,last_seen_at,analysis_json)
      VALUES('https://fixture.invalid/preserved','2026-10-12T07:00:00.000Z','2026-10-12T07:30:00.000Z','{"fixture":"preserve-me"}');`);

    writeConfig(approvedMigrations.slice(0, 8));
    runWrangler(migrationArguments("apply"));

    const predecessorLedger = query("SELECT id,name FROM d1_migrations ORDER BY id");
    assert.deepEqual(predecessorLedger, approvedMigrations.slice(0, 8).map((name, index) => ({ id: index + 1, name })));
    assert.deepEqual(query(`SELECT id,timestamp,provider,operation,request_count,input_tokens,output_tokens,total_tokens,
      model,accounting_status,ambiguity_reason,settled_at,retired_at,accounting_through FROM gemini_usage WHERE id=22`), [{
      id: 22,
      timestamp: "2026-10-12T08:00:10.882Z",
      provider: "gemini",
      operation: "analysis",
      request_count: 1,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      model: "gemini-3.8-flash",
      accounting_status: "confirmed_zero",
      ambiguity_reason: null,
      settled_at: "2026-10-12T08:00:10.947Z",
      retired_at: null,
      accounting_through: "2026-10-12T08:00:10.947Z",
    }]);
    const predecessorTables = query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => row.name);
    for (const name of ["discoveries", "gemini_usage", "monitoring_cycles", "monitoring_gemini_attempts", "openai_fallback_usage"]) {
      assert.ok(predecessorTables.includes(name), `expected predecessor table ${name}`);
    }
    assert.equal(predecessorTables.includes("email_deliveries"), false);
    assert.equal(predecessorTables.some(name => typeof name === "string" && name.startsWith("x_")), false);

    writeConfig(approvedMigrations);
    const pending = runWrangler(migrationArguments("list")).stdout;
    assert.match(pending, /0010_email_delivery_ledger\.sql/);
    assert.doesNotMatch(pending, /0004_x_discovery\.sql/);
    assert.doesNotMatch(pending, /0011_unapproved_future\.sql/);
    const application = runWrangler(migrationArguments("apply")).stdout;
    assert.match(application, /0010_email_delivery_ledger\.sql/);

    const finalLedger = query("SELECT id,name FROM d1_migrations ORDER BY id");
    assert.deepEqual(finalLedger, approvedMigrations.map((name, index) => ({ id: index + 1, name })));
    const deliveryObjects = query(`SELECT type,name FROM sqlite_master
      WHERE name='email_deliveries' OR name LIKE 'email_deliveries_%' ORDER BY type,name`);
    assert.deepEqual(deliveryObjects, [
      { type: "index", name: "email_deliveries_accepted_unreconciled_idx" },
      { type: "table", name: "email_deliveries" },
      { type: "trigger", name: "email_deliveries_immutable_payload" },
      { type: "trigger", name: "email_deliveries_protect_delete" },
      { type: "trigger", name: "email_deliveries_validate_transition" },
    ]);
    assert.deepEqual(query("SELECT normalized_url,first_seen_at,last_seen_at,analysis_json FROM discoveries WHERE normalized_url='https://fixture.invalid/preserved'"), [{
      normalized_url: "https://fixture.invalid/preserved",
      first_seen_at: "2026-10-12T07:00:00.000Z",
      last_seen_at: "2026-10-12T07:30:00.000Z",
      analysis_json: "{\"fixture\":\"preserve-me\"}",
    }]);
    const excludedObjects = query(`SELECT name FROM sqlite_master WHERE type='table' AND
      (name IN ('x_poll_state','x_inbox','x_request_usage') OR name='unapproved_future_migration_should_not_run')`);
    assert.deepEqual(excludedObjects, []);
    const repeat = runWrangler(migrationArguments("apply")).stdout;
    assert.match(repeat, /No migrations to apply/i);
    assert.deepEqual(query("SELECT id,name FROM d1_migrations ORDER BY id"), finalLedger);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
