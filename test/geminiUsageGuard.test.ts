import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_GEMINI_MODELS, type ApprovedGeminiModel } from "../src/config/geminiModels.js";
import { checkGeminiUsage, reachedGeminiLimit, type GeminiUsageLimits } from "../src/services/geminiUsageGuard.js";
import type { GeminiUsageData, GeminiUsageRecord, GeminiUsageReservation, GeminiUsageSettlement, GeminiUsageTracker } from "../src/services/geminiUsageTracker.js";
import { createGeminiCycleContext, generateWithGemini, MAX_GEMINI_ATTEMPTS_PER_ANALYSIS } from "../src/tools/llm/gemini.js";

const limits: GeminiUsageLimits = { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 };
const env = { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "ignored-model", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50", GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000" };
const highLimitEnv = { ...env, GEMINI_DAILY_REQUEST_LIMIT: "100", GEMINI_WEEKLY_REQUEST_LIMIT: "100", GEMINI_MONTHLY_REQUEST_LIMIT: "100" };
Object.assign(process.env, env);

class MemoryTracker implements GeminiUsageTracker {
  recordCalls = 0;
  settlementCalls = 0;
  constructor(public data: GeminiUsageData, private readonly failSettlement = false) {}
  async getUsageData() { return structuredClone(this.data); }
  async recordRequest(record: GeminiUsageRecord) { this.recordCalls++; this.data.records.push(structuredClone(record)); }
  async markUsageUnknown() { this.data.usageUnknown = true; }
  async reserveRequest(record: GeminiUsageRecord & { model: ApprovedGeminiModel }): Promise<GeminiUsageReservation> {
    if (this.data.usageUnknown) throw new Error("unknown");
    const id = `memory:${this.data.records.length}`;
    this.recordCalls++;
    this.data.records.push(structuredClone(record));
    this.data.usageUnknown = true;
    return { id, record: structuredClone(record) };
  }
  async settleRequest(reservation: GeminiUsageReservation, usage: GeminiUsageSettlement) {
    if (this.failSettlement) throw new Error("settlement failed");
    const index = Number(reservation.id.split(":")[1]);
    assert.equal(this.data.usageUnknown, true);
    assert.deepEqual(this.data.records[index], reservation.record);
    this.data.records[index] = { ...this.data.records[index]!, ...usage };
    this.data.usageUnknown = false;
    this.settlementCalls++;
  }
}

const counts = (patch: Partial<GeminiUsageLimits>) => ({ dailyRequests: 1, weeklyRequests: 1, monthlyRequests: 1, dailyTokens: 1, weeklyTokens: 1, monthlyTokens: 1, ...patch });
const jsonResponse = (body: unknown, status = 200, statusText = "OK") => new Response(JSON.stringify(body), { status, statusText, headers: { "Content-Type": "application/json" } });
const successfulBody = { steps: [{ type: "model_output", content: [{ type: "text", text: "GEMINI_OK" }] }], usage: { total_input_tokens: 9, total_output_tokens: 4, total_thought_tokens: 99, total_tokens: 112 } };
const unavailable = () => jsonResponse({ error: { status: "UNAVAILABLE", message: "Unavailable" } }, 503, "Service Unavailable");
const modelQuota = (model: ApprovedGeminiModel) => jsonResponse({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exhausted", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaDimensions: { model, location: "global" } }] }] } }, 429, "Too Many Requests");
const requestedModel = (init?: RequestInit) => JSON.parse(String(init?.body)).model as ApprovedGeminiModel;

test("allows below all Gemini limits", () => assert.equal(reachedGeminiLimit(counts({ dailyRequests: 2, weeklyRequests: 10, monthlyRequests: 20, dailyTokens: 3_000, weeklyTokens: 9_000, monthlyTokens: 20_000 }), limits), undefined));
test("blocks each reached request limit", () => { assert.equal(reachedGeminiLimit(counts({ dailyRequests: 5 }), limits), "daily request"); assert.equal(reachedGeminiLimit(counts({ weeklyRequests: 20 }), limits), "weekly request"); assert.equal(reachedGeminiLimit(counts({ monthlyRequests: 50 }), limits), "monthly request"); });
test("blocks each reached token limit", () => { assert.equal(reachedGeminiLimit(counts({ dailyTokens: 10_000 }), limits), "daily token"); assert.equal(reachedGeminiLimit(counts({ weeklyTokens: 30_000 }), limits), "weekly token"); assert.equal(reachedGeminiLimit(counts({ monthlyTokens: 100_000 }), limits), "monthly token"); });
test("blocks invalid configuration and unavailable tracker", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  assert.equal((await checkGeminiUsage(tracker, { ...env, GEMINI_DAILY_TOKEN_LIMIT: "0" })).allowed, false);
  const broken = new MemoryTracker({ records: [], usageUnknown: false });
  broken.getUsageData = async () => { throw new Error("broken"); };
  assert.equal((await checkGeminiUsage(broken, env)).allowed, false);
});

test("blocked requests never call fetch or reserve usage", async () => {
  const tracker = new MemoryTracker({ usageUnknown: false, records: [{ timestamp: new Date().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1, inputTokens: 10_000, outputTokens: 0, totalTokens: 10_000, model: "gemini-3.8-flash" }] });
  let called = false;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => { called = true; return jsonResponse(successfulBody); }) as typeof fetch }), /blocked by usage guard/);
  assert.equal(called, false);
  assert.equal(tracker.recordCalls, 0);
});

test("3.8 succeeds first, records exact model and never calls later models", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const models: string[] = [];
  const result = await generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async (_url, init) => { models.push(requestedModel(init)); return jsonResponse(successfulBody); }) as typeof fetch });
  assert.equal(result.outputText, "GEMINI_OK");
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 4, thoughtTokens: 99, totalTokens: 112 });
  assert.deepEqual(models, ["gemini-3.8-flash"]);
  assert.equal(tracker.data.records[0]?.model, "gemini-3.8-flash");
  assert.equal(tracker.data.usageUnknown, false);
});

test("3.8 exhausts its P0 503 retries before falling forward to 3.6", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const models: string[] = [];
  const context = createGeminiCycleContext();
  const result = await generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, retryDelayMs: 0, cycleContext: context, fetchImplementation: (async (_url, init) => {
    const model = requestedModel(init); models.push(model); return model === "gemini-3.8-flash" ? unavailable() : jsonResponse(successfulBody);
  }) as typeof fetch });
  assert.equal(result.outputText, "GEMINI_OK");
  assert.equal(result.usedFallback, true);
  assert.deepEqual(models, ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.6-flash"]);
  assert.equal(context.fallbacks, 1);
  assert.equal(context.analysesUsingFallbackModel, 0);
});

test("a structurally model-specific 429 advances immediately", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const models: ApprovedGeminiModel[] = [];
  await generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async (_url, init) => {
    const model = requestedModel(init); models.push(model); return model === "gemini-3.8-flash" ? modelQuota(model) : jsonResponse(successfulBody);
  }) as typeof fetch });
  assert.deepEqual(models, ["gemini-3.8-flash", "gemini-3.6-flash"]);
});

test("ambiguous or shared 429 is terminal and does not fallback", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async () => {
    calls++; return jsonResponse({ error: { status: "RESOURCE_EXHAUSTED", message: "Shared project quota" } }, 429, "Too Many Requests");
  }) as typeof fetch }), /HTTP 429/);
  assert.equal(calls, 1);
});

test("3.8 and 3.6 unavailable can reach 3.5 Flash Lite and stop on success", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const models: ApprovedGeminiModel[] = [];
  await generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, retryDelayMs: 0, fetchImplementation: (async (_url, init) => {
    const model = requestedModel(init); models.push(model); return model === "gemini-3.5-flash-lite" ? jsonResponse(successfulBody) : unavailable();
  }) as typeof fetch });
  assert.equal(models.length, 9);
  assert.deepEqual(models.slice(0, 4), Array(4).fill("gemini-3.8-flash"));
  assert.deepEqual(models.slice(4, 8), Array(4).fill("gemini-3.6-flash"));
  assert.equal(models[8], "gemini-3.5-flash-lite");
});

test("authentication, permission, invalid request, and policy failures never fallback", async (t) => {
  for (const item of [{ status: 400, provider: "INVALID_ARGUMENT" }, { status: 401, provider: "UNAUTHENTICATED" }, { status: 403, provider: "PERMISSION_DENIED" }, { status: 403, provider: "SAFETY" }]) {
    await t.test(String(item.provider), async () => {
      const tracker = new MemoryTracker({ records: [], usageUnknown: false });
      let calls = 0;
      await assert.rejects(generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async () => { calls++; return jsonResponse({ error: { status: item.provider, message: item.provider } }, item.status, "Rejected"); }) as typeof fetch }), new RegExp(`HTTP ${item.status}`));
      assert.equal(calls, 1);
    });
  }
});

test("a successful malformed output is returned once without model hopping", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  const result = await generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => { calls++; return jsonResponse({ output_text: "not-json", usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 } }); }) as typeof fetch });
  assert.equal(result.outputText, "not-json");
  assert.equal(calls, 1);
});

test("all approved models unavailable fail once at the absolute 12-attempt bound", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const context = createGeminiCycleContext();
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, cycleContext: context, retryDelayMs: 0, fetchImplementation: (async () => unavailable()) as typeof fetch }), /HTTP 503/);
  assert.equal(MAX_GEMINI_ATTEMPTS_PER_ANALYSIS, 12);
  assert.equal(context.providerAttempts, 12);
  assert.deepEqual(context.requestsByModel, { "gemini-3.8-flash": 4, "gemini-3.6-flash": 4, "gemini-3.5-flash-lite": 4 });
  assert.equal(context.fallbacks, 2);
});

test("the production request ceiling interrupts fallback before a sixth attempt", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const context = createGeminiCycleContext();
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, cycleContext: context, retryDelayMs: 0, fetchImplementation: (async () => unavailable()) as typeof fetch }), /blocked by (usage guard|frozen cycle request allowance)/);
  assert.equal(context.providerAttempts, 5);
});

test("transport ambiguity preserves exact-model reservation and blocks later requests", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => { throw new Error("network unavailable"); }) as typeof fetch }), /network unavailable/);
  assert.equal(tracker.recordCalls, 1);
  assert.equal(tracker.data.records[0]?.model, "gemini-3.8-flash");
  assert.equal(tracker.data.usageUnknown, true);
});

test("timeout ambiguity preserves the reservation and does not fallback", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, timeoutMs: 1, fetchImplementation: (async (_url, init) => {
    calls++;
    const signal = init?.signal as AbortSignal;
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    throw new Error("unreachable");
  }) as typeof fetch }), /timed out after 30 seconds/);
  assert.equal(calls, 1);
  assert.equal(tracker.data.usageUnknown, true);
  assert.equal(tracker.data.records[0]?.model, "gemini-3.8-flash");
});

test("invalid successful JSON leaves accounting unknown and never model-hops", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => {
    calls++;
    return new Response("not-json", { status: 200 });
  }) as typeof fetch }), /not valid JSON/);
  assert.equal(calls, 1);
  assert.equal(tracker.data.usageUnknown, true);
});

test("settlement uncertainty fails safely without fallback", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false }, true);
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => { calls++; return jsonResponse(successfulBody); }) as typeof fetch }), /usage could not be recorded safely/);
  assert.equal(calls, 1);
  assert.equal(tracker.data.usageUnknown, true);
});

test("historical usage without model remains valid and counts globally", async () => {
  const tracker = new MemoryTracker({ usageUnknown: false, records: [{ timestamp: new Date().toISOString(), provider: "gemini", operation: "minimal-test", requestCount: 1, inputTokens: 1, outputTokens: 1, totalTokens: 3 }] });
  const check = await checkGeminiUsage(tracker, env);
  assert.equal(check.allowed, true);
  if (check.allowed) assert.equal(check.counts.dailyRequests, 1);
  assert.deepEqual(APPROVED_GEMINI_MODELS, ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]);
});

test("historical attribution remains readable after a model leaves the approved pool", async () => {
  const tracker = new MemoryTracker({ usageUnknown: false, records: [{
    timestamp: new Date().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1,
    inputTokens: 1, outputTokens: 1, totalTokens: 2, model: "retired-historical-model",
  }] });
  const check = await checkGeminiUsage(tracker, env);
  assert.equal(check.allowed, true);
  if (check.allowed) assert.equal(check.counts.dailyRequests, 1);
});
