import { D1BraveUsageStore } from "./services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "./services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "./services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "./services/d1NotificationHistory.js";
import { inspectGeminiAvailability } from "./services/geminiUsageGuard.js";
import { analyzeSearchResult } from "./services/analysisAgent.js";
import { processSearchResult } from "./services/discoveryProcessor.js";
import { createMonitoringRuntimeConfiguration } from "./services/radarRuntimeConfiguration.js";
import { createGeminiCycleContext, generateWithGemini } from "./tools/llm/gemini.js";
import { sendWithResend } from "./tools/email/resend.js";
import { searchWeb } from "./tools/webSearch.js";
import { runMonitoringCycle, type MonitoringCycleDependencies } from "./services/monitor.js";
import { D1XStore } from "./services/d1XStore.js";
import { collectXDiscoveries } from "./services/xDiscovery.js";
import type { MonitoringCycleResult } from "./types/index.js";

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

function redactScheduledError(error: string, env: RadarWorkerEnv): string {
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
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, "[redacted-url]");
  for (const sensitiveValue of sensitiveValues) {
    safeError = safeError.split(sensitiveValue).join("[redacted]");
  }
  return safeError.slice(0, MAX_SCHEDULED_ERROR_LENGTH);
}

/** Builds the bounded, secret-free payload emitted after a successful scheduled cycle. */
export function createScheduledCycleSummary(
  result: MonitoringCycleResult,
  env: RadarWorkerEnv,
): ScheduledCycleSummary {
  const searchFailures = result.searchFailures
    .slice(0, MAX_SCHEDULED_SEARCH_FAILURES_LOGGED)
    .map((failure) => ({
      queryOrdinal: failure.queryOrdinal,
      error: redactScheduledError(failure.error, env),
    }));
  const outcomes = result.outcomes
    .slice(0, MAX_SCHEDULED_OUTCOMES_LOGGED)
    .map((outcome, index) => ({
      ordinal: index + 1,
      discoveryStatus: outcome.discoveryStatus,
      notificationStatus: outcome.notificationStatus,
      failed: outcome.error !== undefined,
      ...(outcome.error === undefined ? {} : { error: redactScheduledError(outcome.error, env) }),
    }));

  return {
    event: "scheduled_monitoring_cycle_completed",
    searchResultsReceived: result.searchResultsReceived,
    searchFailuresTotal: result.searchFailures.length,
    searchFailuresOmitted: Math.max(0, result.searchFailures.length - searchFailures.length),
    searchFailures,
    resultsProcessed: result.resultsProcessed,
    newDiscoveries: result.newDiscoveries,
    duplicates: result.duplicates,
    analysesAttempted: result.analysesAttempted,
    notificationsSent: result.notificationsSent,
    notificationsAlreadySent: result.notificationsAlreadySent,
    notificationsNotEligible: result.notificationsNotEligible,
    failures: result.failures,
    stoppedByAnalysisCap: result.stoppedByAnalysisCap,
    geminiProviderAttempts: result.geminiProviderAttempts,
    geminiFallbacks: result.geminiFallbacks,
    analysesUsingFallbackModel: result.analysesUsingFallbackModel,
    geminiRequestsByModel: { ...result.geminiRequestsByModel },
    replayCandidatesConsidered: result.replayCandidatesConsidered,
    replayCandidatesEligible: result.replayCandidatesEligible,
    freshStoriesSent: result.freshStoriesSent,
    replayStoriesSent: result.replayStoriesSent,
    replayLookupTruncated: result.replayLookupTruncated,
    xRequestsAttempted: result.xRequestsAttempted,
    xPostsReceived: result.xPostsReceived,
    xCandidatesAdmitted: result.xCandidatesAdmitted,
    xDuplicates: result.xDuplicates,
    xAccountsFailed: result.xAccountsFailed,
    xTruncated: result.xTruncated,
    xFailures: result.xFailures.slice(0, 5).map((failure) => ({ ...failure })),
    ...(result.xBlockedReason === undefined ? {} : { xBlockedReason: result.xBlockedReason }),
    ...(result.geminiBlockedReason === undefined ? {} : { geminiBlockedReason: result.geminiBlockedReason }),
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
    xStore: new D1XStore(env.DB),
  };
}

/** Creates cloud-ready cycle dependencies without invoking a monitoring cycle. */
export interface WorkerMonitoringDependencyOverrides {
  readonly searchWeb?: typeof searchWeb;
}

export function createWorkerMonitoringDependencies(
  env: RadarWorkerEnv,
  overrides: WorkerMonitoringDependencyOverrides = {},
): MonitoringCycleDependencies {
  const configuration = createMonitoringRuntimeConfiguration(env as unknown as Record<string, string | undefined>);
  const persistence = createWorkerPersistence(env);
  const geminiCycleContext = createGeminiCycleContext();
  const workerSearchWeb = overrides.searchWeb ?? searchWeb;

  return {
    history: persistence.discoveryHistory,
    geminiCycleContext,
    geminiPreflight: (now) => inspectGeminiAvailability(persistence.geminiUsageStore, configuration.environment, now),
    search: (query, options) => workerSearchWeb(query, {
      usageTracker: persistence.braveUsageStore,
      environment: configuration.environment,
      freshness: options?.freshness,
    }),
    collectX: (now) => collectXDiscoveries({ store: persistence.xStore, environment: configuration.environment, now }),
    resolveXPost: (postId) => persistence.xStore.getStoryByPostId(postId),
    markXStoryProcessed: (storyUrl) => persistence.xStore.markStoryProcessed(storyUrl),
    process: (result, sourceProvenance) => processSearchResult(result, {
      history: persistence.discoveryHistory,
      sourceProvenance,
      analyze: (searchResult) => analyzeSearchResult(searchResult, {
        generate: (input) => generateWithGemini(input, {
          usageTracker: persistence.geminiUsageStore,
          environment: configuration.environment,
          cycleContext: geminiCycleContext,
        }),
        onValidatedAnalysis: (response) => {
          if (response.usedFallback) geminiCycleContext.analysesUsingFallbackModel += 1;
        },
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
    ?? (() => runMonitoringCycle(undefined, createWorkerMonitoringDependencies(env)));
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
