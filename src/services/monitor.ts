import { JsonDiscoveryHistory, DiscoveryHistoryError, type DiscoveryHistory } from "./discoveryHistory.js";
import { processSearchResult } from "./discoveryProcessor.js";
import { NotificationHistoryError } from "./notificationHistory.js";
import { notifyDiscovery, type NotificationOrchestratorDependencies } from "./notificationOrchestrator.js";
import { LocalJsonBraveUsageStore } from "./localJsonBraveUsageStore.js";
import { LocalJsonGeminiUsageStore } from "./localJsonGeminiUsageStore.js";
import { JsonNotificationHistory } from "./notificationHistory.js";
import { generateWithGemini } from "../tools/llm/gemini.js";
import { analyzeSearchResult } from "./analysisAgent.js";
import { searchWeb } from "../tools/webSearch.js";
import type { DiscoveryProcessingResult, MonitoringCycleResult, NotificationResult, SearchResult } from "../types/index.js";

export const MONITORING_QUERY = "new AI agent developer tool framework release";
export const MAX_NEW_ANALYSES_PER_CYCLE = 1;

type WebSearch = (query: string) => Promise<SearchResult[]>;
type DiscoveryLookup = (url: string) => Promise<boolean>;
type DiscoveryProcessor = (result: SearchResult) => Promise<DiscoveryProcessingResult>;
type NotificationProcessor = (result: DiscoveryProcessingResult) => Promise<NotificationResult>;

export interface MonitoringCycleDependencies {
  search?: WebSearch;
  /** Optional persistence adapter shared by duplicate checks and discovery processing. */
  history?: DiscoveryHistory;
  hasDiscovery?: DiscoveryLookup;
  process?: DiscoveryProcessor;
  /** Optional dependencies for the provider-independent notification orchestration. */
  notification?: NotificationOrchestratorDependencies;
  notify?: NotificationProcessor;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown error").slice(0, 500);
}

function emptyResult(query: string, searchResultsReceived: number): MonitoringCycleResult {
  return {
    query,
    searchResultsReceived,
    resultsProcessed: 0,
    newDiscoveries: 0,
    duplicates: 0,
    analysesAttempted: 0,
    notificationsSent: 0,
    notificationsAlreadySent: 0,
    notificationsNotEligible: 0,
    failures: 0,
    stoppedByAnalysisCap: false,
    outcomes: [],
  };
}

function recordNotification(result: MonitoringCycleResult, notification: NotificationResult): void {
  if (notification.status === "sent") result.notificationsSent += 1;
  if (notification.status === "already_sent") result.notificationsAlreadySent += 1;
  if (notification.status === "not_eligible") result.notificationsNotEligible += 1;
}

/** Runs one sequential discovery, analysis, and notification cycle. */
export async function runMonitoringCycle(
  query = MONITORING_QUERY,
  dependencies: MonitoringCycleDependencies = {},
): Promise<MonitoringCycleResult> {
  const search = dependencies.search ?? ((searchQuery: string) => searchWeb(searchQuery, { usageTracker: new LocalJsonBraveUsageStore() }));
  let searchResults: SearchResult[];
  try {
    searchResults = await search(query);
  } catch (error) {
    throw new Error(`Monitoring cycle search failed: ${errorMessage(error)}`);
  }

  const result = emptyResult(query, searchResults.length);
  const discoveryHistory = dependencies.history ?? new JsonDiscoveryHistory();
  const hasDiscovery = dependencies.hasDiscovery ?? (async (url: string) => (await discoveryHistory.getDiscovery(url)) !== undefined);
  const process = dependencies.process ?? ((searchResult: SearchResult) => processSearchResult(searchResult, {
    history: discoveryHistory,
    analyze: (result) => analyzeSearchResult(result, { generate: (input) => generateWithGemini(input, { usageTracker: new LocalJsonGeminiUsageStore() }) }),
  }));
  const notification = dependencies.notification ?? { history: new JsonNotificationHistory() };
  const notify = dependencies.notify ?? ((processingResult: DiscoveryProcessingResult) => notifyDiscovery(processingResult, notification));

  for (const searchResult of searchResults) {
    let knownDiscovery: boolean;
    try {
      knownDiscovery = await hasDiscovery(searchResult.url);
    } catch (error) {
      throw new Error(`Monitoring cycle aborted: unable to verify discovery history: ${errorMessage(error)}`);
    }

    if (!knownDiscovery && result.analysesAttempted >= MAX_NEW_ANALYSES_PER_CYCLE) {
      result.stoppedByAnalysisCap = true;
      break;
    }

    if (!knownDiscovery) result.analysesAttempted += 1;

    let processed: DiscoveryProcessingResult;
    try {
      processed = await process(searchResult);
    } catch (error) {
      if (error instanceof DiscoveryHistoryError) {
        throw new Error(`Monitoring cycle aborted: discovery history is unavailable: ${errorMessage(error)}`);
      }
      result.failures += 1;
      result.outcomes.push({ sourceTitle: searchResult.title, sourceUrl: searchResult.url, error: errorMessage(error) });
      continue;
    }

    result.resultsProcessed += 1;
    if (processed.status === "new") result.newDiscoveries += 1;
    if (processed.status === "duplicate") result.duplicates += 1;

    try {
      const notification = await notify(processed);
      recordNotification(result, notification);
      result.outcomes.push({
        sourceTitle: searchResult.title,
        sourceUrl: searchResult.url,
        discoveryStatus: processed.status,
        notificationStatus: notification.status,
      });
    } catch (error) {
      if (error instanceof NotificationHistoryError) {
        throw new Error(`Monitoring cycle aborted: notification history is unavailable: ${errorMessage(error)}`);
      }
      result.failures += 1;
      result.outcomes.push({
        sourceTitle: searchResult.title,
        sourceUrl: searchResult.url,
        discoveryStatus: processed.status,
        error: errorMessage(error),
      });
    }
  }

  return result;
}
