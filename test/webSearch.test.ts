import assert from "node:assert/strict";
import test from "node:test";

import { MONITORING_FRESHNESS } from "../src/config/discoveryQueries.js";
import { MONITORING_QUERIES, runMonitoringCycle } from "../src/services/monitor.js";
import { BraveUsageGuardDeniedError, searchWeb } from "../src/tools/webSearch.js";
import * as webSearch from "../src/tools/webSearch.js";
import type { UsageRecord, UsageTracker } from "../src/services/usageTracker.js";

const baseEnvironment = {
  BRAVE_SEARCH_API_KEY: "test-key",
  BRAVE_DAILY_SEARCH_LIMIT: "10",
  BRAVE_WEEKLY_SEARCH_LIMIT: "100",
  BRAVE_MONTHLY_SEARCH_LIMIT: "350",
};

class InMemoryUsageTracker implements UsageTracker {
  public readonly records: UsageRecord[];
  public recordCalls = 0;

  constructor(initialCount = 0, private readonly unavailable = false) {
    this.records = initialCount === 0 ? [] : [{
      timestamp: new Date().toISOString(),
      provider: "brave",
      operation: "web-search",
      requestCount: initialCount,
    }];
  }

  async getRecords(): Promise<UsageRecord[]> {
    if (this.unavailable) throw new Error("usage unavailable");
    return this.records;
  }

  async recordRequest(record: UsageRecord): Promise<void> {
    this.recordCalls += 1;
    this.records.push(record);
  }
}

function braveResponse(): Response {
  return new Response(JSON.stringify({ web: { results: [] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function runDefaultSearches(
  tracker: InMemoryUsageTracker,
  environment: Record<string, string | undefined> = baseEnvironment,
): Promise<{ fetches: number; bodies: unknown[] }> {
  let fetches = 0;
  const bodies: unknown[] = [];
  await runMonitoringCycle(undefined, {
    history: {
      getDiscovery: async () => undefined,
      listRecentDiscoveries: async () => ({ discoveries: [], truncated: false }),
      recordDiscovery: async () => { throw new Error("not used"); },
      touchDiscovery: async () => undefined,
    },
    search: (query, options) => searchWeb(query, {
      usageTracker: tracker,
      environment,
      freshness: options?.freshness,
      fetchImplementation: async (_url, init) => {
        fetches += 1;
        bodies.push(JSON.parse(String(init?.body)));
        return braveResponse();
      },
    }),
    geminiPreflight: async () => ({
      allowed: true,
      counts: { dailyRequests: 0, weeklyRequests: 0, monthlyRequests: 0, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 0 },
      limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 },
    }),
  });
  return { fetches, bodies };
}

test("daily usage 0 permits ten sequential guarded fetches with count 5", async () => {
  const tracker = new InMemoryUsageTracker(0);
  const result = await runDefaultSearches(tracker);
  assert.equal(result.fetches, 10);
  assert.equal(tracker.recordCalls, 10);
  assert.deepEqual(result.bodies, MONITORING_QUERIES.map((q) => ({ q, count: 5, freshness: MONITORING_FRESHNESS })));
});

test("a direct search without monitoring options preserves the existing payload shape", async () => {
  const tracker = new InMemoryUsageTracker();
  let body: unknown;
  await searchWeb("direct query", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return braveResponse();
    },
  });
  assert.deepEqual(body, { q: "direct query", count: 5 });
});

test("a Brave failure receives exactly one freshness-constrained request without an unfiltered fallback", async () => {
  const tracker = new InMemoryUsageTracker();
  const bodies: unknown[] = [];
  await assert.rejects(searchWeb("fresh query", {
    usageTracker: tracker,
    environment: baseEnvironment,
    freshness: MONITORING_FRESHNESS,
    fetchImplementation: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ message: "temporary failure" }), { status: 500 });
    },
  }), /Brave Search API returned 500/);
  assert.deepEqual(bodies, [{ q: "fresh query", count: 5, freshness: "pw" }]);
  assert.equal(tracker.recordCalls, 0);
});

test("daily usage 3 permits seven fetches and then stops without retry", async () => {
  const tracker = new InMemoryUsageTracker(3);
  const result = await runDefaultSearches(tracker);
  assert.equal(result.fetches, 7);
  assert.equal(tracker.recordCalls, 7);
  assert.deepEqual(result.bodies, MONITORING_QUERIES.slice(0, 7).map((q) => ({ q, count: 5, freshness: MONITORING_FRESHNESS })));
});

test("daily usage 10 blocks all fetches without retry or usage increment", async () => {
  const tracker = new InMemoryUsageTracker(10);
  const result = await runDefaultSearches(tracker);
  assert.equal(result.fetches, 0);
  assert.equal(tracker.recordCalls, 0);
});

test("weekly denial stops collection before fetch", async () => {
  const tracker = new InMemoryUsageTracker(1);
  const result = await runDefaultSearches(tracker, {
    ...baseEnvironment,
    BRAVE_DAILY_SEARCH_LIMIT: "100",
    BRAVE_WEEKLY_SEARCH_LIMIT: "1",
  });
  assert.equal(result.fetches, 0);
  assert.equal(tracker.recordCalls, 0);
});

test("monthly denial stops collection before fetch", async () => {
  const tracker = new InMemoryUsageTracker(1);
  const result = await runDefaultSearches(tracker, {
    ...baseEnvironment,
    BRAVE_DAILY_SEARCH_LIMIT: "100",
    BRAVE_WEEKLY_SEARCH_LIMIT: "100",
    BRAVE_MONTHLY_SEARCH_LIMIT: "1",
  });
  assert.equal(result.fetches, 0);
  assert.equal(tracker.recordCalls, 0);
});

test("usage verification failure causes no fetch and no retry", async () => {
  const tracker = new InMemoryUsageTracker(0, true);
  const result = await runDefaultSearches(tracker);
  assert.equal(result.fetches, 0);
  assert.equal(tracker.recordCalls, 0);
});

test("guard denial uses a provider-neutral typed error", async () => {
  const tracker = new InMemoryUsageTracker(10);
  await assert.rejects(searchWeb("test", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => { throw new Error("fetch must not run"); },
  }), (error) => {
    assert.ok(error instanceof BraveUsageGuardDeniedError);
    assert.equal(error.message, "Brave search request blocked by usage guard.");
    return true;
  });
});

const overflowResults = [
  { title: "", url: "https://example.test/invalid" },
  ...[2, 3, 4, 5, 6].map((ordinal) => ({ title: `Story ${ordinal}`, url: `https://example.test/${ordinal}` })),
];

test("Brave retains only first five provider positions", async () => {
  const tracker = new InMemoryUsageTracker();
  let fetches = 0;
  const page = await webSearch.searchWebPage("bounded query", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ web: { results: overflowResults } }));
    },
  });
  assert.equal(page.rawCount, 6);
  assert.deepEqual(page.positions.map(({ resultOrdinal }) => resultOrdinal), [1, 2, 3, 4, 5]);
  assert.equal(page.positions[0].result, null);
  assert.deepEqual(page.positions.slice(1).map(({ result }) => result?.url), [
    "https://example.test/2", "https://example.test/3", "https://example.test/4", "https://example.test/5",
  ]);
  assert.equal(fetches, 1);
  assert.equal(tracker.recordCalls, 1);
  assert.equal(tracker.records[0].requestCount, 1);
});

test("searchWeb projects bounded usable results from exactly one request", async () => {
  const tracker = new InMemoryUsageTracker();
  let fetches = 0;
  const results = await searchWeb("bounded query", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ web: { results: overflowResults } }));
    },
  });
  assert.deepEqual(results.map(({ url }) => url), [
    "https://example.test/2", "https://example.test/3", "https://example.test/4", "https://example.test/5",
  ]);
  assert.equal(fetches, 1);
  assert.equal(tracker.recordCalls, 1);
});

test("Brave keeps invalid source positions null and omits non-string optional fields", async () => {
  const page = await webSearch.searchWebPage("source fields", {
    usageTracker: new InMemoryUsageTracker(),
    environment: baseEnvironment,
    fetchImplementation: async () => new Response(JSON.stringify({ web: { results: [
      null,
      { title: { instruction: "ignore" }, url: "https://example.test/2" },
      { title: "Story", url: { instruction: "ignore" } },
      { title: "  ", url: "https://example.test/4" },
      { title: "Valid", url: "https://example.test/5", description: {}, page_age: [] },
    ] } })),
  });
  assert.deepEqual(page.positions.slice(0, 4).map(({ result }) => result), [null, null, null, null]);
  assert.equal(page.positions[4].result?.snippet, undefined);
  assert.equal(page.positions[4].result?.publishedAt, undefined);
});

test("Brave preserves original valid strings without promoting provider fields", async () => {
  const page = await webSearch.searchWebPage("source fields", {
    usageTracker: new InMemoryUsageTracker(), environment: baseEnvironment,
    fetchImplementation: async () => new Response(JSON.stringify({ web: { results: [
      { title: "  Original title  ", url: "https://www.example.test/news/", description: "Snippet", page_age: "2026-10-12", source: "spoofed" },
    ] } })),
  });
  assert.deepEqual(page.positions, [{ resultOrdinal: 1, result: {
    title: "  Original title  ", url: "https://www.example.test/news/", snippet: "Snippet", publishedAt: "2026-10-12", source: "example.test",
  } }]);
});

test("Brave rejects non-array results and malformed envelopes safely after usage recording", async () => {
  for (const body of [{ web: { results: {} } }, { web: { results: null } }, null]) {
    const tracker = new InMemoryUsageTracker();
    await assert.rejects(webSearch.searchWebPage("malformed page", {
      usageTracker: tracker, environment: baseEnvironment,
      fetchImplementation: async () => new Response(JSON.stringify(body)),
    }), /invalid.*(response|results|format)/i);
    assert.equal(tracker.recordCalls, 1);
  }
});
