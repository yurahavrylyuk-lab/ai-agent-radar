import assert from "node:assert/strict";
import test from "node:test";
import { D1BraveUsageStore } from "../src/services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "../src/services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "../src/services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "../src/services/d1NotificationHistory.js";
import { MONITORING_FRESHNESS } from "../src/config/discoveryQueries.js";
import { createMonitoringRuntimeConfiguration, createRadarRuntimeConfiguration } from "../src/services/radarRuntimeConfiguration.js";
import type { BatchCycleMetrics, MonitoringCycleResult } from "../src/types/index.js";
import worker, {
  createWorkerMonitoringDependencies,
  createWorkerPersistence,
  createScheduledCycleSummary,
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
    X_DISCOVERY_ENABLED: "false",
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
    geminiProviderAttempts: 5,
    geminiFallbacks: 1,
    analysesUsingFallbackModel: 1,
    geminiRequestsByModel: { "gemini-3.8-flash": 4, "gemini-3.6-flash": 1, "gemini-3.5-flash-lite": 0 },
    replayCandidatesConsidered: 3,
    replayCandidatesEligible: 2,
    freshStoriesSent: 1,
    replayStoriesSent: 2,
    replayLookupTruncated: false,
    xRequestsAttempted: 5,
    xPostsReceived: 12,
    xCandidatesAdmitted: 3,
    xDuplicates: 1,
    xAccountsFailed: 1,
    xTruncated: true,
    xFailures: [{ accountOrdinal: 2, reason: "provider_error" }],
    xBlockedReason: "rate_limit",
    delivery: {
      deliveryMode: "normal", deliveryReason: "selected", analyzedStories: 3, rawStories: 0, replayStories: 2,
      emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "recorded", finalizationReached: true,
    },
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
  assert.doesNotThrow(() => createMonitoringRuntimeConfiguration(missing));
  const missingBrave = environment();
  missingBrave.BRAVE_SEARCH_API_KEY = "";
  assert.throws(() => createMonitoringRuntimeConfiguration(missingBrave), /BRAVE_SEARCH_API_KEY is required/);
});

test("Worker composition uses D1 stores and exposes a scheduled handler without invoking it from fetch", async () => {
  const persistence = createWorkerPersistence(environment());
  const dependencies = createWorkerMonitoringDependencies(environment());
  assert.ok(persistence.discoveryHistory instanceof D1DiscoveryHistory);
  assert.ok(persistence.notificationHistory instanceof D1NotificationHistory);
  assert.ok(persistence.braveUsageStore instanceof D1BraveUsageStore);
  assert.ok(persistence.geminiUsageStore instanceof D1GeminiUsageStore);
  assert.ok(dependencies.history instanceof D1DiscoveryHistory, "replay discovery history must use D1");
  assert.equal(typeof dependencies.searchPage, "function");
  assert.equal(typeof dependencies.collectRss, "function");
  assert.equal(typeof dependencies.analyze, "function");
  assert.equal("process" in dependencies, false);
  assert.equal("collectX" in dependencies, false);
  assert.equal("resolveXPost" in dependencies, false);
  assert.equal(dependencies.geminiCycleContext.batchStarted, false);
  assert.ok(dependencies.notification?.history instanceof D1NotificationHistory, "notification history must be a D1NotificationHistory");
  assert.equal(typeof worker.scheduled, "function");
  const response = await worker.fetch(new Request("https://worker.example"), environment());
  assert.equal(await response.text(), "AI Agent Radar worker ready");
});

test("Worker search composition forwards the monitoring freshness option without a provider request", async () => {
  const calls: Array<{ query: string; freshness: string | undefined }> = [];
  const dependencies = createWorkerMonitoringDependencies(environment(), {
    searchPage: async (query, options) => {
      calls.push({ query, freshness: options.freshness });
      return { rawCount: 0, positions: [] };
    },
  });
  await dependencies.searchPage("official query", { freshness: MONITORING_FRESHNESS });
  assert.deepEqual(calls, [{ query: "official query", freshness: "pw" }]);
});

test("default scheduled Worker uses batch entry with no X tables and HTTP methods/paths remain health-only", async () => {
  const env = environment();
  let databaseReads = 0;
  env.DB = { prepare(sql: string) {
    assert.doesNotMatch(sql, /\bx_(?:poll|pending|usage|inbox|request)/i);
    databaseReads++;
    return { bind() { return this; }, async all() { return { success: true, results: [] }; }, async first() { return { usage_unknown: 0 }; }, async run() { return { success: true, meta: { changes: 1 } }; } };
  } } as unknown as D1Database;
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const providerUrls: string[] = [];
  const summaries: unknown[] = [];
  try {
    globalThis.fetch = async input => {
      providerUrls.push(String(input));
      const hostname = new URL(String(input)).hostname;
      if (hostname === "api.search.brave.com") return new Response(JSON.stringify({ web: { results: [] } }));
      if (hostname === "api.resend.com") return new Response(JSON.stringify({ id: "status-message" }));
      assert.ok(["openai.com", "github.blog", "blog.cloudflare.com", "developer.chrome.com"].includes(hostname));
      return new Response(`<rss version="2.0"><channel><title>Empty</title></channel></rss>`, { headers: { "content-type": "application/rss+xml" } });
    };
    console.info = value => { if (value?.event === "scheduled_monitoring_cycle_completed") summaries.push(value); };
    const result = await runScheduledMonitoring(env);
    assert.equal(result.batch?.status, "empty");
    assert.equal(result.analysesAttempted, 0);
    assert.equal(providerUrls.length, 15);
    assert.equal(summaries.length, 1);
    assert.equal(result.xRequestsAttempted, 0);
    assert.equal(result.xBlockedReason, "disabled");
    providerUrls.length = 0;
    databaseReads = 0;
    for (const method of ["GET", "POST"]) {
      for (const path of ["/", "/monitor", "/private/execute"]) {
        assert.equal(await worker.fetch(new Request(`https://worker.example${path}`, { method }), env).text(), "AI Agent Radar worker ready");
      }
    }
    assert.equal(providerUrls.length, 0);
    assert.equal(databaseReads, 0);
  } finally { globalThis.fetch = originalFetch; console.info = originalInfo; }
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
    geminiProviderAttempts: 5,
    geminiFallbacks: 1,
    analysesUsingFallbackModel: 1,
    geminiRequestsByModel: { "gemini-3.8-flash": 4, "gemini-3.6-flash": 1, "gemini-3.5-flash-lite": 0 },
    replayCandidatesConsidered: 3,
    replayCandidatesEligible: 2,
    freshStoriesSent: 1,
    replayStoriesSent: 2,
    replayLookupTruncated: false,
    xRequestsAttempted: 5,
    xPostsReceived: 12,
    xCandidatesAdmitted: 3,
    xDuplicates: 1,
    xAccountsFailed: 1,
    xTruncated: true,
    xFailures: [{ accountOrdinal: 2, reason: "provider_error" }],
    xBlockedReason: "rate_limit",
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
    delivery: {
      deliveryMode: "normal",
      deliveryReason: "selected",
      analyzedStories: 3,
      rawStories: 0,
      replayStories: 2,
      emailAttempts: 1,
      emailOutcome: "accepted",
      historyOutcome: "recorded",
      finalizationReached: true,
    },
  });
});

test("scheduled summary independently allowlists and bounds daily delivery telemetry", () => {
  const result = monitoringResult();
  result.delivery = {
    deliveryMode: "degraded", deliveryReason: "ai_unavailable", analyzedStories: 99, rawStories: 99, replayStories: 99,
    emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "persistence_failed", finalizationReached: true,
  };
  assert.deepEqual(createScheduledCycleSummary(result, environment()).delivery, {
    deliveryMode: "degraded", deliveryReason: "ai_unavailable", analyzedStories: 4, rawStories: 4, replayStories: 4,
    emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "persistence_failed", finalizationReached: true,
  });
  (result.delivery as unknown as Record<string, unknown>).deliveryMode = "PRIVATE_PROVIDER_BODY";
  (result.delivery as unknown as Record<string, unknown>).deliveryReason = "PRIVATE_CANDIDATE_TEXT";
  assert.doesNotMatch(JSON.stringify(createScheduledCycleSummary(result, environment())), /PRIVATE_PROVIDER_BODY|PRIVATE_CANDIDATE_TEXT/);
});

test("scheduled summary exposes only the exact bounded Gemini blocked reason", async () => {
  const summaries: ScheduledCycleSummary[] = [];
  await runScheduledMonitoring(environment(), {
    runCycle: async () => monitoringResult({
      searchResultsReceived: 0,
      resultsProcessed: 0,
      newDiscoveries: 0,
      analysesAttempted: 0,
      geminiProviderAttempts: 0,
      geminiFallbacks: 0,
      analysesUsingFallbackModel: 0,
      geminiBlockedReason: "weekly_token_limit",
      outcomes: [],
    }),
    logInfo: (summary) => summaries.push(summary),
  });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.geminiBlockedReason, "weekly_token_limit");
  const serialized = JSON.stringify(summaries[0]);
  assert.ok(!serialized.includes("gemini-test-key"));
  assert.ok(!serialized.includes("https://"));
  assert.ok(!("geminiBlockedReason" in createScheduledCycleSummary(monitoringResult(), environment())));
});

test("scheduled summary reports bounded timeout accounting without claiming zero tokens", () => {
  const summary = createScheduledCycleSummary(monitoringResult({
    geminiTimeoutIncompleteAccounting: { dailyRequests: 0, weeklyRequests: 2, monthlyRequests: 2 },
  }), environment());
  assert.deepEqual(summary.geminiTimeoutIncompleteAccounting, { dailyRequests: 0, weeklyRequests: 2, monthlyRequests: 2 });
  assert.equal(JSON.stringify(summary).includes("tokensUsed"), false);
});

function batchMetrics(overrides: Partial<BatchCycleMetrics> = {}): BatchCycleMetrics {
  return {
    searchAttempts: 10, searchSuccesses: 9, searchFailures: 1, rawObservations: 55, acceptedObservations: 45,
    invalid: 1, homepages: 1, duplicates: 2, known: 3, poolCapExcluded: 0, sizeExcluded: 2, submittedCandidates: 36, promptBytes: 32000,
    submittedBySource: { brave: 36, rss: 0 },
    discoverySourceHealth: { brave: "degraded", rss: "healthy", outage: false },
    truncationStage: "tail", status: "validated", reservationAttempts: 1, reservations: 1, providerDispatches: 1,
    returnedStories: 4, acceptedStories: 4, selected: [{ candidateId: "c050", hostname: "example.test", score: 8, provenance: [{ kind: "brave", queryOrdinal: 10, resultOrdinal: 5 }] }],
    freshDelivered: 2, replayDelivered: 1, emailCount: 1, ...overrides,
  };
}

test("scheduled summary independently allowlists discovery source health", () => {
  const summary = createScheduledCycleSummary(monitoringResult({ batch: batchMetrics({
    discoverySourceHealth: { brave: "unavailable", rss: "unavailable", outage: true },
  }) }), environment());
  assert.deepEqual(summary.batch?.discoverySourceHealth, {
    brave: "unavailable", rss: "unavailable", outage: true,
  });

  const poisoned = monitoringResult({ batch: batchMetrics() });
  (poisoned.batch?.discoverySourceHealth as unknown as Record<string, unknown>).brave = "PRIVATE_PROVIDER_BODY";
  (poisoned.batch?.discoverySourceHealth as unknown as Record<string, unknown>).rss = "PRIVATE_PROVIDER_BODY";
  const serialized = JSON.stringify(createScheduledCycleSummary(poisoned, environment()));
  assert.equal(serialized.includes("PRIVATE_PROVIDER_BODY"), false);
});

test("scheduled summary copies every batch counter and distinguishes selected stories from one dispatch", () => {
  const summary = createScheduledCycleSummary(monitoringResult({ batch: batchMetrics() }), environment());
  assert.deepEqual(summary.batch, batchMetrics());
  assert.equal(summary.batch?.providerDispatches, 1); assert.equal(summary.batch?.acceptedStories, 4);
  const reservedOnly = createScheduledCycleSummary(monitoringResult({ batch: batchMetrics({ reservations: 1, providerDispatches: 0, status: "provider_failed", selected: [], acceptedStories: 0 }) }), environment());
  assert.equal(reservedOnly.batch?.reservations, 1); assert.equal(reservedOnly.batch?.providerDispatches, 0);
});

test("scheduled summary independently allowlists provider failure classification", () => {
  const classified = createScheduledCycleSummary(monitoringResult({ batch: batchMetrics({
    status: "provider_failed", providerFailureClass: "resource_exhausted_429",
  }) }), environment());
  assert.equal(classified.batch?.providerFailureClass, "resource_exhausted_429");

  const poisoned = monitoringResult({ batch: batchMetrics({ status: "provider_failed" }) });
  (poisoned.batch as unknown as Record<string, unknown>).providerFailureClass = "UNIQUE_PRIVATE_PROVIDER_TEXT";
  const serialized = JSON.stringify(createScheduledCycleSummary(poisoned, environment()));
  assert.equal(serialized.includes("providerFailureClass"), false);
  assert.equal(serialized.includes("UNIQUE_PRIVATE_PROVIDER_TEXT"), false);

  const inconsistent = createScheduledCycleSummary(monitoringResult({ batch: batchMetrics({
    status: "validated", providerFailureClass: "unavailable_503",
  }) }), environment());
  assert.equal(inconsistent.batch?.providerFailureClass, undefined);
});

test("scheduled summary allowlists and bounds RSS telemetry without source content", () => {
  const summary = createScheduledCycleSummary(monitoringResult({
    rss: {
      status: "collected", configuredFeeds: 999, attemptedFeeds: 999, succeededFeeds: 999, failedFeeds: 999,
      observedPositions: 999, validCandidates: 999, rejectedItems: 999, itemLimitTruncations: 999,
      outcomes: [
        { feedId: "openai_news", reason: "ok", elapsedMs: 6000 },
        { feedId: "forged_private_feed", reason: "http", httpStatus: 599, elapsedMs: 10 },
        { feedId: "github_changelog", reason: "http", httpStatus: 503, elapsedMs: -1 },
      ],
    },
  }), environment());
  assert.deepEqual(summary.rss, {
    status: "collected", configuredFeeds: 5, attemptedFeeds: 5, succeededFeeds: 5, failedFeeds: 5,
    observedPositions: 25, validCandidates: 25, rejectedItems: 25, itemLimitTruncations: 5,
    outcomes: [
      { feedId: "openai_news", reason: "ok", elapsedMs: 5000 },
      { feedId: "github_changelog", reason: "http", httpStatus: 503, elapsedMs: 0 },
    ],
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /forged_private_feed|sourceUrl|snippet|private/i);
});

test("scheduled selected telemetry retains bounded mixed Brave and RSS provenance", () => {
  const summary = createScheduledCycleSummary(monitoringResult({ batch: batchMetrics({ selected: [{
    candidateId: "c001", hostname: "example.test", score: 8,
    provenance: [
      { kind: "brave", queryOrdinal: 10, resultOrdinal: 5 },
      { kind: "rss", feedId: "openai_news", itemOrdinal: 5 },
      { kind: "rss", feedId: "forged", itemOrdinal: 1 },
    ],
  }] }) }), environment());
  assert.deepEqual(summary.batch?.selected[0]?.provenance, [
    { kind: "brave", queryOrdinal: 10, resultOrdinal: 5 },
    { kind: "rss", feedId: "openai_news", itemOrdinal: 5 },
  ]);
});

test("scheduled selected telemetry retains bounded low-relevance Batch stories", () => {
  const summary = createScheduledCycleSummary(monitoringResult({ batch: batchMetrics({ selected: [
    { candidateId: "c001", hostname: "example.test", score: 6, provenance: [] },
    { candidateId: "c002", hostname: "example.test", score: 1, provenance: [] },
  ] }) }), environment());
  assert.deepEqual(summary.batch?.selected.map(entry => entry.score), [6, 1]);
});

test("scheduled batch serialization allowlists and bounds malicious selected evidence and every diagnostic string", () => {
  const env = environment(); const secret = env.GEMINI_API_KEY;
  const fullSourceUrl = "https://private.example.test/story?token=private";
  const selected = Array.from({ length: 8 }, (_, i) => ({ candidateId: `c00${i + 1}`, hostname: i === 0 ? `${secret}.test` : "a".repeat(260), score: 8,
    provenance: Array.from({ length: 100 }, (_, p) => ({ kind: "brave" as const, queryOrdinal: Math.floor((p % 50) / 5) + 1, resultOrdinal: p % 5 + 1, sourceUrl: fullSourceUrl })), sourceTitle: env.NOTIFICATION_EMAIL, sourceUrl: fullSourceUrl }));
  const input = monitoringResult({ batch: { ...batchMetrics({ selected }), prompt: secret, response: env.NOTIFICATION_EMAIL } as BatchCycleMetrics });
  const summary = createScheduledCycleSummary(input, env);
  assert.ok(summary.batch); assert.equal(summary.batch.selected.length, 4);
  assert.ok(summary.batch.selected.reduce((n, entry) => n + entry.provenance.length, 0) <= 75);
  assert.ok(summary.batch.selected.every(entry => entry.hostname.length <= 253));
  const serialized = JSON.stringify(summary);
  for (const text of [secret, env.NOTIFICATION_EMAIL, fullSourceUrl, "sourceTitle", "sourceUrl", '"prompt":', '"response":']) assert.equal(serialized.includes(text), false, text);
  const invalid = createScheduledCycleSummary(monitoringResult({ batch: batchMetrics({ selected: [
    { candidateId: "c051", hostname: "valid.test", score: 8, provenance: [] },
    { candidateId: "c001", hostname: "valid.test", score: 11, provenance: [] },
    { candidateId: "c002", hostname: "valid.test", score: 7, provenance: [{ kind: "brave", queryOrdinal: 11, resultOrdinal: 1 }, { kind: "brave", queryOrdinal: 1, resultOrdinal: 6 }, { kind: "brave", queryOrdinal: 2, resultOrdinal: 3 }] },
  ] }) }), env);
  assert.deepEqual(invalid.batch?.selected, [{ candidateId: "c002", hostname: "valid.test", score: 7, provenance: [{ kind: "brave", queryOrdinal: 2, resultOrdinal: 3 }] }]);
});

test("scheduled serializer rejects arbitrary strings injected into enum, model-map and status fields", () => {
  const env = environment(); const poisoned = `${env.GEMINI_API_KEY} https://private.test/path a@b.test Bearer hidden\u0000`;
  const input = monitoringResult({ batch: batchMetrics(), searchFailures: [{ queryOrdinal: 1, error: poisoned }], outcomes: [{ sourceTitle: "private", sourceUrl: "https://private.test/path", error: poisoned }] });
  (input.batch as unknown as Record<string, unknown>).status = poisoned;
  (input.batch as unknown as Record<string, unknown>).truncationStage = poisoned;
  (input.geminiRequestsByModel as unknown as Record<string, unknown>)[poisoned] = poisoned;
  (input.outcomes[0] as unknown as Record<string, unknown>).discoveryStatus = poisoned;
  (input.outcomes[0] as unknown as Record<string, unknown>).notificationStatus = poisoned;
  (input as unknown as Record<string, unknown>).geminiBlockedReason = poisoned;
  (input as unknown as Record<string, unknown>).xBlockedReason = poisoned;
  input.xFailures = [{ accountOrdinal: 1, reason: poisoned as never }];
  const serialized = JSON.stringify(createScheduledCycleSummary(input, env));
  for (const forbidden of [env.GEMINI_API_KEY, "private.test", "a@b.test", "hidden", "\\u0000"]) assert.equal(serialized.includes(forbidden), false, forbidden);
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
  env.X_BEARER_TOKEN = "x-bearer-secret";
  const longError = [
    "Request failed for https://example.test/private/story?id=123&token=something",
    env.BRAVE_SEARCH_API_KEY,
    env.GEMINI_API_KEY,
    env.RESEND_API_KEY,
    env.NOTIFICATION_EMAIL,
    env.CONTROLLED_EXECUTION_TOKEN,
    env.X_BEARER_TOKEN,
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
