import assert from "node:assert/strict";
import test from "node:test";
import { generateWithGemini } from "../src/tools/llm/gemini.js";
import { checkGeminiUsage, reachedGeminiLimit, type GeminiUsageLimits } from "../src/services/geminiUsageGuard.js";
import type { GeminiUsageData, GeminiUsageRecord, GeminiUsageTracker } from "../src/services/geminiUsageTracker.js";

const limits: GeminiUsageLimits = { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 };
const env = { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-3.6-flash", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50", GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000" };
Object.assign(process.env, env);

class MemoryTracker implements GeminiUsageTracker {
  recordCalls = 0;
  constructor(private data: GeminiUsageData) {}
  async getUsageData() { return this.data; }
  async recordRequest(record: GeminiUsageRecord) { this.recordCalls++; this.data = { ...this.data, records: [...this.data.records, record] }; }
  async markUsageUnknown() { this.data = { ...this.data, usageUnknown: true }; }
}

const counts = (patch: Partial<GeminiUsageLimits>) => ({ dailyRequests: 1, weeklyRequests: 1, monthlyRequests: 1, dailyTokens: 1, weeklyTokens: 1, monthlyTokens: 1, ...patch });
const jsonResponse = (body: unknown, status = 200, statusText = "OK") => new Response(JSON.stringify(body), { status, statusText, headers: { "Content-Type": "application/json" } });
const successfulBody = { steps: [{ type: "model_output", content: [{ type: "text", text: "GEMINI_OK" }] }], usage: { total_input_tokens: 9, total_output_tokens: 4, total_thought_tokens: 99, total_tokens: 112 } };

test("allows below all Gemini limits", () => assert.equal(reachedGeminiLimit(counts({ dailyRequests: 2, weeklyRequests: 10, monthlyRequests: 20, dailyTokens: 3_000, weeklyTokens: 9_000, monthlyTokens: 20_000 }), limits), undefined));
test("blocks each reached request limit", () => { assert.equal(reachedGeminiLimit(counts({ dailyRequests: 5 }), limits), "daily request"); assert.equal(reachedGeminiLimit(counts({ weeklyRequests: 20 }), limits), "weekly request"); assert.equal(reachedGeminiLimit(counts({ monthlyRequests: 50 }), limits), "monthly request"); });
test("blocks each reached token limit", () => { assert.equal(reachedGeminiLimit(counts({ dailyTokens: 10_000 }), limits), "daily token"); assert.equal(reachedGeminiLimit(counts({ weeklyTokens: 30_000 }), limits), "weekly token"); assert.equal(reachedGeminiLimit(counts({ monthlyTokens: 100_000 }), limits), "monthly token"); });
test("blocks invalid configuration and unavailable tracker", async () => { const tracker = new MemoryTracker({ records: [], usageUnknown: false }); assert.equal((await checkGeminiUsage(tracker, { ...env, GEMINI_DAILY_TOKEN_LIMIT: "0" })).allowed, false); const broken: GeminiUsageTracker = { async getUsageData() { throw new Error("broken"); }, async recordRequest() {}, async markUsageUnknown() {} }; assert.equal((await checkGeminiUsage(broken, env)).allowed, false); });
test("blocked requests never call fetch or increment usage", async () => {
  const tracker = new MemoryTracker({ usageUnknown: false, records: [{ timestamp: new Date().toISOString(), provider: "gemini", operation: "minimal-test", requestCount: 1, inputTokens: 10_000, outputTokens: 0, totalTokens: 10_000 }] });
  let called = false;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => { called = true; return jsonResponse(successfulBody); }) as typeof fetch }), /blocked by usage guard/);
  assert.equal(called, false);
  assert.equal(tracker.recordCalls, 0);
});
test("parses step-based output and thinking-inclusive token usage", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const result = await generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => jsonResponse(successfulBody)) as typeof fetch });
  assert.equal(result.outputText, "GEMINI_OK");
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 4, thoughtTokens: 99, totalTokens: 112 });
  assert.equal(tracker.recordCalls, 1);
});
test("uses output_text when provided", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const result = await generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => jsonResponse({ output_text: "GEMINI_OK", usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 } })) as typeof fetch });
  assert.equal(result.outputText, "GEMINI_OK");
});
test("does not record an HTTP error", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => jsonResponse({ error: { message: "Invalid request" } }, 400, "Bad Request")) as typeof fetch }), /HTTP 400 Bad Request: Invalid request/);
  assert.equal(tracker.recordCalls, 0);
});
test("does not record a network error", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => { throw new Error("network unavailable"); }) as typeof fetch }), /network unavailable/);
  assert.equal(tracker.recordCalls, 0);
});
test("does not record an aborted request", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, timeoutMs: 1, fetchImplementation: (async (_url, init) => {
    const signal = init?.signal as AbortSignal;
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    throw new Error("unreachable");
  }) as typeof fetch }), /Gemini request timed out after 30 seconds/);
  assert.equal(tracker.recordCalls, 0);
});
