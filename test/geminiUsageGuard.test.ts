import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_GEMINI_MODELS, type ApprovedGeminiModel } from "../src/config/geminiModels.js";
import { checkGeminiUsage, getGeminiUsageCounts, inspectGeminiAvailability, reachedGeminiLimit, type GeminiBlockedReason, type GeminiUsageLimits } from "../src/services/geminiUsageGuard.js";
import type { GeminiAmbiguityReason, GeminiAmbiguityRetirementExpectation, GeminiReservedReconciliationExpectation, GeminiUsageAdmission, GeminiUsageData, GeminiUsageRecord, GeminiUsageReservation, GeminiUsageSettlement, GeminiUsageTracker } from "../src/services/geminiUsageTracker.js";
import { createGeminiCycleContext, GEMINI_TIMEOUT_MS, generateWithGemini, MAX_GEMINI_ATTEMPTS_PER_ANALYSIS } from "../src/tools/llm/gemini.js";

const limits: GeminiUsageLimits = { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 };
const env = { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "ignored-model", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50", GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000" };
const highLimitEnv = { ...env, GEMINI_DAILY_REQUEST_LIMIT: "100", GEMINI_WEEKLY_REQUEST_LIMIT: "100", GEMINI_MONTHLY_REQUEST_LIMIT: "100" };
Object.assign(process.env, env);

class MemoryTracker implements GeminiUsageTracker {
  recordCalls = 0;
  settlementCalls = 0;
  constructor(public data: GeminiUsageData, private readonly failSettlement = false, private readonly accountingNow = () => new Date()) {}
  private accountingTime(reservation: GeminiUsageReservation): string {
    return new Date(Math.max(this.accountingNow().getTime(), new Date(reservation.record.timestamp).getTime())).toISOString();
  }
  async getUsageData() { return structuredClone(this.data); }
  async recordRequest(record: GeminiUsageRecord) { this.recordCalls++; this.data.records.push(structuredClone(record)); }
  async markUsageUnknown() { this.data.usageUnknown = true; }
  async reserveRequest(record: GeminiUsageRecord & { model: ApprovedGeminiModel }, _admission: GeminiUsageAdmission): Promise<GeminiUsageReservation> {
    if (this.data.usageUnknown || this.data.records.some((item) => ["reserved", "transport_ambiguous"].includes(item.accountingStatus ?? "legacy"))) throw new Error("unknown");
    const id = `memory:${this.data.records.length}`;
    this.recordCalls++;
    const reserved = { ...structuredClone(record), id: this.data.records.length + 1,
      accountingStatus: "reserved" as const, accountingThrough: record.timestamp };
    this.data.records.push(reserved);
    return { id, record: structuredClone(reserved) };
  }
  async settleRequest(reservation: GeminiUsageReservation, usage: GeminiUsageSettlement) {
    if (this.failSettlement) throw new Error("settlement failed");
    const index = Number(reservation.id.split(":")[1]);
    assert.deepEqual(this.data.records[index], reservation.record);
    const settledAt = this.accountingTime(reservation);
    this.data.records[index] = { ...this.data.records[index]!, ...usage, accountingStatus: "exact", settledAt, accountingThrough: settledAt };
    this.settlementCalls++;
  }
  async confirmZeroRequest(reservation: GeminiUsageReservation) {
    const index = Number(reservation.id.split(":")[1]);
    assert.deepEqual(this.data.records[index], reservation.record);
    const settledAt = this.accountingTime(reservation);
    this.data.records[index] = { ...this.data.records[index]!, accountingStatus: "confirmed_zero", settledAt, accountingThrough: settledAt };
    this.settlementCalls++;
  }
  async markRequestAmbiguous(reservation: GeminiUsageReservation, reason: GeminiAmbiguityReason) {
    const index = Number(reservation.id.split(":")[1]);
    const record = this.data.records[index];
    if (!record || record.accountingStatus !== "reserved") throw new Error("not owned");
    this.data.records[index] = { ...record, accountingStatus: "transport_ambiguous", ambiguityReason: reason,
      accountingThrough: this.accountingTime(reservation) };
  }
  async reconcileAbandonedReservation(expectation: GeminiReservedReconciliationExpectation) {
    const index = this.data.records.findIndex((record) => record.id === expectation.id);
    const record = this.data.records[index];
    if (!record || record.accountingStatus !== "reserved") throw new Error("not reserved");
    this.data.records[index] = { ...record, accountingStatus: "transport_ambiguous", ambiguityReason: "abandoned_reservation",
      accountingThrough: this.accountingNow().toISOString() };
    return "reconciled" as const;
  }
  async retireAmbiguousRequest(expectation: GeminiAmbiguityRetirementExpectation) {
    const index = this.data.records.findIndex((record) => record.id === expectation.id);
    const record = this.data.records[index];
    if (!record || record.accountingStatus !== "transport_ambiguous") throw new Error("not ambiguous");
    this.data.records[index] = { ...record, accountingStatus: "retired_outside_accounting_windows", retiredAt: new Date().toISOString() };
    return "retired" as const;
  }
}

const counts = (patch: Partial<GeminiUsageLimits>) => ({ dailyRequests: 1, weeklyRequests: 1, monthlyRequests: 1, dailyTokens: 1, weeklyTokens: 1, monthlyTokens: 1, ...patch });
const jsonResponse = (body: unknown, status = 200, statusText = "OK") => new Response(JSON.stringify(body), { status, statusText, headers: { "Content-Type": "application/json" } });
const successfulBody = { steps: [{ type: "model_output", content: [{ type: "text", text: "GEMINI_OK" }] }], usage: { total_input_tokens: 9, total_output_tokens: 4, total_thought_tokens: 99, total_tokens: 112 } };
const unavailable = () => jsonResponse({ error: { status: "UNAVAILABLE", message: "Unavailable" } }, 503, "Service Unavailable");
const quotaViolation = (model?: ApprovedGeminiModel) => ({ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaDimensions: model === undefined ? { location: "global" } : { model, location: "global" } });
const quotaFailure = (...violations: unknown[]) => ({ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations });
const helpDetail = { "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Quota documentation", url: "https://example.invalid/quota" }] };
const retryInfoDetail = { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "60s" };
const modelQuota = (details: unknown[], message = "Quota exhausted") => jsonResponse({ error: { status: "RESOURCE_EXHAUSTED", message, details } }, 429, "Too Many Requests");
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

test("read-only availability inspector reports every distinct blocked reason without reservation or mutation", async () => {
  const now = new Date("2026-10-07T08:00:00.000Z");
  const record = (totalTokens = 1): GeminiUsageRecord => ({
    timestamp: now.toISOString(), provider: "gemini", operation: "analysis", requestCount: 1,
    inputTokens: 0, outputTokens: 0, totalTokens, model: "gemini-3.8-flash",
  });
  const blockedCases: Array<{ reason: GeminiBlockedReason; data: GeminiUsageData; environment: typeof env }> = [
    { reason: "usage_unknown", data: { records: [], usageUnknown: true }, environment: env },
    { reason: "daily_request_limit", data: { records: [record()], usageUnknown: false }, environment: { ...env, GEMINI_DAILY_REQUEST_LIMIT: "1" } },
    { reason: "weekly_request_limit", data: { records: [record()], usageUnknown: false }, environment: { ...env, GEMINI_DAILY_REQUEST_LIMIT: "2", GEMINI_WEEKLY_REQUEST_LIMIT: "1" } },
    { reason: "monthly_request_limit", data: { records: [record()], usageUnknown: false }, environment: { ...env, GEMINI_DAILY_REQUEST_LIMIT: "2", GEMINI_WEEKLY_REQUEST_LIMIT: "2", GEMINI_MONTHLY_REQUEST_LIMIT: "1" } },
    { reason: "daily_token_limit", data: { records: [record(10)], usageUnknown: false }, environment: { ...env, GEMINI_DAILY_REQUEST_LIMIT: "2", GEMINI_WEEKLY_REQUEST_LIMIT: "2", GEMINI_MONTHLY_REQUEST_LIMIT: "2", GEMINI_DAILY_TOKEN_LIMIT: "10" } },
    { reason: "weekly_token_limit", data: { records: [record(10)], usageUnknown: false }, environment: { ...env, GEMINI_DAILY_REQUEST_LIMIT: "2", GEMINI_WEEKLY_REQUEST_LIMIT: "2", GEMINI_MONTHLY_REQUEST_LIMIT: "2", GEMINI_DAILY_TOKEN_LIMIT: "11", GEMINI_WEEKLY_TOKEN_LIMIT: "10" } },
    { reason: "monthly_token_limit", data: { records: [record(10)], usageUnknown: false }, environment: { ...env, GEMINI_DAILY_REQUEST_LIMIT: "2", GEMINI_WEEKLY_REQUEST_LIMIT: "2", GEMINI_MONTHLY_REQUEST_LIMIT: "2", GEMINI_DAILY_TOKEN_LIMIT: "11", GEMINI_WEEKLY_TOKEN_LIMIT: "11", GEMINI_MONTHLY_TOKEN_LIMIT: "10" } },
    { reason: "usage_state_unavailable", data: { records: [], usageUnknown: false }, environment: env },
    { reason: "invalid_configuration", data: { records: [], usageUnknown: false }, environment: { ...env, GEMINI_API_KEY: "" } },
  ];

  for (const blocked of blockedCases) {
    let reads = 0;
    const reader = {
      async getUsageData() {
        reads += 1;
        if (blocked.reason === "usage_state_unavailable") throw new Error("unavailable");
        return structuredClone(blocked.data);
      },
    };
    const availability = await inspectGeminiAvailability(reader, blocked.environment, now);
    assert.deepEqual(availability, { allowed: false, reason: blocked.reason });
    assert.equal(reads, blocked.reason === "invalid_configuration" ? 0 : 1);
  }
});

test("availability inspection is read-only and a later dispatch guard still fails closed after state changes", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const initial = await inspectGeminiAvailability(tracker, env);
  assert.equal(initial.allowed, true);
  assert.equal(tracker.recordCalls, 0);
  assert.equal(tracker.settlementCalls, 0);

  tracker.data.usageUnknown = true;
  let fetchCalls = 0;
  await assert.rejects(generateWithGemini("test", {
    usageTracker: tracker,
    fetchImplementation: (async () => { fetchCalls += 1; return jsonResponse(successfulBody); }) as typeof fetch,
  }), /blocked by usage guard/);
  assert.equal(fetchCalls, 0);
  assert.equal(tracker.recordCalls, 0);
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
  assert.equal(tracker.data.records[0]?.accountingStatus, "exact");
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
  assert.deepEqual(tracker.data.records.map((record) => record.accountingStatus), ["confirmed_zero", "confirmed_zero", "confirmed_zero", "confirmed_zero", "exact"]);
  assert.equal(context.fallbacks, 1);
  assert.equal(context.analysesUsingFallbackModel, 0);
});

test("a model-specific 429 permits Help and RetryInfo companions and advances immediately", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const models: ApprovedGeminiModel[] = [];
  await generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async (_url, init) => {
    const model = requestedModel(init); models.push(model); return model === "gemini-3.8-flash"
      ? modelQuota([helpDetail, quotaFailure(quotaViolation(model)), retryInfoDetail])
      : jsonResponse(successfulBody);
  }) as typeof fetch });
  assert.deepEqual(models, ["gemini-3.8-flash", "gemini-3.6-flash"]);
});

test("Help and RetryInfo without a QuotaFailure are terminal even when the message names the model", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async () => {
    calls++;
    return modelQuota([helpDetail, retryInfoDetail], "gemini-3.8-flash quota exhausted");
  }) as typeof fetch }), /HTTP 429/);
  assert.equal(calls, 1);
});

test("a QuotaFailure attributed to another model is terminal", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async () => {
    calls++;
    return modelQuota([quotaFailure(quotaViolation("gemini-3.6-flash"))]);
  }) as typeof fetch }), /HTTP 429/);
  assert.equal(calls, 1);
});

test("a QuotaFailure without quotaDimensions.model is terminal", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async () => {
    calls++;
    return modelQuota([quotaFailure(quotaViolation())]);
  }) as typeof fetch }), /HTTP 429/);
  assert.equal(calls, 1);
});

test("a QuotaFailure without quotaMetric or quotaId is terminal", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async () => {
    calls++;
    return modelQuota([quotaFailure({ quotaDimensions: { model: "gemini-3.8-flash" } })]);
  }) as typeof fetch }), /HTTP 429/);
  assert.equal(calls, 1);
});

test("an unknown companion detail makes an otherwise valid QuotaFailure terminal", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async () => {
    calls++;
    return modelQuota([quotaFailure(quotaViolation("gemini-3.8-flash")), { "@type": "type.googleapis.com/google.rpc.UnknownMetadata" }]);
  }) as typeof fetch }), /HTTP 429/);
  assert.equal(calls, 1);
});

test("multiple matching QuotaFailure details permit fallback", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const models: ApprovedGeminiModel[] = [];
  await generateWithGemini("test", { usageTracker: tracker, environment: highLimitEnv, fetchImplementation: (async (_url, init) => {
    const model = requestedModel(init);
    models.push(model);
    return model === "gemini-3.8-flash"
      ? modelQuota([quotaFailure(quotaViolation(model)), quotaFailure({ quotaId: "requests-per-model", quotaDimensions: { model } })])
      : jsonResponse(successfulBody);
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
      assert.equal(tracker.data.records[0]?.accountingStatus, "transport_ambiguous");
      assert.equal(tracker.data.records[0]?.ambiguityReason, "response_usage_unavailable");
    });
  }
});

test("a reservation that crosses an accounting boundary is abandoned before provider dispatch", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const instants = [
    new Date("2026-10-31T23:59:59.999Z"),
    new Date("2026-10-31T23:59:59.999Z"),
    new Date("2026-11-01T00:00:00.000Z"),
  ];
  let fetchCalls = 0;
  await assert.rejects(generateWithGemini("test", {
    usageTracker: tracker,
    now: () => instants.shift() ?? new Date("2026-11-01T00:00:00.000Z"),
    fetchImplementation: (async () => {
      fetchCalls++;
      return jsonResponse(successfulBody);
    }) as typeof fetch,
  }), /accounting window changed/);
  assert.equal(fetchCalls, 0);
  assert.equal(tracker.data.records[0]?.accountingStatus, "transport_ambiguous");
  assert.equal(tracker.data.records[0]?.ambiguityReason, "abandoned_reservation");
});

test("durable accounting intervals cover day, week, and month crossings at the final dispatch handoff", async (t) => {
  for (const boundary of [
    { name: "day", before: "2026-10-08T23:59:59.999Z", after: "2026-10-09T00:00:00.000Z", count: "dailyRequests" as const },
    { name: "week", before: "2026-10-11T23:59:59.999Z", after: "2026-10-12T00:00:00.000Z", count: "weeklyRequests" as const },
    { name: "month", before: "2026-10-31T23:59:59.999Z", after: "2026-11-01T00:00:00.000Z", count: "monthlyRequests" as const },
  ]) {
    await t.test(boundary.name, async () => {
      let clock = new Date(boundary.before);
      const tracker = new MemoryTracker({ records: [], usageUnknown: false }, false, () => clock);
      let fetchCalls = 0;
      await generateWithGemini("test", {
        usageTracker: tracker,
        environment: highLimitEnv,
        now: () => new Date(clock),
        beforeDispatch: () => { clock = new Date(boundary.after); },
        fetchImplementation: (async () => { fetchCalls++; return jsonResponse(successfulBody); }) as typeof fetch,
      });
      assert.equal(fetchCalls, 1);
      const record = tracker.data.records[0]!;
      assert.equal(record.timestamp, boundary.before);
      assert.equal(record.accountingThrough, boundary.after);
      assert.equal(record.accountingStatus, "exact");
      assert.equal(getGeminiUsageCounts(tracker.data.records, clock)[boundary.count], 1);
    });
  }
});

test("a normal request inside unchanged windows dispatches once with a bounded accounting interval", async () => {
  const clock = new Date("2026-10-08T12:00:00.000Z");
  const tracker = new MemoryTracker({ records: [], usageUnknown: false }, false, () => clock);
  let fetchCalls = 0;
  await generateWithGemini("test", {
    usageTracker: tracker,
    now: () => new Date(clock),
    fetchImplementation: (async () => { fetchCalls++; return jsonResponse(successfulBody); }) as typeof fetch,
  });
  assert.equal(fetchCalls, 1);
  assert.equal(tracker.data.records[0]?.accountingThrough, clock.toISOString());
});

test("503 retry crossing at final handoff is charged in the new UTC day", async () => {
  let clock = new Date("2026-10-08T23:59:59.999Z");
  const tracker = new MemoryTracker({ records: [], usageUnknown: false }, false, () => clock);
  let dispatch = 0;
  await generateWithGemini("test", {
    usageTracker: tracker,
    environment: highLimitEnv,
    retryDelayMs: 0,
    now: () => new Date(clock),
    beforeDispatch: () => { dispatch++; if (dispatch === 2) clock = new Date("2026-10-09T00:00:00.000Z"); },
    fetchImplementation: (async () => dispatch === 1 ? unavailable() : jsonResponse(successfulBody)) as typeof fetch,
  });
  assert.equal(dispatch, 2);
  assert.equal(getGeminiUsageCounts(tracker.data.records, clock).dailyRequests, 1);
  assert.equal(tracker.data.records[1]?.accountingThrough, clock.toISOString());
});

test("model fallback crossing at final handoff is charged in the new UTC day", async () => {
  let clock = new Date("2026-10-08T23:59:59.999Z");
  const tracker = new MemoryTracker({ records: [], usageUnknown: false }, false, () => clock);
  let dispatch = 0;
  await generateWithGemini("test", {
    usageTracker: tracker,
    environment: highLimitEnv,
    now: () => new Date(clock),
    beforeDispatch: () => { dispatch++; if (dispatch === 2) clock = new Date("2026-10-09T00:00:00.000Z"); },
    fetchImplementation: (async (_url, init) => requestedModel(init) === "gemini-3.8-flash"
      ? modelQuota([quotaFailure(quotaViolation("gemini-3.8-flash"))]) : jsonResponse(successfulBody)) as typeof fetch,
  });
  assert.equal(dispatch, 2);
  assert.equal(getGeminiUsageCounts(tracker.data.records, clock).dailyRequests, 1);
  assert.equal(tracker.data.records[1]?.model, "gemini-3.6-flash");
  assert.equal(tracker.data.records[1]?.accountingThrough, clock.toISOString());
});

test("a successful malformed output is returned once without model hopping", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  const result = await generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => { calls++; return jsonResponse({ output_text: "not-json", usage: { total_input_tokens: 1, total_output_tokens: 1, total_tokens: 2 } }); }) as typeof fetch });
  assert.equal(result.outputText, "not-json");
  assert.equal(calls, 1);
  assert.equal(tracker.data.records[0]?.accountingStatus, "exact");
  assert.equal(tracker.data.records[0]?.totalTokens, 2);
});

test("an unreadable non-2xx body remains ambiguous and does not retry", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  const response = new Response(null, { status: 503, statusText: "Service Unavailable" });
  Object.defineProperty(response, "text", { value: async () => { throw new Error("body stream failed"); } });
  await assert.rejects(generateWithGemini("test", {
    usageTracker: tracker,
    retryDelayMs: 0,
    fetchImplementation: (async () => { calls++; return response; }) as typeof fetch,
  }), /could not be read safely/);
  assert.equal(calls, 1);
  assert.equal(tracker.data.records[0]?.accountingStatus, "transport_ambiguous");
  assert.equal(tracker.data.records[0]?.ambiguityReason, "response_usage_unavailable");
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
  assert.equal(tracker.data.usageUnknown, false);
  assert.equal(tracker.data.records[0]?.accountingStatus, "transport_ambiguous");
  assert.equal(tracker.data.records[0]?.ambiguityReason, "network_error");
  assert.equal(tracker.data.records[0]?.totalTokens, 0);
  let laterFetchCalls = 0;
  await assert.rejects(generateWithGemini("later", { usageTracker: tracker, fetchImplementation: (async () => {
    laterFetchCalls++;
    return jsonResponse(successfulBody);
  }) as typeof fetch }), /blocked by usage guard/);
  assert.equal(laterFetchCalls, 0);
});

test("timeout ambiguity preserves the reservation and does not fallback", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, timeoutMs: 1, fetchImplementation: (async (_url, init) => {
    calls++;
    const signal = init?.signal as AbortSignal;
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    throw new Error("unreachable");
  }) as typeof fetch }), /timed out after 90 seconds/);
  assert.equal(calls, 1);
  assert.equal(tracker.data.usageUnknown, false);
  assert.equal(tracker.data.records[0]?.model, "gemini-3.8-flash");
  assert.equal(tracker.data.records[0]?.accountingStatus, "transport_ambiguous");
  assert.equal(tracker.data.records[0]?.ambiguityReason, "timeout");
});

test("Gemini default deadline is 90 seconds and a response after the old boundary remains admissible", async () => {
  assert.equal(GEMINI_TIMEOUT_MS, 90_000);
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const result = await generateWithGemini("test", {
    usageTracker: tracker,
    timeoutMs: 50,
    fetchImplementation: (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return jsonResponse(successfulBody);
    }) as typeof fetch,
  });
  assert.equal(result.outputText, "GEMINI_OK");
  assert.equal(tracker.data.records[0]?.accountingStatus, "exact");
});

test("the Gemini deadline covers response-body reading and stops later same-cycle dispatches", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  const context = createGeminiCycleContext();
  let calls = 0;
  await assert.rejects(generateWithGemini("test", {
    usageTracker: tracker,
    cycleContext: context,
    timeoutMs: 2,
    fetchImplementation: (async (_url, init) => {
      calls += 1;
      const signal = init?.signal as AbortSignal;
      return {
        ok: true,
        text: () => new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
      } as Response;
    }) as typeof fetch,
  }), /timed out after 90 seconds/);
  assert.equal(context.dispatchBlockedByTimeout, true);
  assert.equal(tracker.data.records[0]?.ambiguityReason, "timeout");
  await assert.rejects(generateWithGemini("later", {
    usageTracker: tracker,
    cycleContext: context,
    fetchImplementation: (async () => { calls += 1; return jsonResponse(successfulBody); }) as typeof fetch,
  }), /stopped for this cycle/);
  assert.equal(calls, 1);
  assert.equal(tracker.data.records.length, 1);
});

test("invalid successful JSON leaves accounting unknown and never model-hops", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false });
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => {
    calls++;
    return new Response("not-json", { status: 200 });
  }) as typeof fetch }), /not valid JSON/);
  assert.equal(calls, 1);
  assert.equal(tracker.data.usageUnknown, false);
  assert.equal(tracker.data.records[0]?.accountingStatus, "transport_ambiguous");
  assert.equal(tracker.data.records[0]?.ambiguityReason, "response_usage_unavailable");
});

test("settlement uncertainty fails safely without fallback", async () => {
  const tracker = new MemoryTracker({ records: [], usageUnknown: false }, true);
  let calls = 0;
  await assert.rejects(generateWithGemini("test", { usageTracker: tracker, fetchImplementation: (async () => { calls++; return jsonResponse(successfulBody); }) as typeof fetch }), /usage could not be recorded safely/);
  assert.equal(calls, 1);
  assert.equal(tracker.data.usageUnknown, false);
  assert.equal(tracker.data.records[0]?.accountingStatus, "transport_ambiguous");
  assert.equal(tracker.data.records[0]?.ambiguityReason, "settlement_uncertain");
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
