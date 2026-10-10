import assert from "node:assert/strict";
import test from "node:test";
import {
  getGeminiAmbiguityRetirementTime,
  getGeminiUtcAccountingWindows,
  isGeminiTimestampInAnyActiveWindow,
} from "../src/services/geminiAccountingWindows.js";
import {
  LEGACY_ROW17_DATABASE_ID,
  LEGACY_ROW17_EXPECTATION,
  LEGACY_ROW17_SAFE_RETIREMENT_AT,
  retireStructuredGeminiAmbiguity,
  simulateLegacyRow17LatchClear,
  validateLegacyRow17Recovery,
} from "../src/services/geminiAmbiguityRecovery.js";
import { getGeminiUsageCounts, inspectGeminiAvailability } from "../src/services/geminiUsageGuard.js";
import type {
  GeminiAmbiguityRetirementExpectation,
  GeminiUsageData,
  GeminiUsageStore,
} from "../src/services/geminiUsageTracker.js";

const environment = {
  GEMINI_API_KEY: "test-key",
  GEMINI_DAILY_REQUEST_LIMIT: "5",
  GEMINI_WEEKLY_REQUEST_LIMIT: "20",
  GEMINI_MONTHLY_REQUEST_LIMIT: "50",
  GEMINI_DAILY_TOKEN_LIMIT: "10000",
  GEMINI_WEEKLY_TOKEN_LIMIT: "30000",
  GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
};

function legacyIncident(): GeminiUsageData {
  return {
    usageUnknown: true,
    records: [{
      ...LEGACY_ROW17_EXPECTATION,
      accountingStatus: "legacy",
      ambiguityReason: null,
      settledAt: null,
      retiredAt: null,
    }],
  };
}

test("Gemini accounting windows are UTC calendar day, Monday week, and calendar month", () => {
  const windows = getGeminiUtcAccountingWindows(new Date("2026-10-08T08:02:03.393Z"));
  assert.equal(new Date(windows.dayStart).toISOString(), "2026-10-08T00:00:00.000Z");
  assert.equal(new Date(windows.weekStart).toISOString(), "2026-10-05T00:00:00.000Z");
  assert.equal(new Date(windows.monthStart).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(new Date(windows.nextDayStart).toISOString(), "2026-10-09T00:00:00.000Z");
  assert.equal(new Date(windows.nextWeekStart).toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(new Date(windows.nextMonthStart).toISOString(), "2026-11-01T00:00:00.000Z");
});

test("row 17 blocks in any active UTC window and retires only at the exact final boundary", () => {
  const timestamp = LEGACY_ROW17_EXPECTATION.timestamp;
  for (const now of [
    "2026-10-08T08:02:03.394Z",
    "2026-10-09T00:00:00.000Z",
    "2026-10-12T00:00:00.000Z",
    "2026-10-31T23:59:59.999Z",
  ]) assert.equal(isGeminiTimestampInAnyActiveWindow(timestamp, new Date(now)), true, now);
  assert.equal(isGeminiTimestampInAnyActiveWindow(timestamp, new Date(LEGACY_ROW17_SAFE_RETIREMENT_AT)), false);
  assert.equal(getGeminiAmbiguityRetirementTime(timestamp).toISOString(), LEGACY_ROW17_SAFE_RETIREMENT_AT);
});

test("day, week, and month boundaries remain independently conservative", () => {
  const octoberEight = "2026-10-08T08:00:00.000Z";
  assert.equal(isGeminiTimestampInAnyActiveWindow(octoberEight, new Date("2026-10-09T00:00:00.000Z")), true);
  assert.equal(isGeminiTimestampInAnyActiveWindow(octoberEight, new Date("2026-10-12T00:00:00.000Z")), true);
  const octoberThirtyOne = "2026-10-31T12:00:00.000Z";
  assert.equal(getGeminiAmbiguityRetirementTime(octoberThirtyOne).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(isGeminiTimestampInAnyActiveWindow(octoberThirtyOne, new Date("2026-11-01T00:00:00.000Z")), true);
  assert.equal(isGeminiTimestampInAnyActiveWindow(octoberThirtyOne, new Date("2026-11-02T00:00:00.000Z")), false);
});

test("UTC count results do not depend on process timezone", () => {
  const previous = process.env.TZ;
  const record = { timestamp: "2026-10-04T23:30:00.000Z", provider: "gemini" as const, operation: "analysis", requestCount: 1 as const, inputTokens: 1, outputTokens: 1, totalTokens: 3 };
  try {
    const results = ["UTC", "Europe/Warsaw", "America/Los_Angeles"].map((timezone) => {
      process.env.TZ = timezone;
      return getGeminiUsageCounts([record], new Date("2026-10-05T00:30:00.000Z"));
    });
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
    assert.deepEqual(results[0], { dailyRequests: 0, weeklyRequests: 0, monthlyRequests: 1, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 3 });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("structured unresolved state blocks preflight while retired history outside all windows does not", async () => {
  const base = {
    id: 18, timestamp: "2026-10-08T08:03:00.000Z", provider: "gemini" as const, operation: "analysis", requestCount: 1 as const,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash", accountingThrough: "2026-10-08T08:03:01.000Z",
  };
  const blocked = await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records: [{ ...base, accountingStatus: "transport_ambiguous", ambiguityReason: "timeout" }] }) }, environment, new Date("2026-10-08T09:00:00.000Z"));
  assert.deepEqual(blocked, { allowed: false, reason: "usage_unknown" });
  const nextDay = await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records: [{ ...base, accountingStatus: "transport_ambiguous", ambiguityReason: "timeout" }] }) }, environment, new Date("2026-10-09T00:00:00.000Z"));
  assert.equal(nextDay.allowed, true);
  if (nextDay.allowed) assert.deepEqual(nextDay.timeoutIncompleteAccounting, { dailyRequests: 0, weeklyRequests: 1, monthlyRequests: 1 });
  const retired = await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records: [{ ...base, accountingStatus: "retired_outside_accounting_windows", ambiguityReason: "timeout", retiredAt: "2026-11-01T00:00:00.000Z" }] }) }, environment, new Date("2026-11-01T00:00:00.000Z"));
  assert.equal(retired.allowed, true);
  const rollback = await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records: [{ ...base, accountingStatus: "retired_outside_accounting_windows", ambiguityReason: "timeout", retiredAt: "2026-11-01T00:00:00.000Z" }] }) }, environment, new Date("2026-10-31T23:59:59.999Z"));
  assert.deepEqual(rollback, { allowed: false, reason: "usage_state_unavailable" });
});

test("multiple historical timeout rows are retained while non-timeout ambiguity remains fail-closed", async () => {
  const timeout = (id: number, timestamp: string) => ({
    id, timestamp, provider: "gemini" as const, operation: "analysis", requestCount: 1 as const,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash",
    accountingStatus: "transport_ambiguous" as const, ambiguityReason: "timeout" as const,
    accountingThrough: timestamp,
  });
  const records = [timeout(18, "2026-10-08T08:00:00.000Z"), timeout(19, "2026-10-09T08:00:00.000Z")];
  const allowed = await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records }) }, environment,
    new Date("2026-10-10T00:00:00.000Z"));
  assert.equal(allowed.allowed, true);
  if (allowed.allowed) {
    assert.equal(allowed.counts.dailyRequests, 0);
    assert.equal(allowed.counts.weeklyRequests, 2);
    assert.deepEqual(allowed.timeoutIncompleteAccounting, { dailyRequests: 0, weeklyRequests: 2, monthlyRequests: 2 });
  }
  const blocked = await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records: [
    ...records,
    { ...timeout(20, "2026-10-09T09:00:00.000Z"), ambiguityReason: "network_error" as const },
  ] }) }, environment, new Date("2026-10-10T00:00:00.000Z"));
  assert.deepEqual(blocked, { allowed: false, reason: "usage_unknown" });
});

test("timeout admission fails closed on usage latch and malformed accounting timestamps", async () => {
  const record = {
    id: 19, timestamp: "2026-10-09T08:00:00.000Z", provider: "gemini" as const, operation: "analysis", requestCount: 1 as const,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash",
    accountingStatus: "transport_ambiguous" as const, ambiguityReason: "timeout" as const,
    accountingThrough: "2026-10-09T08:01:30.000Z",
  };
  assert.deepEqual(await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: true, records: [record] }) }, environment,
    new Date("2026-10-10T00:00:00.000Z")), { allowed: false, reason: "usage_unknown" });
  assert.deepEqual(await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records: [{ ...record, accountingThrough: "invalid" }] }) }, environment,
    new Date("2026-10-10T00:00:00.000Z")), { allowed: false, reason: "usage_state_unavailable" });
});

test("row 19 remains unchanged and accountingThrough controls the cross-midnight release", async () => {
  const row19 = {
    id: 19,
    timestamp: "2026-10-10T08:01:01.241Z",
    provider: "gemini" as const,
    operation: "analysis",
    requestCount: 1 as const,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    model: "gemini-3.8-flash",
    accountingStatus: "transport_ambiguous" as const,
    ambiguityReason: "timeout" as const,
    settledAt: null,
    retiredAt: null,
    accountingThrough: "2026-10-10T08:01:31.409Z",
  };
  const before = structuredClone(row19);
  assert.deepEqual(await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records: [row19] }) }, environment,
    new Date("2026-10-10T23:59:59.999Z")), { allowed: false, reason: "usage_unknown" });
  const released = await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records: [row19] }) }, environment,
    new Date("2026-10-11T00:00:00.000Z"));
  assert.equal(released.allowed, true);
  assert.deepEqual(row19, before);

  const crossMidnight = { ...row19, timestamp: "2026-10-10T23:59:50.000Z", accountingThrough: "2026-10-11T00:00:05.000Z" };
  assert.deepEqual(await inspectGeminiAvailability({ getUsageData: async () => ({ usageUnknown: false, records: [crossMidnight] }) }, environment,
    new Date("2026-10-11T00:00:06.000Z")), { allowed: false, reason: "usage_unknown" });
});

test("operator retirement refuses active windows and recognizes a safe exact transition", async () => {
  const expectation: GeminiAmbiguityRetirementExpectation = {
    id: 18,
    timestamp: "2026-10-08T08:03:00.000Z",
    model: "gemini-3.8-flash",
    ambiguityReason: "timeout",
  };
  const data: GeminiUsageData = { usageUnknown: false, records: [{
    ...expectation, provider: "gemini", operation: "analysis", requestCount: 1,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, accountingStatus: "transport_ambiguous",
    accountingThrough: "2026-10-08T08:03:01.000Z",
  }] };
  let retireCalls = 0;
  const store = {
    getUsageData: async () => structuredClone(data),
    retireAmbiguousRequest: async () => { retireCalls++; return "retired" as const; },
  } as unknown as GeminiUsageStore;
  await assert.rejects(retireStructuredGeminiAmbiguity(store, expectation, new Date("2026-11-01T00:00:00.000Z"), false), /original invocation/);
  await assert.rejects(retireStructuredGeminiAmbiguity(store, expectation, new Date("2026-10-31T23:59:59.999Z"), true), /remains active/);
  assert.equal(retireCalls, 0);
  assert.equal(await retireStructuredGeminiAmbiguity(store, expectation, new Date("2026-11-01T00:00:00.000Z"), true), "retired");
  assert.equal(retireCalls, 1);
});

test("legacy row 17 recovery validates exact incident identity and changes only the latch in simulation", () => {
  const before = legacyIncident();
  const evidence = { databaseId: LEGACY_ROW17_DATABASE_ID, originalInvocationTerminated: true, now: new Date(LEGACY_ROW17_SAFE_RETIREMENT_AT) };
  const after = simulateLegacyRow17LatchClear(before, evidence);
  assert.equal(after.usageUnknown, false);
  assert.deepEqual(after.records, before.records);
  assert.equal(before.usageUnknown, true);
});

test("legacy row 17 recovery refuses early time and every critical identity mismatch", () => {
  const valid = legacyIncident();
  const evidence = { databaseId: LEGACY_ROW17_DATABASE_ID, originalInvocationTerminated: true, now: new Date(LEGACY_ROW17_SAFE_RETIREMENT_AT) };
  assert.throws(() => validateLegacyRow17Recovery(valid, { ...evidence, now: new Date("2026-10-31T23:59:59.999Z") }), /remains active/);
  assert.throws(() => validateLegacyRow17Recovery(valid, { ...evidence, databaseId: "wrong" }), /database identity/);
  assert.throws(() => validateLegacyRow17Recovery(valid, { ...evidence, originalInvocationTerminated: false }), /original invocation/);
  for (const patch of [
    { id: 16 },
    { timestamp: "2026-10-08T08:02:03.394Z" },
    { model: "gemini-3.6-flash" },
    { operation: "other" },
    { totalTokens: 1 },
    { accountingStatus: "exact" },
  ]) {
    const changed = legacyIncident();
    changed.records[0] = { ...changed.records[0]!, ...patch } as typeof changed.records[number];
    assert.throws(() => validateLegacyRow17Recovery(changed, evidence), /does not match/);
  }
  assert.throws(() => validateLegacyRow17Recovery({ ...valid, usageUnknown: false }, evidence), /latch is not set/);
  const newer = legacyIncident();
  newer.records.push({ ...newer.records[0]!, id: 18, timestamp: "2026-10-08T09:00:00.000Z", accountingStatus: "reserved" });
  assert.throws(() => validateLegacyRow17Recovery(newer, evidence), /Unexpected newer/);
});
