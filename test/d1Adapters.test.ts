import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { D1BraveUsageStore } from "../src/services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "../src/services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "../src/services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "../src/services/d1NotificationHistory.js";
import { D1XStore } from "../src/services/d1XStore.js";
import { reconcileStrandedGeminiReservation } from "../src/services/geminiAmbiguityRecovery.js";
import { checkBraveSearchUsage } from "../src/services/usageGuard.js";
import { checkGeminiUsage, getGeminiUsageCounts } from "../src/services/geminiUsageGuard.js";
import { runMonitoringCycle } from "../src/services/monitor.js";
import worker, { createWorkerMonitoringDependencies, type RadarWorkerEnv } from "../src/worker.js";
import type { AgentAnalysis, XSourceProvenance } from "../src/types/index.js";
import type { XInboxRecord } from "../src/services/xStore.js";

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
    return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } as D1Meta };
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
    database.exec(await readFile(new URL("../migrations/0006_gemini_timeout_admission.sql", import.meta.url), "utf8"));
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

const xOpaqueId = (index: number) => (9_007_199_254_740_000_000n + BigInt(index)).toString();
function xRecord(index: number, options: { createdAt?: string; editIds?: string[]; storyUrl?: string } = {}): XInboxRecord {
  const postId = xOpaqueId(index);
  const createdAt = options.createdAt ?? "2026-10-07T08:00:00.000Z";
  const storyUrl = options.storyUrl ?? `https://example.com/x-${index}`;
  const editIds = options.editIds ?? [postId];
  return {
    postId,
    authorId: "4398626122",
    storyUrl,
    createdAt,
    state: "pending",
    editIds,
    payload: {
      postId,
      authorId: "4398626122",
      storyUrl,
      createdAt,
      text: `Release ${index}`,
      canonicalPostUrl: `https://x.com/i/web/status/${postId}`,
      label: "OpenAI",
      approvedHandle: "OpenAI",
      editIds: [...editIds],
    },
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

test("D1 discovery history round-trips strict application-owned X provenance", async () => {
  await withDatabase(async (_database, d1) => {
    const history = new D1DiscoveryHistory(d1);
    const provenance: XSourceProvenance = { kind: "x", postId: "9007199254740993000", authorId: "1353836358901501952", postUrl: "https://x.com/i/web/status/9007199254740993000", label: "Anthropic" };
    const recorded = await history.recordDiscovery(analysis("https://example.com/x"), new Date("2026-10-08T08:00:00.000Z"), provenance);
    assert.deepEqual(recorded.sourceProvenance, provenance);
    assert.deepEqual((await history.touchDiscovery(recorded.normalizedUrl, new Date("2026-10-08T09:00:00.000Z")))?.sourceProvenance, provenance);
  });
});

test("D1 X store applies additive schema and atomically persists request, page and cursor state", async () => {
  await withDatabase(async (database, d1) => {
    database.exec(await readFile(new URL("../migrations/0004_x_discovery.sql", import.meta.url), "utf8"));
    const store = new D1XStore(d1);
    const reservation = await store.reserveRequest("4398626122", new Date("2026-10-08T08:00:00.000Z"), {
      cycleRequestsAlreadyReserved: 0, requestsPerCycle: 5, requestsPerDay: 5, requestsPerIsoWeek: 35, requestsPerMonth: 155,
      reservedPostsPerRequest: 10, reservedPostsPerMonth: 1550, reservedMicroUsdPerMonth: 8_000_000, reservedMicroUsdPerRequest: 50_000,
    });
    assert.equal(reservation.allowed, true);
    await store.settleRequest(reservation.reservationId!, "success");
    await store.commitPage("4398626122", "9007199254740993123", [{ postId: "9007199254740993000", authorId: "4398626122", storyUrl: "https://example.com/x", createdAt: "2026-10-07T08:00:00.000Z", state: "pending", editIds: ["9007199254740993000"], payload: { postId: "9007199254740993000", authorId: "4398626122", storyUrl: "https://example.com/x", createdAt: "2026-10-07T08:00:00.000Z", text: "Release", canonicalPostUrl: "https://x.com/i/web/status/9007199254740993000", label: "OpenAI", approvedHandle: "OpenAI", editIds: ["9007199254740993000"] } }], new Date("2026-10-08T08:00:00.000Z"));
    assert.equal((await store.getPollState("4398626122")).sinceId, "9007199254740993123");
    assert.equal((await store.listPending(new Date("2026-10-08T08:00:00.000Z"), 350)).records.length, 1);
    await store.markStoryProcessed("https://example.com/x");
    assert.equal((await store.listPending(new Date("2026-10-08T08:00:00.000Z"), 350)).records.length, 0);
  });
});

test("D1 X store rejects alias conflicts atomically and preserves exact re-observation", async () => {
  await withDatabase(async (database, d1) => {
    database.exec(await readFile(new URL("../migrations/0004_x_discovery.sql", import.meta.url), "utf8"));
    const store = new D1XStore(d1);
    const alias = xOpaqueId(99);
    for (const editIds of [[], [xOpaqueId(1), xOpaqueId(1)], [alias]]) {
      await assert.rejects(store.commitPage("4398626122", xOpaqueId(49), [xRecord(1, { editIds })], new Date("2026-10-08T08:00:00.000Z")), /edit identity is invalid/);
      assert.deepEqual(await store.getPollState("4398626122"), {});
    }
    await assert.rejects(store.commitPage("4398626122", xOpaqueId(50), [
      xRecord(1, { editIds: [xOpaqueId(1), alias] }),
      xRecord(2, { editIds: [xOpaqueId(2), alias] }),
    ], new Date("2026-10-08T08:00:00.000Z")), /conflicting edit alias/);
    assert.deepEqual(await store.getPollState("4398626122"), {});
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM x_inbox").get().count, 0);

    const original = xRecord(1, { editIds: [xOpaqueId(1), alias] });
    await store.commitPage("4398626122", xOpaqueId(51), [original], new Date("2026-10-08T08:00:00.000Z"));
    await store.commitPage("4398626122", xOpaqueId(52), [original], new Date("2026-10-08T08:00:00.000Z"));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM x_inbox").get().count, 1);
    assert.equal((await store.getStoryByPostId(alias))?.storyUrl, original.storyUrl);
    assert.equal(typeof (await store.listPending(new Date("2026-10-08T08:00:00.000Z"), 350)).records[0].postId, "string");

    await assert.rejects(store.commitPage("4398626122", xOpaqueId(53), [
      xRecord(2, { editIds: [xOpaqueId(2), alias] }),
    ], new Date("2026-10-08T08:00:00.000Z")), /conflicts with a frozen story/);
    assert.equal((await store.getPollState("4398626122")).sinceId, xOpaqueId(52));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM x_inbox").get().count, 1);
  });
});

test("D1 X store enforces expiry and deterministic 350-record cap in commit transaction", async () => {
  await withDatabase(async (database, d1) => {
    database.exec(await readFile(new URL("../migrations/0004_x_discovery.sql", import.meta.url), "utf8"));
    const store = new D1XStore(d1);
    await store.commitPage("4398626122", xOpaqueId(699), [
      xRecord(999, { createdAt: "2026-09-30T08:00:00.000Z" }),
      ...Array.from({ length: 349 }, (_, index) => xRecord(index + 1, { createdAt: "2026-10-07T06:00:00.000Z" })),
    ], new Date("2026-10-07T07:00:00.000Z"));
    await store.commitPage("4398626122", xOpaqueId(700), [
      xRecord(350, { createdAt: "2026-10-08T07:00:00.000Z" }),
      xRecord(351, { createdAt: "2026-10-08T07:00:00.000Z" }),
    ], new Date("2026-10-08T08:00:00.000Z"));
    const counts = database.prepare("SELECT state, COUNT(*) AS count FROM x_inbox GROUP BY state ORDER BY state").all() as Array<{ state: string; count: number }>;
    assert.deepEqual(counts, [{ state: "expired", count: 2 }, { state: "pending", count: 350 }]);
    const old = database.prepare("SELECT state, payload_json FROM x_inbox WHERE post_id = ?").get(xOpaqueId(999)) as { state: string; payload_json: string | null };
    const tie = database.prepare("SELECT state, payload_json FROM x_inbox WHERE post_id = ?").get(xOpaqueId(1)) as { state: string; payload_json: string | null };
    assert.deepEqual(old, { state: "expired", payload_json: null });
    assert.deepEqual(tie, { state: "expired", payload_json: null });
    assert.equal((await store.getPollState("4398626122")).sinceId, xOpaqueId(700));
    const restarted = new D1XStore(d1);
    const pending = await restarted.listPending(new Date("2026-10-08T08:00:00.000Z"), 350);
    assert.equal(pending.records.length, 350);
    assert.deepEqual(pending.records.slice(0, 2).map((item) => item.postId), [xOpaqueId(350), xOpaqueId(351)]);
  });
});

test("D1 X store cleanup failure rolls back inbox and cursor in the same batch", async () => {
  await withDatabase(async (database, d1) => {
    database.exec(await readFile(new URL("../migrations/0004_x_discovery.sql", import.meta.url), "utf8"));
    const store = new D1XStore(d1);
    await store.commitPage("4398626122", xOpaqueId(80), [xRecord(1, { createdAt: "2026-09-30T08:00:00.000Z" })], new Date("2026-10-01T08:00:00.000Z"));
    database.exec("CREATE TRIGGER fail_x_cleanup BEFORE UPDATE OF state ON x_inbox BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END");
    await assert.rejects(store.commitPage("4398626122", xOpaqueId(81), [xRecord(2)], new Date("2026-10-08T08:00:00.000Z")), /injected cleanup failure/);
    assert.equal((await store.getPollState("4398626122")).sinceId, xOpaqueId(80));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM x_inbox").get().count, 1);
    const existing = database.prepare("SELECT state, payload_json FROM x_inbox WHERE post_id = ?").get(xOpaqueId(1)) as { state: string; payload_json: string | null };
    assert.equal(existing.state, "pending");
    assert.ok(existing.payload_json);
  });
});

test("D1 X store fails closed when persisted aliases make lookup ambiguous", async () => {
  await withDatabase(async (database, d1) => {
    database.exec(await readFile(new URL("../migrations/0004_x_discovery.sql", import.meta.url), "utf8"));
    const alias = xOpaqueId(90);
    for (const item of [xRecord(1, { editIds: [xOpaqueId(1), alias] }), xRecord(2, { editIds: [xOpaqueId(2), alias] })]) {
      database.prepare("INSERT INTO x_inbox VALUES (?, ?, ?, ?, ?, ?, ?)").run(item.postId, item.authorId, item.storyUrl, item.createdAt, JSON.stringify(item.payload), item.state, JSON.stringify(item.editIds));
    }
    await assert.rejects(new D1XStore(d1).getStoryByPostId(alias), /ambiguous/);
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

test("migration 0006 permits historical timeouts but preserves one protected unresolved owner", async () => {
  const database = new Database(":memory:");
  try {
    for (const migration of ["0001_initial.sql", "0002_controlled_execution_lock.sql", "0003_gemini_usage_model.sql", "0005_gemini_ambiguity_accounting.sql", "0006_gemini_timeout_admission.sql"]) {
      database.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    const insert = database.prepare("INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, ambiguity_reason, accounting_through) VALUES (?, 'gemini', 'analysis', 1, 0, 0, 0, ?, 'transport_ambiguous', ?, ?)");
    insert.run("2026-10-08T08:00:00.000Z", "gemini-3.8-flash", "timeout", "2026-10-08T08:01:30.000Z");
    insert.run("2026-10-09T08:00:00.000Z", "gemini-3.6-flash", "timeout", "2026-10-09T08:01:30.000Z");
    insert.run("2026-10-10T08:00:00.000Z", "gemini-3.5-flash-lite", "network_error", "2026-10-10T08:00:01.000Z");
    assert.throws(() => database.prepare("INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, accounting_through) VALUES (?, 'gemini', 'analysis', 1, 0, 0, 0, ?, 'reserved', ?)")
      .run("2026-10-11T08:00:00.000Z", "gemini-3.8-flash", "2026-10-11T08:00:00.000Z"), /UNIQUE constraint failed/);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM gemini_usage").get() as { count: number }).count, 3);
  } finally { database.close(); }
});

test("migration 0006 applies after the complete fresh migration sequence", async () => {
  const database = new Database(":memory:");
  try {
    for (const migration of ["0001_initial.sql", "0002_controlled_execution_lock.sql", "0003_gemini_usage_model.sql", "0004_x_discovery.sql", "0005_gemini_ambiguity_accounting.sql", "0006_gemini_timeout_admission.sql"]) {
      database.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    const index = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'gemini_usage_one_unresolved_request'").get() as { sql: string };
    assert.match(index.sql, /ambiguity_reason <> 'timeout'/);
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'x_inbox'").get());
  } finally { database.close(); }
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

test("D1 timeout admission blocks the same UTC day and permits the next day while retaining history", async () => {
  await withDatabase(async (database, d1) => {
    const store = new D1GeminiUsageStore(d1);
    const admission = { cycleRequestsRemaining: 5, limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 } };
    const insertTimeout = database.prepare("INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, ambiguity_reason, accounting_through) VALUES (?, 'gemini', 'analysis', 1, 0, 0, 0, ?, 'transport_ambiguous', 'timeout', ?)");
    const today = database.prepare("SELECT strftime('%Y-%m-%dT01:00:00.000Z', 'now') AS value").get() as { value: string };
    insertTimeout.run(today.value, "gemini-3.8-flash", today.value);
    await assert.rejects(store.reserveRequest({ timestamp: new Date().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.6-flash" }, admission), /could not be admitted safely/);
    database.prepare("DELETE FROM gemini_usage WHERE id = 1").run();
    const yesterday = database.prepare("SELECT strftime('%Y-%m-%dT01:00:00.000Z', 'now', '-1 day') AS timestamp, strftime('%Y-%m-%dT01:01:30.000Z', 'now', '-1 day') AS accounting_through").get() as { timestamp: string; accounting_through: string };
    insertTimeout.run(yesterday.timestamp, "gemini-3.8-flash", yesterday.accounting_through);
    const reservation = await store.reserveRequest({ timestamp: new Date().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.6-flash" }, admission);
    assert.equal(reservation.record.accountingStatus, "reserved");
    assert.equal((await store.getUsageData()).records.length, 2);
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
          status === "transport_ambiguous" ? "network_error" : null, `2025-01-0${index + 1}T00:00:00.000Z`);
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

test("disabled-X Worker cycle remains safe without migration 0004 tables", async () => {
  await withDatabase(async (_database, d1) => {
    const env: RadarWorkerEnv = {
      DB: d1,
      BRAVE_SEARCH_API_KEY: "offline-brave",
      BRAVE_DAILY_SEARCH_LIMIT: "10",
      BRAVE_WEEKLY_SEARCH_LIMIT: "100",
      BRAVE_MONTHLY_SEARCH_LIMIT: "350",
      GEMINI_API_KEY: "offline-gemini",
      GEMINI_DAILY_REQUEST_LIMIT: "5",
      GEMINI_WEEKLY_REQUEST_LIMIT: "20",
      GEMINI_MONTHLY_REQUEST_LIMIT: "50",
      GEMINI_DAILY_TOKEN_LIMIT: "10000",
      GEMINI_WEEKLY_TOKEN_LIMIT: "30000",
      GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
      RESEND_API_KEY: "offline-resend",
      NOTIFICATION_EMAIL: "offline@example.test",
      X_DISCOVERY_ENABLED: "false",
    };
    const stored = { ...analysis("https://untrusted.example.test/known"), relevanceScore: 1 };
    await new D1DiscoveryHistory(d1).recordDiscovery(stored, new Date("2026-10-10T07:00:00.000Z"));
    let searches = 0;
    const dependencies = createWorkerMonitoringDependencies(env, {
      searchWeb: (async () => {
        searches += 1;
        return [
          { title: stored.sourceTitle, url: stored.sourceUrl, snippet: "Known ordinary article." },
          { title: "Observed X post", url: "https://x.com/OpenAI/status/9007199254740993999", snippet: "Observed status." },
        ];
      }) as typeof import("../src/tools/webSearch.js").searchWeb,
    });
    const outcome = await runMonitoringCycle(undefined, { ...dependencies, now: () => new Date("2026-10-10T08:00:00.000Z") });
    assert.equal(searches, 10);
    assert.equal(outcome.analysesAttempted, 0);
    assert.equal(outcome.duplicates, 10);
    assert.equal(outcome.xBlockedReason, "disabled");
    assert.equal(outcome.notificationsSent, 0);
  });
});
