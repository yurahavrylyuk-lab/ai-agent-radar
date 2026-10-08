import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { D1BraveUsageStore } from "../src/services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "../src/services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "../src/services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "../src/services/d1NotificationHistory.js";
import { reconcileStrandedGeminiReservation } from "../src/services/geminiAmbiguityRecovery.js";
import { checkBraveSearchUsage } from "../src/services/usageGuard.js";
import { checkGeminiUsage, getGeminiUsageCounts } from "../src/services/geminiUsageGuard.js";
import worker, { type RadarWorkerEnv } from "../src/worker.js";
import type { AgentAnalysis } from "../src/types/index.js";

class SqliteD1Statement {
  constructor(
    protected readonly database: Database.Database,
    protected readonly query: string,
    protected readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.query, values);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sqliteQuery()).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.database.prepare(this.sqliteQuery()).all(...this.values) as T[],
      meta: {} as D1Meta,
    };
  }

  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.sqliteQuery()).run(...this.values);
    return { success: true, results: [], meta: { changes: result.changes } as D1Meta };
  }

  async batchResult(): Promise<D1Result> {
    if (/\bRETURNING\b/i.test(this.query)) {
      const results = this.database.prepare(this.sqliteQuery()).all(...this.values);
      return { success: true, results, meta: { changes: results.length } as D1Meta };
    }
    return this.run();
  }

  private sqliteQuery(): string {
    return this.query.replace(/\?\d+/g, "?");
  }
}

class SqliteD1Database {
  constructor(protected readonly database: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements: SqliteD1Statement[]): Promise<D1Result[]> {
    this.database.exec("BEGIN");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.batchResult());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class LostMutationResponseStatement extends SqliteD1Statement {
  constructor(database: Database.Database, query: string, values: unknown[] = [], private readonly lostResponsePattern: RegExp) {
    super(database, query, values);
  }

  override bind(...values: unknown[]): LostMutationResponseStatement {
    return new LostMutationResponseStatement(this.database, this.query, values, this.lostResponsePattern);
  }

  override async first<T>(): Promise<T | null> {
    const result = await super.first<T>();
    if (this.lostResponsePattern.test(this.query)) throw new Error("simulated lost D1 mutation response");
    return result;
  }
}

class LostMutationResponseDatabase extends SqliteD1Database {
  constructor(database: Database.Database, private readonly lostResponsePattern: RegExp) { super(database); }
  override prepare(query: string): LostMutationResponseStatement {
    return new LostMutationResponseStatement(this.database, query, [], this.lostResponsePattern);
  }
}

async function withDatabase(callback: (database: Database.Database, d1: D1Database) => Promise<void>): Promise<void> {
  const database = new Database(":memory:");
  try {
    database.exec(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    database.exec(await readFile(new URL("../migrations/0003_gemini_usage_model.sql", import.meta.url), "utf8"));
    database.exec(await readFile(new URL("../migrations/0005_gemini_ambiguity_accounting.sql", import.meta.url), "utf8"));
    await callback(database, new SqliteD1Database(database) as unknown as D1Database);
  } finally {
    database.close();
  }
}

function analysis(url = "https://example.com/discovery?quoted='value'"): AgentAnalysis {
  return {
    name: "Example Agent",
    category: "new_agent",
    summary: "A D1 discovery.",
    relevanceScore: 8,
    whyItMatters: "It verifies D1 persistence.",
    educationalValue: "It demonstrates an adapter boundary.",
    projectOpportunities: ["Build a D1-backed radar"],
    technologies: ["TypeScript", "D1"],
    sourceTitle: "Example source",
    sourceUrl: url,
  };
}

test("D1 discovery history starts empty, round-trips analysis, deduplicates, and touches lastSeenAt", async () => {
  await withDatabase(async (_database, d1) => {
    const history = new D1DiscoveryHistory(d1);
    assert.deepEqual(await history.listDiscoveries(), []);

    const first = await history.recordDiscovery(analysis(), new Date("2026-09-20T10:00:00.000Z"));
    const duplicate = await history.recordDiscovery(analysis(), new Date("2026-09-20T11:00:00.000Z"));
    assert.deepEqual(await history.getDiscovery(analysis().sourceUrl), first);
    const touched = await history.touchDiscovery(first.normalizedUrl, new Date("2026-09-20T12:00:00.000Z"));

    assert.equal(await history.hasDiscovery(analysis().sourceUrl), true);
    assert.deepEqual(duplicate, first);
    assert.equal((await history.listDiscoveries()).length, 1);
    assert.equal(touched?.firstSeenAt, first.firstSeenAt);
    assert.equal(touched?.lastSeenAt, "2026-09-20T12:00:00.000Z");
    assert.deepEqual(touched?.analysis, first.analysis);
  });
});

test("D1 discovery history rejects malformed persisted analysis", async () => {
  await withDatabase(async (database, d1) => {
    database.prepare("INSERT INTO discoveries VALUES (?, ?, ?, ?)").run(
      "https://example.com/bad",
      "2026-09-20T10:00:00.000Z",
      "2026-09-20T10:00:00.000Z",
      "{not-json",
    );
    await assert.rejects(new D1DiscoveryHistory(d1).listDiscoveries(), /invalid analysis JSON/);
  });
});

test("D1 recent discovery lookup matches bounded boundary and ordering semantics", async () => {
  await withDatabase(async (_database, d1) => {
    const history = new D1DiscoveryHistory(d1);
    await history.recordDiscovery(analysis("https://example.com/lower"), new Date("2026-10-06T16:00:00.000Z"));
    await history.recordDiscovery(analysis("https://example.com/b"), new Date("2026-10-07T08:00:00.000Z"));
    await history.recordDiscovery(analysis("https://example.com/a"), new Date("2026-10-07T08:00:00.000Z"));
    await history.recordDiscovery(analysis("https://example.com/upper"), new Date("2026-10-08T08:00:00.000Z"));

    const recent = await history.listRecentDiscoveries({
      fromInclusive: "2026-10-06T16:00:00.000Z",
      beforeExclusive: "2026-10-08T08:00:00.000Z",
      limit: 2,
    });
    assert.deepEqual(recent.discoveries.map((item) => item.normalizedUrl), [
      "https://example.com/a",
      "https://example.com/b",
    ]);
    assert.equal(recent.truncated, true);
    await assert.rejects(history.listRecentDiscoveries({
      fromInclusive: "2026-10-06T16:00:00.000Z",
      beforeExclusive: "2026-10-08T08:00:00.000Z",
      limit: 0,
    }), /limit must be an integer from 1 to 100/);
  });
});

test("D1 notification history preserves URL/channel identity and provider message IDs", async () => {
  await withDatabase(async (_database, d1) => {
    const history = new D1NotificationHistory(d1);
    assert.deepEqual(await history.listNotificationRecords(), []);
    const first = await history.recordNotificationSent("https://example.com/source/", "email", "email_123", new Date("2026-09-20T10:00:00.000Z"));
    const duplicate = await history.recordNotificationSent("https://example.com/source", "email", "email_456", new Date("2026-09-20T11:00:00.000Z"));

    assert.equal(await history.hasNotificationBeenSent("https://example.com/source", "email"), true);
    assert.deepEqual(await history.getNotificationRecord("https://example.com/source", "email"), first);
    assert.deepEqual(duplicate, first);
    assert.equal((await history.listNotificationRecords()).length, 1);
    assert.equal(first.providerMessageId, "email_123");
  });
});

test("D1 Brave usage records round-trip and remain usable by the existing guard", async () => {
  await withDatabase(async (database, d1) => {
    const store = new D1BraveUsageStore(d1);
    assert.deepEqual(await store.getRecords(), []);
    await store.recordRequest({ timestamp: "2026-09-20T10:00:00.000Z", provider: "brave", operation: "web-search", requestCount: 1 });
    assert.equal((await store.getRecords()).length, 1);
    assert.equal((await checkBraveSearchUsage(store, {
      BRAVE_DAILY_SEARCH_LIMIT: "10",
      BRAVE_WEEKLY_SEARCH_LIMIT: "100",
      BRAVE_MONTHLY_SEARCH_LIMIT: "350",
    }, new Date("2026-09-20T12:00:00.000Z"))).allowed, true);

    database.prepare("INSERT INTO brave_usage (timestamp, provider, operation, request_count) VALUES (?, ?, ?, ?)").run(
      "not-a-date", "brave", "web-search", 1,
    );
    assert.equal((await checkBraveSearchUsage(store, {
      BRAVE_DAILY_SEARCH_LIMIT: "10",
      BRAVE_WEEKLY_SEARCH_LIMIT: "100",
      BRAVE_MONTHLY_SEARCH_LIMIT: "350",
    })).allowed, false);
  });
});

test("D1 Gemini usage round-trips totals, preserves window semantics, and fails closed on malformed state", async () => {
  await withDatabase(async (database, d1) => {
    const store = new D1GeminiUsageStore(d1);
    assert.deepEqual(await store.getUsageData(), { records: [], usageUnknown: false });
    await store.recordRequest({
      timestamp: "2026-09-20T10:00:00.000Z",
      provider: "gemini",
      operation: "generate",
      requestCount: 1,
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 112,
      model: null,
    });
    const data = await store.getUsageData();
    assert.equal(data.records.length, 1);
    assert.deepEqual(getGeminiUsageCounts(data.records, new Date("2026-09-20T12:00:00.000Z")), {
      dailyRequests: 1,
      weeklyRequests: 1,
      monthlyRequests: 1,
      dailyTokens: 112,
      weeklyTokens: 112,
      monthlyTokens: 112,
    });
    assert.equal((await checkGeminiUsage(store, {
      GEMINI_API_KEY: "test-key",
      GEMINI_DAILY_REQUEST_LIMIT: "5",
      GEMINI_WEEKLY_REQUEST_LIMIT: "20",
      GEMINI_MONTHLY_REQUEST_LIMIT: "50",
      GEMINI_DAILY_TOKEN_LIMIT: "10000",
      GEMINI_WEEKLY_TOKEN_LIMIT: "30000",
      GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
    })).allowed, true);

    const admission = {
      cycleRequestsRemaining: 5,
      limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 },
    };
    const reservation = await store.reserveRequest({
      timestamp: "2026-09-20T12:30:00.000Z",
      provider: "gemini",
      operation: "analysis",
      requestCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model: "gemini-3.8-flash",
    }, admission);
    assert.equal((await store.getUsageData()).usageUnknown, false);
    assert.equal((await store.getUsageData()).records[1]?.accountingStatus, "reserved");
    await assert.rejects(store.reserveRequest({ ...reservation.record, id: undefined, accountingStatus: undefined, timestamp: "2026-09-20T12:31:00.000Z" }, admission), /could not be (admitted|reserved) safely/);
    await store.settleRequest(reservation, { inputTokens: 2, outputTokens: 1, totalTokens: 4 });
    const settled = await store.getUsageData();
    assert.equal(settled.usageUnknown, false);
    assert.equal(settled.records[1]?.model, "gemini-3.8-flash");
    assert.equal(settled.records[1]?.totalTokens, 4);
    assert.equal(settled.records[1]?.accountingStatus, "exact");

    database.pragma("ignore_check_constraints = ON");
    database.prepare("UPDATE gemini_usage_state SET usage_unknown = 2 WHERE id = 1").run();
    await assert.rejects(store.getUsageData());
  });
});

test("migration 0005 preserves legacy rows and enforces one unresolved structured request", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    database.exec(await readFile(new URL("../migrations/0003_gemini_usage_model.sql", import.meta.url), "utf8"));
    database.prepare("INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model) VALUES (?, 'gemini', 'analysis', 1, 0, 0, 0, ?)")
      .run("2026-10-08T08:02:03.393Z", "gemini-3.8-flash");
    database.exec(await readFile(new URL("../migrations/0005_gemini_ambiguity_accounting.sql", import.meta.url), "utf8"));
    const legacy = database.prepare("SELECT accounting_status, ambiguity_reason, accounting_through, settled_at, retired_at FROM gemini_usage WHERE id = 1").get() as Record<string, unknown>;
    assert.deepEqual(legacy, { accounting_status: "legacy", ambiguity_reason: null,
      accounting_through: "2026-10-08T08:02:03.393Z", settled_at: null, retired_at: null });
    database.prepare("INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, accounting_through) VALUES (?, 'gemini', 'analysis', 1, 0, 0, 0, ?, 'reserved', ?)")
      .run("2025-01-01T00:00:00.000Z", "gemini-3.8-flash", "2025-01-01T00:00:00.000Z");
    assert.throws(() => database.prepare("INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, ambiguity_reason, accounting_through) VALUES (?, 'gemini', 'analysis', 1, 0, 0, 0, ?, 'transport_ambiguous', 'timeout', ?)")
      .run("2025-01-02T00:00:00.000Z", "gemini-3.6-flash", "2025-01-02T00:00:00.000Z"), /UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});

test("D1 atomic admission admits only one concurrent owner and stale ownership cannot settle it", async () => {
  await withDatabase(async (_database, d1) => {
    const store = new D1GeminiUsageStore(d1);
    const admission = {
      cycleRequestsRemaining: 5,
      limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 },
    };
    const request = {
      timestamp: new Date().toISOString(), provider: "gemini" as const, operation: "analysis", requestCount: 1 as const,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash" as const,
    };
    const attempts = await Promise.allSettled([
      store.reserveRequest(request, admission),
      store.reserveRequest({ ...request, model: "gemini-3.6-flash" }, admission),
    ]);
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
    const winner = attempts.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof store.reserveRequest>>> => item.status === "fulfilled")!.value;
    await assert.rejects(store.settleRequest({ ...winner, record: { ...winner.record, timestamp: "2020-01-01T00:00:00.000Z" } }, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }), /could not be settled safely/);
    await assert.rejects(store.settleRequest({ ...winner, record: { ...winner.record, operation: "other" } }, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }), /could not be settled safely/);
    assert.equal((await store.getUsageData()).records.find((record) => record.id === winner.record.id)?.accountingStatus, "reserved");
    await store.markRequestAmbiguous(winner, "abandoned_reservation");
    assert.equal((await store.getUsageData()).records.find((record) => record.id === winner.record.id)?.accountingStatus, "transport_ambiguous");
  });
});

test("D1 lost admission response is authoritatively reread and never returned as dispatch permission", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    database.exec(await readFile(new URL("../migrations/0003_gemini_usage_model.sql", import.meta.url), "utf8"));
    database.exec(await readFile(new URL("../migrations/0005_gemini_ambiguity_accounting.sql", import.meta.url), "utf8"));
    const d1 = new LostMutationResponseDatabase(database, /^INSERT INTO gemini_usage/);
    const store = new D1GeminiUsageStore(d1 as unknown as D1Database);
    await assert.rejects(store.reserveRequest({
      timestamp: new Date().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash",
    }, {
      cycleRequestsRemaining: 5,
      limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 },
    }), /outcome is uncertain/);
    const durable = await store.getUsageData();
    assert.equal(durable.records.length, 1);
    assert.equal(durable.records[0]?.accountingStatus, "reserved");
  } finally {
    database.close();
  }
});

test("D1 lost exact-settlement response is resolved by authoritative reread without a second write", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    database.exec(await readFile(new URL("../migrations/0003_gemini_usage_model.sql", import.meta.url), "utf8"));
    database.exec(await readFile(new URL("../migrations/0005_gemini_ambiguity_accounting.sql", import.meta.url), "utf8"));
    const normalStore = new D1GeminiUsageStore(new SqliteD1Database(database) as unknown as D1Database);
    const admission = { cycleRequestsRemaining: 5, limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 } };
    const reservation = await normalStore.reserveRequest({
      timestamp: new Date().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash",
    }, admission);
    const uncertainStore = new D1GeminiUsageStore(new LostMutationResponseDatabase(database, /^UPDATE gemini_usage SET input_tokens/) as unknown as D1Database);
    await uncertainStore.settleRequest(reservation, { inputTokens: 9, outputTokens: 4, totalTokens: 112 });
    const record = (await normalStore.getUsageData()).records[0];
    assert.equal(record?.accountingStatus, "exact");
    assert.equal(record?.totalTokens, 112);
    await assert.rejects(
      normalStore.settleRequest({ ...reservation, record: { ...reservation.record, operation: "other" } }, { inputTokens: 9, outputTokens: 4, totalTokens: 112 }),
      /could not be settled safely/,
    );
  } finally {
    database.close();
  }
});

test("D1 stranded reservation reconciliation uses exact CAS and authoritative reread", async () => {
  await withDatabase(async (database, d1) => {
    const store = new D1GeminiUsageStore(d1);
    const reservation = await store.reserveRequest({
      timestamp: new Date().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash",
    }, { cycleRequestsRemaining: 5, limits: {
      dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50,
      dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000,
    } });
    const expectation = { id: reservation.record.id!, timestamp: reservation.record.timestamp,
      model: reservation.record.model, operation: reservation.record.operation };
    const restarted = new D1GeminiUsageStore(new SqliteD1Database(database) as unknown as D1Database);
    await assert.rejects(reconcileStrandedGeminiReservation(restarted, expectation, new Date(), false), /original invocation/);
    await assert.rejects(reconcileStrandedGeminiReservation(restarted,
      { ...expectation, timestamp: "2020-01-01T00:00:00.000Z" }, new Date(), true), /identity/);

    const uncertain = new D1GeminiUsageStore(new LostMutationResponseDatabase(database,
      /^UPDATE gemini_usage SET accounting_status = 'transport_ambiguous'/) as unknown as D1Database);
    assert.equal(await reconcileStrandedGeminiReservation(uncertain, expectation, new Date(), true), "already_reconciled");
    const record = (await restarted.getUsageData()).records.find((item) => item.id === expectation.id)!;
    assert.equal(record.accountingStatus, "transport_ambiguous");
    assert.equal(record.ambiguityReason, "abandoned_reservation");
    assert.deepEqual([record.inputTokens, record.outputTokens, record.totalTokens], [0, 0, 0]);
    assert.ok(record.accountingThrough && record.accountingThrough >= record.timestamp);
    assert.equal(await reconcileStrandedGeminiReservation(restarted, expectation, new Date(), true), "already_reconciled");
  });
});

test("D1 operator retirement and admission serialize without overlapping unresolved ownership", async () => {
  await withDatabase(async (database, d1) => {
    database.prepare("INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, ambiguity_reason, accounting_through) VALUES (?, 'gemini', 'analysis', 1, 0, 0, 0, ?, 'transport_ambiguous', 'timeout', ?)")
      .run("2025-01-01T00:00:00.000Z", "gemini-3.8-flash", "2025-01-01T00:00:00.000Z");
    const id = Number((database.prepare("SELECT id FROM gemini_usage WHERE accounting_status = 'transport_ambiguous'").get() as { id: number }).id);
    const store = new D1GeminiUsageStore(d1);
    const expectation = { id, timestamp: "2025-01-01T00:00:00.000Z", model: "gemini-3.8-flash" as const, ambiguityReason: "timeout" as const };
    const admission = {
      cycleRequestsRemaining: 5,
      limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 },
    };
    const outcomes = await Promise.allSettled([
      store.retireAmbiguousRequest(expectation),
      store.reserveRequest({ timestamp: new Date().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.6-flash" }, admission),
    ]);
    assert.equal(outcomes[0]?.status, "fulfilled");
    const data = await store.getUsageData();
    assert.ok(data.records.filter((record) => ["reserved", "transport_ambiguous"].includes(record.accountingStatus ?? "legacy")).length <= 1);
  });
});

test("D1 adapter fails closed if the unresolved uniqueness invariant is corrupted", async () => {
  await withDatabase(async (database, d1) => {
    database.exec("DROP INDEX gemini_usage_one_unresolved_request");
    for (const [index, status] of ["reserved", "transport_ambiguous"].entries()) {
      database.prepare("INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, ambiguity_reason, accounting_through) VALUES (?, 'gemini', 'analysis', 1, 0, 0, 0, ?, ?, ?, ?)")
        .run(`2025-01-0${index + 1}T00:00:00.000Z`, "gemini-3.8-flash", status,
          status === "transport_ambiguous" ? "timeout" : null, `2025-01-0${index + 1}T00:00:00.000Z`);
    }
    await assert.rejects(new D1GeminiUsageStore(d1).getUsageData(), /conflicting unresolved/);
  });
});

test("Worker health fetch is harmless and does not invoke monitoring", async () => {
  const response = await worker.fetch(new Request("https://worker.example"), {
    DB: {} as D1Database,
  } as RadarWorkerEnv);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "AI Agent Radar worker ready");
});
