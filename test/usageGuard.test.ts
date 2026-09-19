import assert from "node:assert/strict";
import test from "node:test";

import { searchWeb } from "../src/tools/webSearch.js";
import {
  checkBraveSearchUsage,
  evaluateBraveUsage,
  getBraveUsageCounts,
  type BraveUsageLimits
} from "../src/services/usageGuard.js";
import type { UsageRecord, UsageTracker } from "../src/services/usageTracker.js";

const now = new Date("2026-09-17T12:00:00");
const limits: BraveUsageLimits = { daily: 10, weekly: 50, monthly: 200 };

process.env.BRAVE_SEARCH_API_KEY = "test-key";
process.env.BRAVE_DAILY_SEARCH_LIMIT = "10";
process.env.BRAVE_WEEKLY_SEARCH_LIMIT = "50";
process.env.BRAVE_MONTHLY_SEARCH_LIMIT = "200";

function recordsForCount(count: number): UsageRecord[] {
  return [
    {
      timestamp: new Date().toISOString(),
      provider: "brave",
      operation: "web-search",
      requestCount: count
    }
  ];
}

class InMemoryUsageTracker implements UsageTracker {
  public recordCalls = 0;

  constructor(private readonly records: UsageRecord[]) {}

  async getRecords(): Promise<UsageRecord[]> {
    return this.records;
  }

  async recordRequest(record: UsageRecord): Promise<void> {
    this.recordCalls += 1;
    this.records.push(record);
  }
}

test("allows a request below daily, weekly, and monthly limits", () => {
  const counts = { daily: 3, weekly: 20, monthly: 80 };
  assert.equal(evaluateBraveUsage(counts, limits), undefined);
});

test("blocks a request when the daily limit is reached", () => {
  assert.equal(evaluateBraveUsage({ daily: 10, weekly: 20, monthly: 80 }, limits), "daily");
});

test("blocks a request when the weekly limit is reached", () => {
  assert.equal(evaluateBraveUsage({ daily: 3, weekly: 50, monthly: 80 }, limits), "weekly");
});

test("blocks a request when the monthly limit is reached", () => {
  assert.equal(evaluateBraveUsage({ daily: 3, weekly: 20, monthly: 200 }, limits), "monthly");
});

test("blocks when the usage tracker is unavailable", async () => {
  const unavailableTracker: UsageTracker = {
    async getRecords(): Promise<UsageRecord[]> {
      throw new Error("Usage file cannot be read.");
    },
    async recordRequest(): Promise<void> {}
  };

  const result = await checkBraveSearchUsage(unavailableTracker, {
    BRAVE_DAILY_SEARCH_LIMIT: "10",
    BRAVE_WEEKLY_SEARCH_LIMIT: "50",
    BRAVE_MONTHLY_SEARCH_LIMIT: "200"
  });

  assert.equal(result.allowed, false);
});

test("blocks when a Brave usage limit is invalid", async () => {
  const tracker = new InMemoryUsageTracker([]);
  const result = await checkBraveSearchUsage(tracker, {
    BRAVE_DAILY_SEARCH_LIMIT: "0",
    BRAVE_WEEKLY_SEARCH_LIMIT: "50",
    BRAVE_MONTHLY_SEARCH_LIMIT: "200"
  });

  assert.equal(result.allowed, false);
});

test("a blocked request does not call Brave or increment usage", async () => {
  const tracker = new InMemoryUsageTracker(recordsForCount(10));
  let fetchCalled = false;

  await assert.rejects(
    searchWeb("test query", {
      usageTracker: tracker,
      fetchImplementation: async () => {
        fetchCalled = true;
        return new Response();
      }
    }),
    /blocked by usage guard/
  );

  assert.equal(fetchCalled, false);
  assert.equal(tracker.recordCalls, 0);
  assert.deepEqual(getBraveUsageCounts(recordsForCount(10)), {
    daily: 10,
    weekly: 10,
    monthly: 10
  });
});
