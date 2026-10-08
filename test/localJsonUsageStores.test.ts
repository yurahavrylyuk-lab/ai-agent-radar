import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalJsonBraveUsageStore } from "../src/services/localJsonBraveUsageStore.js";
import { LocalJsonGeminiUsageStore } from "../src/services/localJsonGeminiUsageStore.js";
import { reconcileStrandedGeminiReservation, retireStructuredGeminiAmbiguity } from "../src/services/geminiAmbiguityRecovery.js";
import { inspectGeminiAvailability } from "../src/services/geminiUsageGuard.js";

const geminiAdmission = {
  cycleRequestsRemaining: 5,
  limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 },
};
const geminiEnvironment = {
  GEMINI_API_KEY: "test-key",
  GEMINI_DAILY_REQUEST_LIMIT: "5",
  GEMINI_WEEKLY_REQUEST_LIMIT: "20",
  GEMINI_MONTHLY_REQUEST_LIMIT: "50",
  GEMINI_DAILY_TOKEN_LIMIT: "10000",
  GEMINI_WEEKLY_TOKEN_LIMIT: "30000",
  GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
};

async function withTemporaryFile(
  name: string,
  callback: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ai-agent-radar-"));
  try {
    await callback(join(directory, name));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("local Brave JSON store initializes missing state and preserves recorded request data", async () => {
  await withTemporaryFile("brave-usage.json", async (filePath) => {
    const store = new LocalJsonBraveUsageStore(filePath);
    assert.deepEqual(await store.getRecords(), []);

    await store.recordRequest({
      timestamp: "2026-09-20T10:00:00.000Z",
      provider: "brave",
      operation: "web-search",
      requestCount: 1,
    });

    assert.deepEqual(await store.getRecords(), [{
      timestamp: "2026-09-20T10:00:00.000Z",
      provider: "brave",
      operation: "web-search",
      requestCount: 1,
    }]);
  });
});

test("corrupted Brave JSON state is rejected without being overwritten", async () => {
  await withTemporaryFile("brave-usage.json", async (filePath) => {
    await writeFile(filePath, "{not-json", "utf8");
    const store = new LocalJsonBraveUsageStore(filePath);

    await assert.rejects(store.getRecords());
    assert.equal(await readFile(filePath, "utf8"), "{not-json");
  });
});

test("local Gemini JSON store preserves thinking-inclusive total-token records", async () => {
  await withTemporaryFile("gemini-usage.json", async (filePath) => {
    const store = new LocalJsonGeminiUsageStore(filePath);
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

    assert.deepEqual(await store.getUsageData(), {
      usageUnknown: false,
      records: [{
        timestamp: "2026-09-20T10:00:00.000Z",
        provider: "gemini",
        operation: "generate",
        requestCount: 1,
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 112,
      }],
    });
  });
});

test("local Gemini JSON store reserves and settles exact-model usage atomically", async () => {
  await withTemporaryFile("gemini-usage.json", async (filePath) => {
    const store = new LocalJsonGeminiUsageStore(filePath);
    const reservation = await store.reserveRequest({
      timestamp: "2026-09-20T10:00:00.000Z",
      provider: "gemini",
      operation: "analysis",
      requestCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model: "gemini-3.8-flash",
    }, geminiAdmission);
    assert.equal((await store.getUsageData()).usageUnknown, false);
    await assert.rejects(store.reserveRequest(reservation.record, geminiAdmission), /unresolved request/);
    const restartedWhileReserved = new LocalJsonGeminiUsageStore(filePath);
    assert.equal((await restartedWhileReserved.getUsageData()).records[0]?.accountingStatus, "reserved");
    await assert.rejects(restartedWhileReserved.reserveRequest({ ...reservation.record, id: undefined, accountingStatus: undefined }, geminiAdmission), /unresolved request/);
    await store.settleRequest(reservation, { inputTokens: 9, outputTokens: 4, totalTokens: 112 });
    const settledAt = (await store.getUsageData()).records[0]?.settledAt;
    assert.deepEqual(await store.getUsageData(), {
      usageUnknown: false,
      records: [{ ...reservation.record, inputTokens: 9, outputTokens: 4, totalTokens: 112,
        accountingStatus: "exact", settledAt, accountingThrough: settledAt }],
    });
    const secondStore = new LocalJsonGeminiUsageStore(filePath);
    const nextReservation = await secondStore.reserveRequest({ ...reservation.record, id: undefined, accountingStatus: undefined, timestamp: new Date().toISOString() }, geminiAdmission);
    assert.equal(nextReservation.record.model, "gemini-3.8-flash");
  });
});

test("stranded local reservation is operator-reconciled without dispatch and retires only after its anchored windows", async () => {
  await withTemporaryFile("gemini-stranded.json", async (filePath) => {
    let clock = new Date("2026-10-08T08:03:00.000Z");
    const initial = new LocalJsonGeminiUsageStore(filePath, () => clock);
    const reservation = await initial.reserveRequest({
      timestamp: clock.toISOString(), provider: "gemini", operation: "analysis", requestCount: 1,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash",
    }, geminiAdmission);
    const expectation = { id: reservation.record.id!, timestamp: reservation.record.timestamp,
      model: reservation.record.model, operation: reservation.record.operation };

    clock = new Date("2026-10-08T08:04:00.000Z");
    const restarted = new LocalJsonGeminiUsageStore(filePath, () => clock);
    assert.deepEqual(await inspectGeminiAvailability(restarted, geminiEnvironment, clock),
      { allowed: false, reason: "usage_unknown" });
    await assert.rejects(reconcileStrandedGeminiReservation(restarted, expectation, clock, false), /original invocation/);
    await assert.rejects(reconcileStrandedGeminiReservation(restarted,
      { ...expectation, id: expectation.id + 1 }, clock, true), /identity/);
    await assert.rejects(reconcileStrandedGeminiReservation(restarted,
      { ...expectation, timestamp: "2026-10-08T08:02:59.999Z" }, clock, true), /identity/);
    await assert.rejects(reconcileStrandedGeminiReservation(restarted,
      { ...expectation, model: "gemini-3.6-flash" }, clock, true), /identity/);
    assert.equal((await restarted.getUsageData()).records[0]?.accountingStatus, "reserved");
    assert.equal(await reconcileStrandedGeminiReservation(restarted, expectation, clock, true), "reconciled");
    assert.equal(await reconcileStrandedGeminiReservation(restarted, expectation, clock, true), "already_reconciled");

    const ambiguous = (await restarted.getUsageData()).records[0]!;
    assert.equal(ambiguous.accountingStatus, "transport_ambiguous");
    assert.equal(ambiguous.ambiguityReason, "abandoned_reservation");
    assert.equal(ambiguous.accountingThrough, clock.toISOString());
    assert.deepEqual([ambiguous.inputTokens, ambiguous.outputTokens, ambiguous.totalTokens], [0, 0, 0]);
    const retirement = { id: expectation.id, timestamp: expectation.timestamp, model: expectation.model,
      ambiguityReason: "abandoned_reservation" as const };
    await assert.rejects(retireStructuredGeminiAmbiguity(restarted, retirement,
      new Date("2026-10-31T23:59:59.999Z"), true), /remains active/);
    clock = new Date("2026-11-01T00:00:00.000Z");
    assert.equal(await retireStructuredGeminiAmbiguity(restarted, retirement, clock, true), "retired");
    assert.equal((await restarted.getUsageData()).records[0]?.accountingStatus, "retired_outside_accounting_windows");
  });
});

test("stranded local reconciliation refuses a non-reserved terminal record", async () => {
  await withTemporaryFile("gemini-terminal.json", async (filePath) => {
    const clock = new Date("2026-10-08T08:04:00.000Z");
    const store = new LocalJsonGeminiUsageStore(filePath, () => clock);
    const reservation = await store.reserveRequest({
      timestamp: "2026-10-08T08:03:00.000Z", provider: "gemini", operation: "analysis", requestCount: 1,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash",
    }, geminiAdmission);
    await store.confirmZeroRequest(reservation);
    await assert.rejects(reconcileStrandedGeminiReservation(store, {
      id: reservation.record.id!, timestamp: reservation.record.timestamp,
      model: reservation.record.model, operation: reservation.record.operation,
    }, clock, true), /exactly one unresolved record/);
  });
});

test("stranded local reconciliation fails closed on conflicting unresolved state", async () => {
  await withTemporaryFile("gemini-conflict.json", async (filePath) => {
    const timestamp = "2026-10-08T08:03:00.000Z";
    const base = { timestamp, provider: "gemini", operation: "analysis", requestCount: 1,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, model: "gemini-3.8-flash",
      accountingStatus: "reserved", accountingThrough: timestamp };
    await writeFile(filePath, JSON.stringify({ usageUnknown: false, records: [
      { ...base, id: 1 }, { ...base, id: 2, model: "gemini-3.6-flash" },
    ] }), "utf8");
    const store = new LocalJsonGeminiUsageStore(filePath, () => new Date("2026-10-08T08:04:00.000Z"));
    await assert.rejects(reconcileStrandedGeminiReservation(store,
      { id: 1, timestamp, model: "gemini-3.8-flash", operation: "analysis" },
      new Date("2026-10-08T08:04:00.000Z"), true), /conflicting unresolved/);
  });
});

test("corrupted Gemini JSON state fails closed without being overwritten", async () => {
  await withTemporaryFile("gemini-usage.json", async (filePath) => {
    await writeFile(filePath, JSON.stringify({ records: [], usageUnknown: "unknown" }), "utf8");
    const store = new LocalJsonGeminiUsageStore(filePath);

    await assert.rejects(store.getUsageData());
    assert.equal(
      await readFile(filePath, "utf8"),
      JSON.stringify({ records: [], usageUnknown: "unknown" }),
    );
  });
});

test("local usage stores retain pre-existing runtime records when writing", async () => {
  await withTemporaryFile("brave-usage.json", async (bravePath) => {
    await writeFile(bravePath, JSON.stringify({ records: [{
      timestamp: "2026-09-19T10:00:00.000Z",
      provider: "brave",
      operation: "web-search",
      requestCount: 1,
    }] }), "utf8");
    const braveStore = new LocalJsonBraveUsageStore(bravePath);
    await braveStore.recordRequest({
      timestamp: "2026-09-20T10:00:00.000Z",
      provider: "brave",
      operation: "web-search",
      requestCount: 1,
    });
    assert.equal((await braveStore.getRecords()).length, 2);
  });

  await withTemporaryFile("gemini-usage.json", async (geminiPath) => {
    await writeFile(geminiPath, JSON.stringify({ usageUnknown: false, records: [{
      timestamp: "2026-09-19T10:00:00.000Z",
      provider: "gemini",
      operation: "generate",
      requestCount: 1,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 3,
    }] }), "utf8");
    const geminiStore = new LocalJsonGeminiUsageStore(geminiPath);
    await geminiStore.markUsageUnknown();
    const data = await geminiStore.getUsageData();
    assert.equal(data.records.length, 1);
    assert.equal(data.usageUnknown, true);
  });
});
