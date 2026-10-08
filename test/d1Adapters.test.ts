import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { D1BraveUsageStore } from "../src/services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "../src/services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "../src/services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "../src/services/d1NotificationHistory.js";
import { D1XStore } from "../src/services/d1XStore.js";
import { checkBraveSearchUsage } from "../src/services/usageGuard.js";
import { checkGeminiUsage, getGeminiUsageCounts } from "../src/services/geminiUsageGuard.js";
import worker, { type RadarWorkerEnv } from "../src/worker.js";
import type { AgentAnalysis, XSourceProvenance } from "../src/types/index.js";

class SqliteD1Statement {
  constructor(
    private readonly database: Database.Database,
    private readonly query: string,
    private readonly values: unknown[] = [],
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
  constructor(private readonly database: Database.Database) {}

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

async function withDatabase(callback: (database: Database.Database, d1: D1Database) => Promise<void>): Promise<void> {
  const database = new Database(":memory:");
  try {
    database.exec(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
    database.exec(await readFile(new URL("../migrations/0003_gemini_usage_model.sql", import.meta.url), "utf8"));
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

    const reservation = await store.reserveRequest({
      timestamp: "2026-09-20T12:30:00.000Z",
      provider: "gemini",
      operation: "analysis",
      requestCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model: "gemini-3.8-flash",
    });
    assert.equal((await store.getUsageData()).usageUnknown, true);
    await assert.rejects(store.reserveRequest({ ...reservation.record, timestamp: "2026-09-20T12:31:00.000Z" }), /could not be acquired safely/);
    await store.settleRequest(reservation, { inputTokens: 2, outputTokens: 1, totalTokens: 4 });
    const settled = await store.getUsageData();
    assert.equal(settled.usageUnknown, false);
    assert.equal(settled.records[1]?.model, "gemini-3.8-flash");
    assert.equal(settled.records[1]?.totalTokens, 4);

    database.pragma("ignore_check_constraints = ON");
    database.prepare("UPDATE gemini_usage_state SET usage_unknown = 2 WHERE id = 1").run();
    await assert.rejects(store.getUsageData());
  });
});

test("Worker health fetch is harmless and does not invoke monitoring", async () => {
  const response = await worker.fetch(new Request("https://worker.example"), {
    DB: {} as D1Database,
  } as RadarWorkerEnv);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "AI Agent Radar worker ready");
});
