import assert from "node:assert/strict";
import test from "node:test";
import { createScheduledCycleSummary, type RadarWorkerEnv } from "../src/worker.js";
import type { BatchCycleMetrics, MonitoringCycleResult } from "../src/types/index.js";

function env(): RadarWorkerEnv {
  return { DB: {} as D1Database, BRAVE_SEARCH_API_KEY: "b", BRAVE_DAILY_SEARCH_LIMIT: "10", BRAVE_WEEKLY_SEARCH_LIMIT: "100",
    BRAVE_MONTHLY_SEARCH_LIMIT: "350", GEMINI_API_KEY: "g", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20",
    GEMINI_MONTHLY_REQUEST_LIMIT: "50", GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000",
    GEMINI_MONTHLY_TOKEN_LIMIT: "100000", RESEND_API_KEY: "r", NOTIFICATION_EMAIL: "radar@example.test" };
}

function batch(): BatchCycleMetrics {
  return { searchAttempts: 10, searchSuccesses: 10, searchFailures: 0, rawObservations: 47, acceptedObservations: 47,
    invalid: 0, homepages: 0, duplicates: 0, known: 0, poolCapExcluded: 0, sizeExcluded: 0, submittedCandidates: 24,
    promptBytes: 12000, submittedBySource: { brave: 24, rss: 0 }, discoverySourceHealth: { brave: "healthy", rss: "healthy", outage: false },
    truncationStage: "snippet128", status: "provider_failed", reservationAttempts: 1, reservations: 1, providerDispatches: 1,
    returnedStories: 0, acceptedStories: 0, selected: [], freshDelivered: 0, replayDelivered: 0, emailCount: 1,
    latency: { version: 1, preFilterInputCount: 47, selectedCount: 24, selectorExcluded: 23, byteExcluded: 0, submittedCount: 24,
      promptBytes: 12000, snippetBytesLimit: 128, thinkingMode: "low", executionMode: "synchronous",
      attemptTimings: [{ ordinal: 1, requestStartedAt: "2026-10-23T08:00:01.000Z", elapsedMs: 1234 }] } };
}

function result(value: BatchCycleMetrics): MonitoringCycleResult {
  return { query: "q", searchResultsReceived: 47, searchFailures: [], resultsProcessed: 0, newDiscoveries: 0, duplicates: 0,
    analysesAttempted: 1, notificationsSent: 1, notificationsAlreadySent: 0, notificationsNotEligible: 0, failures: 1,
    stoppedByAnalysisCap: false, geminiProviderAttempts: 1, geminiFallbacks: 0, analysesUsingFallbackModel: 0,
    geminiRequestsByModel: { "gemini-3.8-flash": 1, "gemini-3.6-flash": 0, "gemini-3.5-flash-lite": 0 },
    replayCandidatesConsidered: 0, replayCandidatesEligible: 0, freshStoriesSent: 0, replayStoriesSent: 0, replayLookupTruncated: false,
    xRequestsAttempted: 0, xPostsReceived: 0, xCandidatesAdmitted: 0, xDuplicates: 0, xAccountsFailed: 0, xTruncated: false,
    xFailures: [], outcomes: [], batch: value,
    delivery: { deliveryMode: "degraded", deliveryReason: "ai_unavailable", analyzedStories: 0, rawStories: 4, replayStories: 0,
      emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "not_required", finalizationReached: true } };
}

test("scheduled summary independently allowlists bounded latency evidence", () => {
  const summary = createScheduledCycleSummary(result(batch()), env());
  assert.deepEqual(summary.batch?.latency, batch().latency);

  const poisoned = batch();
  (poisoned.latency as unknown as Record<string, unknown>).thinkingMode = "PRIVATE_PROVIDER_TEXT";
  (poisoned.latency as unknown as Record<string, unknown>).attemptTimings = [
    { ordinal: 1, requestStartedAt: "PRIVATE_PROVIDER_TEXT", elapsedMs: 999999 },
  ];
  const serialized = JSON.stringify(createScheduledCycleSummary(result(poisoned), env()));
  assert.doesNotMatch(serialized, /PRIVATE_PROVIDER_TEXT/);
});
