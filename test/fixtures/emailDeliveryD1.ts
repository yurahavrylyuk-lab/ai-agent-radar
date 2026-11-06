import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";

export type D1Fault = { pattern: RegExp; phase: "before" | "after" | "read"; remaining?: number };

class Statement {
  constructor(private readonly owner: SqliteD1, private readonly sql: string, private readonly values: unknown[] = []) {}
  bind(...values: unknown[]): Statement { return new Statement(this.owner, this.sql, values); }
  private compiled(): { query: string; values: unknown[] } {
    const values: unknown[] = [];
    const query = this.sql.replace(/\?(\d+)/g, (_match, ordinal: string) => {
      values.push(this.values[Number(ordinal) - 1]);
      return "?";
    });
    return { query, values };
  }
  async first<T>(): Promise<T | null> {
    this.owner.fail(this.sql, "read");
    const compiled = this.compiled();
    return (this.owner.database.prepare(compiled.query).get(...compiled.values) as T | undefined) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    this.owner.fail(this.sql, "read");
    const compiled = this.compiled();
    return { success: true, results: this.owner.database.prepare(compiled.query).all(...compiled.values) as T[], meta: {} as D1Meta };
  }
  async run(): Promise<D1Result> {
    this.owner.fail(this.sql, "before");
    const compiled = this.compiled();
    const result = this.owner.database.prepare(compiled.query).run(...compiled.values);
    this.owner.fail(this.sql, "after");
    return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } as D1Meta };
  }
  runSync(): D1Result {
    const compiled = this.compiled();
    const result = this.owner.database.prepare(compiled.query).run(...compiled.values);
    return { success: true, results: [], meta: { changes: result.changes } as D1Meta };
  }
}

export class SqliteD1 {
  readonly faults: D1Fault[] = [];
  constructor(readonly database: Database.Database) {}
  prepare(sql: string): Statement { return new Statement(this, sql); }
  withSession(_constraint: string): SqliteD1 { return new SqliteD1Session(this.database, this.faults); }
  async batch(statements: Statement[]): Promise<D1Result[]> {
    this.database.exec("BEGIN");
    try {
      const results = statements.map(statement => statement.runSync());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  inject(fault: D1Fault): void { this.faults.push({ ...fault, remaining: fault.remaining ?? 1 }); }
  fail(sql: string, phase: D1Fault["phase"]): void {
    const fault = this.faults.find(item => item.phase === phase && (item.remaining ?? 0) > 0 && item.pattern.test(sql));
    if (!fault) return;
    fault.remaining = (fault.remaining ?? 1) - 1;
    throw new Error(`simulated D1 ${phase} failure`);
  }
}

class SqliteD1Session extends SqliteD1 {
  constructor(database: Database.Database, faults: D1Fault[]) { super(database); this.faults.push(...faults); }
}

export async function createEmailDeliveryDatabase(): Promise<{ sqlite: Database.Database; d1: SqliteD1 }> {
  const sqlite = new Database(":memory:");
  sqlite.exec(await readFile(new URL("../../migrations/0001_initial.sql", import.meta.url), "utf8"));
  sqlite.exec(await readFile(new URL("../../migrations/0010_email_delivery_ledger.sql", import.meta.url), "utf8"));
  return { sqlite, d1: new SqliteD1(sqlite) };
}

export async function createProductionEmailDeliveryDatabase(): Promise<{ sqlite: Database.Database; d1: SqliteD1 }> {
  const sqlite = new Database(":memory:");
  const apply = async (name: string) => sqlite.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  for (const name of ["0001_initial.sql", "0002_controlled_execution_lock.sql", "0003_gemini_usage_model.sql",
    "0005_gemini_ambiguity_accounting.sql", "0006_gemini_timeout_admission.sql"]) await apply(name);
  sqlite.prepare("INSERT INTO gemini_usage (id,timestamp,provider,operation,request_count,input_tokens,output_tokens,total_tokens,model,accounting_status,ambiguity_reason,accounting_through,settled_at,retired_at) VALUES (22,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("2026-10-12T08:00:10.882Z", "gemini", "analysis", 1, 0, 0, 0, "gemini-3.8-flash", "transport_ambiguous", "abandoned_reservation", "2026-10-12T08:00:10.947Z", null, null);
  for (const name of ["0007_row22_exact_recovery.sql", "0008_monitoring_cycle_observability.sql",
    "0009_openai_fallback_usage.sql", "0010_email_delivery_ledger.sql"]) await apply(name);
  return { sqlite, d1: new SqliteD1(sqlite) };
}
