import assert from "node:assert/strict";
import test from "node:test";
import { D1BraveUsageStore } from "../src/services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "../src/services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "../src/services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "../src/services/d1NotificationHistory.js";
import { createRadarRuntimeConfiguration } from "../src/services/radarRuntimeConfiguration.js";
import type { MonitoringCycleResult } from "../src/types/index.js";
import worker, {
  createWorkerMonitoringDependencies,
  createWorkerPersistence,
  handleScheduledMonitoring,
  MAX_SCHEDULED_ERROR_LENGTH,
  runScheduledMonitoring,
  type RadarWorkerEnv,
  type ScheduledCycleSummary,
} from "../src/worker.js";

function environment(): RadarWorkerEnv {
  return {
    DB: {} as D1Database,
    BRAVE_SEARCH_API_KEY: "brave-test-key",
    BRAVE_DAILY_SEARCH_LIMIT: "10",
    BRAVE_WEEKLY_SEARCH_LIMIT: "100",
    BRAVE_MONTHLY_SEARCH_LIMIT: "350",
    GEMINI_API_KEY: "gemini-test-key",
    GEMINI_MODEL: "gemini-3.6-flash",
    GEMINI_DAILY_REQUEST_LIMIT: "5",
    GEMINI_WEEKLY_REQUEST_LIMIT: "20",
    GEMINI_MONTHLY_REQUEST_LIMIT: "50",
    GEMINI_DAILY_TOKEN_LIMIT: "10000",
    GEMINI_WEEKLY_TOKEN_LIMIT: "30000",
    GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
    RESEND_API_KEY: "resend-test-key",
    NOTIFICATION_EMAIL: "radar@example.test",
  };
}

function monitoringResult(overrides: Partial<MonitoringCycleResult> = {}): MonitoringCycleResult {
  return {
    query: "test query",
    searchResultsReceived: 12,
    searchFailures: [],
    resultsProcessed: 5,
    newDiscoveries: 4,
    duplicates: 1,
    analysesAttempted: 4,
    notificationsSent: 1,
    notificationsAlreadySent: 1,
    notificationsNotEligible: 2,
    failures: 1,
    stoppedByAnalysisCap: true,
    replayCandidatesConsidered: 3,
    replayCandidatesEligible: 2,
    freshStoriesSent: 1,
    replayStoriesSent: 2,
    replayLookupTruncated: false,
    outcomes: [
      {
        sourceTitle: "Secret title should never be logged",
        sourceUrl: "https://example.test/secret-path",
        discoveryStatus: "new",
        notificationStatus: "sent",
      },
      {
        sourceTitle: "Failed source",
        sourceUrl: "https://example.test/failure",
        error: "Provider failed",
      },
    ],
    ...overrides,
  };
}

test("Worker runtime configuration preserves configured limits and rejects missing secrets", () => {
  const configuration = createRadarRuntimeConfiguration(environment());
  assert.equal(configuration.environment.BRAVE_DAILY_SEARCH_LIMIT, "10");
  assert.equal(configuration.environment.BRAVE_WEEKLY_SEARCH_LIMIT, "100");
  assert.equal(configuration.environment.BRAVE_MONTHLY_SEARCH_LIMIT, "350");
  assert.equal(configuration.environment.GEMINI_MONTHLY_TOKEN_LIMIT, "100000");
  const missing = environment();
  missing.GEMINI_API_KEY = "";
  assert.throws(() => createRadarRuntimeConfiguration(missing), /GEMINI_API_KEY is required/);
});

test("Worker composition uses D1 stores and exposes a scheduled handler without invoking it from fetch", async () => {
  const persistence = createWorkerPersistence(environment());
  const dependencies = createWorkerMonitoringDependencies(environment());
  assert.ok(persistence.discoveryHistory instanceof D1DiscoveryHistory);
  assert.ok(persistence.notificationHistory instanceof D1NotificationHistory);
  assert.ok(persistence.braveUsageStore instanceof D1BraveUsageStore);
  assert.ok(persistence.geminiUsageStore instanceof D1GeminiUsageStore);
  assert.ok(dependencies.history instanceof D1DiscoveryHistory, "replay discovery history must use D1");
  assert.equal(typeof dependencies.search, "function");
  assert.equal(typeof dependencies.process, "function");
  assert.ok(dependencies.notification?.history instanceof D1NotificationHistory, "notification history must be a D1NotificationHistory");
  assert.equal(typeof worker.scheduled, "function");
  const response = await worker.fetch(new Request("https://worker.example"), environment());
  assert.equal(await response.text(), "AI Agent Radar worker ready");
});

test("scheduled monitoring runs one cycle and emits one structured summary with exact counts", async () => {
  const expected = monitoringResult();
  const summaries: ScheduledCycleSummary[] = [];
  let cycleCalls = 0;

  const actual = await runScheduledMonitoring(environment(), {
    runCycle: async () => {
      cycleCalls += 1;
      return expected;
    },
    logInfo: (summary) => summaries.push(summary),
  });

  assert.equal(actual, expected);
  assert.equal(cycleCalls, 1);
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0], {
    event: "scheduled_monitoring_cycle_completed",
    searchResultsReceived: 12,
    searchFailuresTotal: 0,
    searchFailuresOmitted: 0,
    searchFailures: [],
    resultsProcessed: 5,
    newDiscoveries: 4,
    duplicates: 1,
    analysesAttempted: 4,
    notificationsSent: 1,
    notificationsAlreadySent: 1,
    notificationsNotEligible: 2,
    failures: 1,
    stoppedByAnalysisCap: true,
    replayCandidatesConsidered: 3,
    replayCandidatesEligible: 2,
    freshStoriesSent: 1,
    replayStoriesSent: 2,
    replayLookupTruncated: false,
    outcomesTotal: 2,
    outcomesOmitted: 0,
    outcomes: [
      {
        ordinal: 1,
        discoveryStatus: "new",
        notificationStatus: "sent",
        failed: false,
      },
      {
        ordinal: 2,
        discoveryStatus: undefined,
        notificationStatus: undefined,
        failed: true,
        error: "Provider failed",
      },
    ],
  });
});

test("scheduled handler registers and awaits the single monitoring promise", async () => {
  const summaries: ScheduledCycleSummary[] = [];
  const promises: Promise<unknown>[] = [];
  let cycleCalls = 0;
  const context = {
    waitUntil(promise: Promise<unknown>) {
      promises.push(promise);
    },
  } as ExecutionContext;

  handleScheduledMonitoring(environment(), context, {
    runCycle: async () => {
      cycleCalls += 1;
      return monitoringResult();
    },
    logInfo: (summary) => summaries.push(summary),
  });

  assert.equal(promises.length, 1);
  await promises[0];
  assert.equal(cycleCalls, 1);
  assert.equal(summaries.length, 1);
});

test("scheduled summary bounds outcomes and redacts secrets, email addresses, URLs, and source content", async () => {
  const env = environment();
  env.CONTROLLED_EXECUTION_TOKEN = "controlled-execution-secret";
  const longError = [
    "Request failed for https://example.test/private/story?id=123&token=something",
    env.BRAVE_SEARCH_API_KEY,
    env.GEMINI_API_KEY,
    env.RESEND_API_KEY,
    env.NOTIFICATION_EMAIL,
    env.CONTROLLED_EXECUTION_TOKEN,
    "another@example.test",
    "Bearer bearer-secret",
    "x".repeat(MAX_SCHEDULED_ERROR_LENGTH + 40),
  ].join("\n");
  const outcomes = Array.from({ length: 12 }, (_, index) => ({
    sourceTitle: `private source body ${index}`,
    sourceUrl: `https://secret.example.test/path/${index}`,
    error: longError,
  }));
  const summaries: ScheduledCycleSummary[] = [];

  await runScheduledMonitoring(env, {
    runCycle: async () => monitoringResult({
      failures: 13,
      searchFailures: [{ queryOrdinal: 3, error: longError }],
      outcomes,
    }),
    logInfo: (summary) => summaries.push(summary),
  });

  const serialized = JSON.stringify(summaries[0]);
  assert.equal(summaries[0]?.searchFailuresTotal, 1);
  assert.equal(summaries[0]?.searchFailuresOmitted, 0);
  assert.equal(summaries[0]?.searchFailures[0]?.queryOrdinal, 3);
  assert.ok((summaries[0]?.searchFailures[0]?.error.length ?? 0) <= MAX_SCHEDULED_ERROR_LENGTH);
  assert.equal(summaries[0]?.outcomes.length, 10);
  assert.equal(summaries[0]?.outcomesTotal, 12);
  assert.equal(summaries[0]?.outcomesOmitted, 2);
  assert.ok(summaries[0]?.outcomes.every((outcome) => (outcome.error?.length ?? 0) <= MAX_SCHEDULED_ERROR_LENGTH));
  for (const forbidden of [
    env.BRAVE_SEARCH_API_KEY,
    env.GEMINI_API_KEY,
    env.RESEND_API_KEY,
    env.NOTIFICATION_EMAIL,
    env.CONTROLLED_EXECUTION_TOKEN,
    "another@example.test",
    "bearer-secret",
    "example.test",
    "/private/story",
    "id=123",
    "token=something",
    "secret.example.test",
    "private source body",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `summary must not contain ${forbidden}`);
  }
});

test("scheduled monitoring propagates a rejected cycle without logging success or retrying", async () => {
  const summaries: ScheduledCycleSummary[] = [];
  let cycleCalls = 0;

  await assert.rejects(
    runScheduledMonitoring(environment(), {
      runCycle: async () => {
        cycleCalls += 1;
        throw new Error("cycle failed");
      },
      logInfo: (summary) => summaries.push(summary),
    }),
    /cycle failed/,
  );

  assert.equal(cycleCalls, 1);
  assert.equal(summaries.length, 0);
});
