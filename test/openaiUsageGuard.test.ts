import assert from "node:assert/strict";
import test from "node:test";

import { analyzeWithOpenAI } from "../src/tools/openai.js";
import {
  checkOpenAIUsage,
  getReachedOpenAILimit,
  type OpenAIUsageLimits
} from "../src/services/openaiUsageGuard.js";
import type {
  OpenAIUsageData,
  OpenAIUsageRecord,
  OpenAIUsageTracker
} from "../src/services/openaiUsageTracker.js";

const limits: OpenAIUsageLimits = {
  dailyRequests: 5,
  weeklyRequests: 20,
  monthlyRequests: 50,
  dailyTokens: 10_000,
  weeklyTokens: 30_000,
  monthlyTokens: 100_000
};

const environment = {
  OPENAI_API_KEY: "test-key",
  OPENAI_MODEL: "gpt-5.6-luna",
  OPENAI_DAILY_REQUEST_LIMIT: "5",
  OPENAI_WEEKLY_REQUEST_LIMIT: "20",
  OPENAI_MONTHLY_REQUEST_LIMIT: "50",
  OPENAI_DAILY_TOKEN_LIMIT: "10000",
  OPENAI_WEEKLY_TOKEN_LIMIT: "30000",
  OPENAI_MONTHLY_TOKEN_LIMIT: "100000"
};

Object.assign(process.env, environment);

class InMemoryOpenAIUsageTracker implements OpenAIUsageTracker {
  public recordCalls = 0;
  public usageUnknownCalls = 0;

  constructor(private data: OpenAIUsageData) {}

  async getUsageData(): Promise<OpenAIUsageData> {
    return this.data;
  }

  async recordRequest(record: OpenAIUsageRecord): Promise<void> {
    this.recordCalls += 1;
    this.data = { ...this.data, records: [...this.data.records, record] };
  }

  async markUsageUnknown(): Promise<void> {
    this.usageUnknownCalls += 1;
    this.data = { ...this.data, usageUnknown: true };
  }
}

function usageDataWith(record: Partial<OpenAIUsageRecord>): OpenAIUsageData {
  return {
    usageUnknown: false,
    records: [
      {
        timestamp: new Date().toISOString(),
        provider: "openai",
        operation: "minimal-test",
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        ...record
      }
    ]
  };
}

test("allows a request below all limits", () => {
  assert.equal(getReachedOpenAILimit({ dailyRequests: 2, weeklyRequests: 10, monthlyRequests: 20, dailyTokens: 3_400, weeklyTokens: 10_000, monthlyTokens: 30_000 }, limits), undefined);
});

test("blocks reached request and token limits", () => {
  assert.equal(getReachedOpenAILimit({ dailyRequests: 5, weeklyRequests: 1, monthlyRequests: 1, dailyTokens: 1, weeklyTokens: 1, monthlyTokens: 1 }, limits), "daily request");
  assert.equal(getReachedOpenAILimit({ dailyRequests: 1, weeklyRequests: 20, monthlyRequests: 1, dailyTokens: 1, weeklyTokens: 1, monthlyTokens: 1 }, limits), "weekly request");
  assert.equal(getReachedOpenAILimit({ dailyRequests: 1, weeklyRequests: 1, monthlyRequests: 50, dailyTokens: 1, weeklyTokens: 1, monthlyTokens: 1 }, limits), "monthly request");
  assert.equal(getReachedOpenAILimit({ dailyRequests: 1, weeklyRequests: 1, monthlyRequests: 1, dailyTokens: 10_000, weeklyTokens: 1, monthlyTokens: 1 }, limits), "daily token");
  assert.equal(getReachedOpenAILimit({ dailyRequests: 1, weeklyRequests: 1, monthlyRequests: 1, dailyTokens: 1, weeklyTokens: 30_000, monthlyTokens: 1 }, limits), "weekly token");
  assert.equal(getReachedOpenAILimit({ dailyRequests: 1, weeklyRequests: 1, monthlyRequests: 1, dailyTokens: 1, weeklyTokens: 1, monthlyTokens: 100_000 }, limits), "monthly token");
});

test("blocks invalid configuration and unavailable trackers", async () => {
  const tracker = new InMemoryOpenAIUsageTracker({ records: [], usageUnknown: false });
  const invalid = await checkOpenAIUsage(tracker, { ...environment, OPENAI_DAILY_TOKEN_LIMIT: "0" });
  assert.equal(invalid.allowed, false);

  const unavailable: OpenAIUsageTracker = {
    async getUsageData(): Promise<OpenAIUsageData> {
      throw new Error("Unavailable");
    },
    async recordRequest(): Promise<void> {},
    async markUsageUnknown(): Promise<void> {}
  };
  const unavailableResult = await checkOpenAIUsage(unavailable, environment);
  assert.equal(unavailableResult.allowed, false);
});

test("a blocked request does not call OpenAI or record usage", async () => {
  const tracker = new InMemoryOpenAIUsageTracker(usageDataWith({ inputTokens: 10_000, outputTokens: 0, totalTokens: 10_000 }));
  let called = false;

  await assert.rejects(
    analyzeWithOpenAI("test", {
      usageTracker: tracker,
      createResponse: async () => {
        called = true;
        return { output_text: "OPENAI_OK", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      }
    }),
    /blocked by usage guard/
  );

  assert.equal(called, false);
  assert.equal(tracker.recordCalls, 0);
});

test("a successful request records actual token usage", async () => {
  const tracker = new InMemoryOpenAIUsageTracker({ records: [], usageUnknown: false });
  const result = await analyzeWithOpenAI("test", {
    usageTracker: tracker,
    createResponse: async () => ({
      output_text: "OPENAI_OK",
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }
    })
  });

  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  assert.equal(tracker.recordCalls, 1);
  assert.deepEqual((await tracker.getUsageData()).records[0]?.totalTokens, 15);
});
