import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { D1BraveUsageStore } from "../src/services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "../src/services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "../src/services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "../src/services/d1NotificationHistory.js";
import { checkBraveSearchUsage } from "../src/services/usageGuard.js";
import { checkGeminiUsage, getGeminiUsageCounts } from "../src/services/geminiUsageGuard.js";
import worker, { type RadarWorkerEnv } from "../src/worker.js";
import type { AgentAnalysis } from "../src/types/index.js";

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
    return { success: true, results: [], meta: { changes: result.changes } as D1Meta };
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
}

async function withDatabase(callback: (database: Database.Database, d1: D1Database) => Promise<void>): Promise<void> {
  const database = new Database(":memory:");
  try {
    database.exec(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
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
      BRAVE_WEEKLY_SEARCH_LIMIT: "50",
      BRAVE_MONTHLY_SEARCH_LIMIT: "200",
    }, new Date("2026-09-20T12:00:00.000Z"))).allowed, true);

    database.prepare("INSERT INTO brave_usage (timestamp, provider, operation, request_count) VALUES (?, ?, ?, ?)").run(
      "not-a-date", "brave", "web-search", 1,
    );
    assert.equal((await checkBraveSearchUsage(store, {
      BRAVE_DAILY_SEARCH_LIMIT: "10",
      BRAVE_WEEKLY_SEARCH_LIMIT: "50",
      BRAVE_MONTHLY_SEARCH_LIMIT: "200",
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
      GEMINI_DAILY_REQUEST_LIMIT: "5",
      GEMINI_WEEKLY_REQUEST_LIMIT: "20",
      GEMINI_MONTHLY_REQUEST_LIMIT: "50",
      GEMINI_DAILY_TOKEN_LIMIT: "10000",
      GEMINI_WEEKLY_TOKEN_LIMIT: "30000",
      GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
    })).allowed, true);

    database.pragma("ignore_check_constraints = ON");
    database.prepare("UPDATE gemini_usage_state SET usage_unknown = 2 WHERE id = 1").run();
    await assert.rejects(store.getUsageData());
  });
});

test("Worker health fetch is harmless and does not invoke monitoring", async () => {
  const response = worker.fetch(new Request("https://worker.example"), {
    DB: {} as D1Database,
  } as RadarWorkerEnv);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "AI Agent Radar worker ready");
});
