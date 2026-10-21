import { D1BraveUsageStore } from "./services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "./services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "./services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "./services/d1NotificationHistory.js";
import { inspectGeminiAvailability } from "./services/geminiUsageGuard.js";
import { analyzeBatch } from "./services/analysisAgent.js";
import { createMonitoringRuntimeConfiguration } from "./services/radarRuntimeConfiguration.js";
import { createGeminiBatchCycleContext, generateBatchWithGemini } from "./tools/llm/gemini.js";
import { sendWithResend } from "./tools/email/resend.js";
import { searchWebPage } from "./tools/webSearch.js";
import { runBatchMonitoringCycle, type BatchMonitoringDependencies } from "./services/monitor.js";
import { collectRss } from "./services/rssDiscovery.js";
import { RSS_FEEDS } from "./config/rssSources.js";
import type { BatchCycleMetrics, MonitoringCycleResult, RssCycleMetrics } from "./types/index.js";

export const MAX_SCHEDULED_OUTCOMES_LOGGED = 10;
export const MAX_SCHEDULED_SEARCH_FAILURES_LOGGED = 10;
export const MAX_SCHEDULED_ERROR_LENGTH = 160;

/** Worker binding names only. Secret values are configured outside source control in Step 8.3. */
export interface RadarWorkerEnv {
  DB: D1Database;
  BRAVE_SEARCH_API_KEY: string;
  BRAVE_DAILY_SEARCH_LIMIT: string;
  BRAVE_WEEKLY_SEARCH_LIMIT: string;
  BRAVE_MONTHLY_SEARCH_LIMIT: string;
  GEMINI_API_KEY: string;
  /** @deprecated Ignored; the approved model pool is source-controlled. */
  GEMINI_MODEL?: string;
  GEMINI_DAILY_REQUEST_LIMIT: string;
  GEMINI_WEEKLY_REQUEST_LIMIT: string;
  GEMINI_MONTHLY_REQUEST_LIMIT: string;
  GEMINI_DAILY_TOKEN_LIMIT: string;
  GEMINI_WEEKLY_TOKEN_LIMIT: string;
  GEMINI_MONTHLY_TOKEN_LIMIT: string;
  RESEND_API_KEY: string;
  NOTIFICATION_EMAIL: string;
  CONTROLLED_EXECUTION_TOKEN?: string;
  X_DISCOVERY_ENABLED?: string;
  X_BEARER_TOKEN?: string;
}

export interface ScheduledCycleSummary {
  batch?: BatchCycleMetrics;
  rss?: RssCycleMetrics;
  event: "scheduled_monitoring_cycle_completed";
  searchResultsReceived: number;
  searchFailuresTotal: number;
  searchFailuresOmitted: number;
  searchFailures: Array<{
    queryOrdinal: number;
    error: string;
  }>;
  resultsProcessed: number;
  newDiscoveries: number;
  duplicates: number;
  analysesAttempted: number;
  notificationsSent: number;
  notificationsAlreadySent: number;
  notificationsNotEligible: number;
  failures: number;
  stoppedByAnalysisCap: boolean;
  geminiProviderAttempts: number;
  geminiFallbacks: number;
  analysesUsingFallbackModel: number;
  geminiRequestsByModel: MonitoringCycleResult["geminiRequestsByModel"];
  geminiTimeoutIncompleteAccounting?: NonNullable<MonitoringCycleResult["geminiTimeoutIncompleteAccounting"]>;
  replayCandidatesConsidered: number;
  replayCandidatesEligible: number;
  freshStoriesSent: number;
  replayStoriesSent: number;
  replayLookupTruncated: boolean;
  xRequestsAttempted: number;
  xPostsReceived: number;
  xCandidatesAdmitted: number;
  xDuplicates: number;
  xAccountsFailed: number;
  xTruncated: boolean;
  xFailures: MonitoringCycleResult["xFailures"];
  xBlockedReason?: MonitoringCycleResult["xBlockedReason"];
  geminiBlockedReason?: MonitoringCycleResult["geminiBlockedReason"];
  outcomesTotal: number;
  outcomesOmitted: number;
  outcomes: Array<{
    ordinal: number;
    discoveryStatus?: "new" | "duplicate";
    notificationStatus?: "not_eligible" | "already_sent" | "sent";
    failed: boolean;
    error?: string;
  }>;
}

export interface ScheduledMonitoringDependencies {
  runCycle?: () => Promise<MonitoringCycleResult>;
  logInfo?: (summary: ScheduledCycleSummary) => void;
}

function redactScheduledError(error: string, env: RadarWorkerEnv, maximumLength = MAX_SCHEDULED_ERROR_LENGTH): string {
  const sensitiveValues = [
    env.BRAVE_SEARCH_API_KEY,
    env.GEMINI_API_KEY,
    env.RESEND_API_KEY,
    env.NOTIFICATION_EMAIL,
    env.CONTROLLED_EXECUTION_TOKEN,
    env.X_BEARER_TOKEN,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);

  let safeError = error
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, "[redacted-url]");
  for (const sensitiveValue of sensitiveValues) {
    safeError = safeError.split(sensitiveValue).join("[redacted]");
  }
  return safeError.slice(0, maximumLength);
}

function boundedCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function allowedString<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

/** Copies only bounded application evidence; never serialize the candidate map or model/source text. */
function summarizeBatch(batch: BatchCycleMetrics, env: RadarWorkerEnv): BatchCycleMetrics {
  const selected: BatchCycleMetrics["selected"] = [];
  let remainingProvenance = 75;
  const approvedFeedIds = new Set(RSS_FEEDS.map(feed => feed.id));
  for (const entry of (Array.isArray(batch.selected) ? batch.selected : []).slice(0, 4)) {
    if (!entry || typeof entry.candidateId !== "string" || !/^c(?:00[1-9]|0[1-4][0-9]|050)$/.test(entry.candidateId)
      || !Number.isInteger(entry.score) || entry.score < 1 || entry.score > 10) continue;
    const hostname = typeof entry.hostname === "string"
      && entry.hostname.length <= 253 && /^[A-Za-z0-9.:[\]-]+$/.test(entry.hostname)
      && redactScheduledError(entry.hostname, env, 253) === entry.hostname ? entry.hostname : "[redacted]";
    const provenance: BatchCycleMetrics["selected"][number]["provenance"] = [];
    const seen = new Set<string>();
    for (const pair of (Array.isArray(entry.provenance) ? entry.provenance : []).slice(0, 50)) {
      if (remainingProvenance === 0) break;
      if (!pair || typeof pair !== "object") continue;
      const valid = pair.kind === "brave"
        ? Number.isInteger(pair.queryOrdinal) && pair.queryOrdinal >= 1 && pair.queryOrdinal <= 10
          && Number.isInteger(pair.resultOrdinal) && pair.resultOrdinal >= 1 && pair.resultOrdinal <= 5
        : pair.kind === "rss" && typeof pair.feedId === "string" && approvedFeedIds.has(pair.feedId)
          && Number.isInteger(pair.itemOrdinal) && pair.itemOrdinal >= 1 && pair.itemOrdinal <= 5;
      if (!valid) continue;
      const key = pair.kind === "brave" ? `b:${pair.queryOrdinal}:${pair.resultOrdinal}` : `r:${pair.feedId}:${pair.itemOrdinal}`;
      if (seen.has(key)) continue;
      seen.add(key); remainingProvenance--;
      provenance.push(pair.kind === "brave"
        ? { kind: "brave", queryOrdinal: pair.queryOrdinal, resultOrdinal: pair.resultOrdinal }
        : { kind: "rss", feedId: pair.feedId, itemOrdinal: pair.itemOrdinal });
    }
    selected.push({ candidateId: entry.candidateId, hostname, score: entry.score, provenance });
  }
  const status = allowedString(batch.status, ["empty", "blocked", "preparation_failed", "provider_failed", "timeout", "invalid_output", "validated"]) ?? "preparation_failed";
  const providerFailureClass = allowedString(batch.providerFailureClass, ["resource_exhausted_429", "unavailable_503"] as const);
  const braveHealth = allowedString(batch.discoverySourceHealth?.brave, ["healthy", "degraded", "unavailable", "quota_blocked"] as const) ?? "unavailable";
  const rssHealth = allowedString(batch.discoverySourceHealth?.rss, ["healthy", "degraded", "unavailable"] as const) ?? "unavailable";
  return {
    searchAttempts: boundedCount(batch.searchAttempts, 10), searchSuccesses: boundedCount(batch.searchSuccesses, 10), searchFailures: boundedCount(batch.searchFailures, 10),
    rawObservations: boundedCount(batch.rawObservations, 75), acceptedObservations: boundedCount(batch.acceptedObservations, 75),
    invalid: boundedCount(batch.invalid, 75), homepages: boundedCount(batch.homepages, 75), duplicates: boundedCount(batch.duplicates, 75), known: boundedCount(batch.known, 75),
    poolCapExcluded: boundedCount(batch.poolCapExcluded, 75),
    sizeExcluded: boundedCount(batch.sizeExcluded, 50), submittedCandidates: boundedCount(batch.submittedCandidates, 50), promptBytes: boundedCount(batch.promptBytes, 32768),
    submittedBySource: { brave: boundedCount(batch.submittedBySource?.brave, 50), rss: boundedCount(batch.submittedBySource?.rss, 25) },
    discoverySourceHealth: {
      brave: braveHealth,
      rss: rssHealth,
      outage: braveHealth === "unavailable" && rssHealth === "unavailable",
    },
    truncationStage: allowedString(batch.truncationStage, ["initial", "snippet384", "snippet192", "snippet96", "snippet0", "title128", "tail"] as const) ?? null,
    status,
    ...(status === "provider_failed" && providerFailureClass !== undefined ? { providerFailureClass } : {}),
    reservationAttempts: boundedCount(batch.reservationAttempts, 1), reservations: boundedCount(batch.reservations, 1), providerDispatches: boundedCount(batch.providerDispatches, 1),
    returnedStories: boundedCount(batch.returnedStories, 4), acceptedStories: boundedCount(batch.acceptedStories, 4), selected,
    freshDelivered: boundedCount(batch.freshDelivered, 4), replayDelivered: boundedCount(batch.replayDelivered, 4), emailCount: boundedCount(batch.emailCount, 1),
  };
}

function summarizeRss(rss: RssCycleMetrics): RssCycleMetrics {
  const approvedFeedIds = new Set(RSS_FEEDS.map(feed => feed.id));
  const outcomes = (Array.isArray(rss.outcomes) ? rss.outcomes : []).slice(0, 5).flatMap(outcome => {
    if (!outcome || !approvedFeedIds.has(outcome.feedId)) return [];
    const reason = allowedString(outcome.reason, ["disabled", "configuration", "http", "redirect", "timeout", "body_limit", "encoding", "parse", "structure", "ok"] as const);
    if (!reason) return [];
    const httpStatus = Number.isInteger(outcome.httpStatus) && outcome.httpStatus! >= 100 && outcome.httpStatus! <= 599 ? outcome.httpStatus : undefined;
    return [{ feedId: outcome.feedId, reason, ...(httpStatus === undefined ? {} : { httpStatus }), elapsedMs: boundedCount(outcome.elapsedMs, 5000) }];
  });
  return {
    status: allowedString(rss.status, ["disabled", "configuration", "collected"] as const) ?? "configuration",
    configuredFeeds: boundedCount(rss.configuredFeeds, 5), attemptedFeeds: boundedCount(rss.attemptedFeeds, 5),
    succeededFeeds: boundedCount(rss.succeededFeeds, 5), failedFeeds: boundedCount(rss.failedFeeds, 5),
    observedPositions: boundedCount(rss.observedPositions, 25), validCandidates: boundedCount(rss.validCandidates, 25),
    rejectedItems: boundedCount(rss.rejectedItems, 25), itemLimitTruncations: boundedCount(rss.itemLimitTruncations, 5), outcomes,
  };
}

/** Builds the bounded, secret-free payload emitted after a successful scheduled cycle. */
export function createScheduledCycleSummary(
  result: MonitoringCycleResult,
  env: RadarWorkerEnv,
): ScheduledCycleSummary {
  const searchFailures = result.searchFailures
    .slice(0, MAX_SCHEDULED_SEARCH_FAILURES_LOGGED)
    .map((failure) => ({
      queryOrdinal: boundedCount(failure.queryOrdinal, 10),
      error: redactScheduledError(failure.error, env),
    }));
  const outcomes = result.outcomes
    .slice(0, MAX_SCHEDULED_OUTCOMES_LOGGED)
    .map((outcome, index) => ({
      ordinal: index + 1,
      discoveryStatus: allowedString(outcome.discoveryStatus, ["new", "duplicate"]),
      notificationStatus: allowedString(outcome.notificationStatus, ["not_eligible", "already_sent", "sent"]),
      failed: outcome.error !== undefined,
      ...(outcome.error === undefined ? {} : { error: redactScheduledError(outcome.error, env) }),
    }));

  return {
    event: "scheduled_monitoring_cycle_completed",
    ...(result.batch === undefined ? {} : { batch: summarizeBatch(result.batch, env) }),
    ...(result.rss === undefined ? {} : { rss: summarizeRss(result.rss) }),
    searchResultsReceived: boundedCount(result.searchResultsReceived),
    searchFailuresTotal: result.searchFailures.length,
    searchFailuresOmitted: Math.max(0, result.searchFailures.length - searchFailures.length),
    searchFailures,
    resultsProcessed: boundedCount(result.resultsProcessed),
    newDiscoveries: boundedCount(result.newDiscoveries),
    duplicates: boundedCount(result.duplicates),
    analysesAttempted: boundedCount(result.analysesAttempted),
    notificationsSent: boundedCount(result.notificationsSent),
    notificationsAlreadySent: boundedCount(result.notificationsAlreadySent),
    notificationsNotEligible: boundedCount(result.notificationsNotEligible),
    failures: boundedCount(result.failures),
    stoppedByAnalysisCap: result.stoppedByAnalysisCap === true,
    geminiProviderAttempts: boundedCount(result.geminiProviderAttempts),
    geminiFallbacks: boundedCount(result.geminiFallbacks),
    analysesUsingFallbackModel: boundedCount(result.analysesUsingFallbackModel),
    geminiRequestsByModel: {
      "gemini-3.8-flash": boundedCount(result.geminiRequestsByModel["gemini-3.8-flash"]),
      "gemini-3.6-flash": boundedCount(result.geminiRequestsByModel["gemini-3.6-flash"]),
      "gemini-3.5-flash-lite": boundedCount(result.geminiRequestsByModel["gemini-3.5-flash-lite"]),
    },
    ...(result.geminiTimeoutIncompleteAccounting === undefined ? {} : {
      geminiTimeoutIncompleteAccounting: {
        dailyRequests: boundedCount(result.geminiTimeoutIncompleteAccounting.dailyRequests),
        weeklyRequests: boundedCount(result.geminiTimeoutIncompleteAccounting.weeklyRequests),
        monthlyRequests: boundedCount(result.geminiTimeoutIncompleteAccounting.monthlyRequests),
      },
    }),
    replayCandidatesConsidered: boundedCount(result.replayCandidatesConsidered),
    replayCandidatesEligible: boundedCount(result.replayCandidatesEligible),
    freshStoriesSent: boundedCount(result.freshStoriesSent),
    replayStoriesSent: boundedCount(result.replayStoriesSent),
    replayLookupTruncated: result.replayLookupTruncated === true,
    xRequestsAttempted: boundedCount(result.xRequestsAttempted),
    xPostsReceived: boundedCount(result.xPostsReceived),
    xCandidatesAdmitted: boundedCount(result.xCandidatesAdmitted),
    xDuplicates: boundedCount(result.xDuplicates),
    xAccountsFailed: boundedCount(result.xAccountsFailed),
    xTruncated: result.xTruncated === true,
    xFailures: result.xFailures.slice(0, 5).flatMap(failure => {
      const reason = allowedString(failure.reason, ["auth", "rate_limit", "account_unavailable", "timeout", "provider_error", "malformed_response", "state_unavailable", "contract_drift"]);
      return reason && Number.isInteger(failure.accountOrdinal) && failure.accountOrdinal >= 1 && failure.accountOrdinal <= 5 ? [{ accountOrdinal: failure.accountOrdinal, reason }] : [];
    }),
    ...(allowedString(result.xBlockedReason, ["disabled", "config", "auth", "rate_limit", "budget", "state_unavailable", "price_expired", "contract_drift"]) === undefined ? {} : { xBlockedReason: result.xBlockedReason }),
    ...(allowedString(result.geminiBlockedReason, ["usage_unknown", "daily_request_limit", "weekly_request_limit", "monthly_request_limit", "daily_token_limit", "weekly_token_limit", "monthly_token_limit", "usage_state_unavailable", "invalid_configuration"]) === undefined ? {} : { geminiBlockedReason: result.geminiBlockedReason }),
    outcomesTotal: result.outcomes.length,
    outcomesOmitted: Math.max(0, result.outcomes.length - outcomes.length),
    outcomes,
  };
}

/** Composes cloud persistence without starting a monitoring cycle or invoking a provider. */
export function createWorkerPersistence(env: RadarWorkerEnv) {
  return {
    discoveryHistory: new D1DiscoveryHistory(env.DB),
    notificationHistory: new D1NotificationHistory(env.DB),
    braveUsageStore: new D1BraveUsageStore(env.DB),
    geminiUsageStore: new D1GeminiUsageStore(env.DB),
  };
}

/** Creates cloud-ready cycle dependencies without invoking a monitoring cycle. */
export interface WorkerMonitoringDependencyOverrides {
  readonly searchPage?: typeof searchWebPage;
  readonly collectRss?: BatchMonitoringDependencies["collectRss"];
}

export const workerdRssFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export function createWorkerMonitoringDependencies(
  env: RadarWorkerEnv,
  overrides: WorkerMonitoringDependencyOverrides = {},
): BatchMonitoringDependencies {
  const configuration = createMonitoringRuntimeConfiguration(env as unknown as Record<string, string | undefined>);
  const persistence = createWorkerPersistence(env);
  const geminiCycleContext = createGeminiBatchCycleContext();
  const workerSearchPage = overrides.searchPage ?? searchWebPage;

  return {
    history: persistence.discoveryHistory,
    geminiCycleContext,
    geminiPreflight: (now) => inspectGeminiAvailability(persistence.geminiUsageStore, configuration.environment, now),
    searchPage: (query, options) => workerSearchPage(query, {
      usageTracker: persistence.braveUsageStore,
      environment: configuration.environment,
      freshness: options?.freshness,
    }),
    collectRss: overrides.collectRss ?? (now => collectRss({ now, fetch: workerdRssFetch })),
    analyze: batch => analyzeBatch(batch, {
      generate: input => generateBatchWithGemini(input, {
        usageTracker: persistence.geminiUsageStore,
        environment: configuration.environment,
        cycleContext: geminiCycleContext,
      }),
    }),
    notification: {
      history: persistence.notificationHistory,
      sendEmail: (content) => sendWithResend(content, {
        environment: configuration.environment,
      }),
    },
  };
}

/** Executes one bounded monitoring cycle only when Cloudflare delivers a scheduled event. */
export async function runScheduledMonitoring(
  env: RadarWorkerEnv,
  dependencies: ScheduledMonitoringDependencies = {},
): Promise<MonitoringCycleResult> {
  const runCycle = dependencies.runCycle
    ?? (() => runBatchMonitoringCycle(createWorkerMonitoringDependencies(env)));
  const result = await runCycle();
  (dependencies.logInfo ?? ((summary) => console.info(summary)))(createScheduledCycleSummary(result, env));
  return result;
}

/** Registers the single scheduled cycle promise with Cloudflare's event lifetime. */
export function handleScheduledMonitoring(
  env: RadarWorkerEnv,
  context: ExecutionContext,
  dependencies: ScheduledMonitoringDependencies = {},
): void {
  context.waitUntil(runScheduledMonitoring(env, dependencies));
}

export default {
  fetch(_request: Request, env: RadarWorkerEnv): Response {
    createWorkerPersistence(env);
    return new Response("AI Agent Radar worker ready", {
      headers: { "content-type": "text/plain; charset=UTF-8" },
    });
  },
  scheduled(_event: ScheduledEvent, env: RadarWorkerEnv, context: ExecutionContext): void {
    handleScheduledMonitoring(env, context);
  },
};
