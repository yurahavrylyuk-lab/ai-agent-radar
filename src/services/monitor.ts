import { JsonDiscoveryHistory, DiscoveryHistoryError, type DiscoveryHistory } from "./discoveryHistory.js";
import { normalizeDiscoveryUrl } from "./discoveryHistoryCore.js";
import { getPreAnalysisCandidatePriority, MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES } from "./discoveryPriority.js";
import { processSearchResult } from "./discoveryProcessor.js";
import { NotificationHistoryError } from "./notificationHistory.js";
import { notifyDigest, type NotificationOrchestratorDependencies } from "./notificationOrchestrator.js";
import { LocalJsonBraveUsageStore } from "./localJsonBraveUsageStore.js";
import { LocalJsonGeminiUsageStore } from "./localJsonGeminiUsageStore.js";
import { JsonNotificationHistory } from "./notificationHistory.js";
import { generateWithGemini } from "../tools/llm/gemini.js";
import { analyzeSearchResult } from "./analysisAgent.js";
import { BraveUsageGuardDeniedError, searchWeb } from "../tools/webSearch.js";
import type { DiscoveryProcessingResult, MonitoringCycleResult, NotificationResult, SearchResult } from "../types/index.js";

export const MONITORING_QUERY = "new AI agent developer tool framework release";
export const MONITORING_QUERIES = [
  "AI news research product announcements",
  "AI agent framework releases",
  "AI model releases GPT Gemini open-source models capabilities",
  "programming language compiler standard library releases",
  "cloud DevOps Kubernetes networking security advisories",
  "Codex AI coding assistant developer features releases",
  "Claude Code AI coding assistant developer features releases",
  "IDE CLI CI/CD code review developer tools releases",
  "AI assisted software development workflow productivity examples",
  "useful AI IT tools techniques workflow tutorials",
] as const;
export const MAX_NEW_ANALYSES_PER_CYCLE = 4;

type WebSearch = (query: string) => Promise<SearchResult[]>;
type DiscoveryLookup = (url: string) => Promise<boolean>;
type DiscoveryProcessor = (result: SearchResult) => Promise<DiscoveryProcessingResult>;
type NotificationProcessor = (results: DiscoveryProcessingResult[]) => Promise<Map<string, NotificationResult>>;

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

/** Runs one sequential discovery, analysis, and digest-notification cycle. */
export async function runMonitoringCycle(
  query: string | undefined = undefined,
  dependencies: MonitoringCycleDependencies = {},
): Promise<MonitoringCycleResult> {
  const search = dependencies.search ?? ((searchQuery: string) => searchWeb(searchQuery, { usageTracker: new LocalJsonBraveUsageStore() }));
  const queries = query === undefined ? MONITORING_QUERIES : [query];
  const searchResults: SearchResult[] = [];
  for (const searchQuery of queries) {
    try {
      searchResults.push(...await search(searchQuery));
    } catch (error) {
      if (query === undefined && error instanceof BraveUsageGuardDeniedError) break;
      throw new Error(`Monitoring cycle search failed: ${errorMessage(error)}`);
    }
  }

  const result = emptyResult(query ?? MONITORING_QUERIES.join(" | "), searchResults.length);
  const discoveryHistory = dependencies.history ?? new JsonDiscoveryHistory();
  const hasDiscovery = dependencies.hasDiscovery ?? (async (url: string) => (await discoveryHistory.getDiscovery(url)) !== undefined);
  const process = dependencies.process ?? ((searchResult: SearchResult) => processSearchResult(searchResult, {
    history: discoveryHistory,
    analyze: (r) => analyzeSearchResult(r, { generate: (input) => generateWithGemini(input, { usageTracker: new LocalJsonGeminiUsageStore() }) }),
  }));
  const notification = dependencies.notification ?? { history: new JsonNotificationHistory() };
  const notify = dependencies.notify ?? ((results: DiscoveryProcessingResult[]) => notifyDigest(results, notification));

  // Phase 1: Identify unique unseen candidates before assigning scarce analysis slots.
  type Candidate = {
    searchResult: SearchResult;
    normalizedUrl: string;
    knownDiscovery: boolean;
    repeatedInBatch: boolean;
  };
  const candidates: Candidate[] = [];
  const firstCandidateByUrl = new Map<string, Candidate>();
  for (const searchResult of searchResults) {
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeDiscoveryUrl(searchResult.url);
    } catch (error) {
      throw new Error(`Monitoring cycle aborted: unable to verify discovery history: ${errorMessage(error)}`);
    }

    const firstCandidate = firstCandidateByUrl.get(normalizedUrl);
    if (firstCandidate) {
      candidates.push({
        searchResult,
        normalizedUrl,
        knownDiscovery: firstCandidate.knownDiscovery,
        repeatedInBatch: true,
      });
      continue;
    }

    let knownDiscovery: boolean;
    try {
      knownDiscovery = await hasDiscovery(searchResult.url);
    } catch (error) {
      throw new Error(`Monitoring cycle aborted: unable to verify discovery history: ${errorMessage(error)}`);
    }
    const candidate = { searchResult, normalizedUrl, knownDiscovery, repeatedInBatch: false };
    candidates.push(candidate);
    firstCandidateByUrl.set(normalizedUrl, candidate);
  }

  const newCandidates = candidates
    .filter((candidate) => !candidate.knownDiscovery && !candidate.repeatedInBatch);
  const selectedNewUrls = new Set<string>();
  for (const candidate of newCandidates) {
    if (selectedNewUrls.size >= MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES) break;
    if (getPreAnalysisCandidatePriority(candidate.searchResult) > 0) selectedNewUrls.add(candidate.normalizedUrl);
  }
  for (const candidate of newCandidates) {
    if (selectedNewUrls.size >= MAX_NEW_ANALYSES_PER_CYCLE) break;
    selectedNewUrls.add(candidate.normalizedUrl);
  }
  result.stoppedByAnalysisCap = newCandidates.length > MAX_NEW_ANALYSES_PER_CYCLE;

  // Phase 2: Process known URLs and selected new URLs in stable provider order.
  type ProcessedItem = { searchResult: SearchResult; processed: DiscoveryProcessingResult };
  const processedItems: ProcessedItem[] = [];
  const successfullyProcessedUrls = new Set<string>();

  for (const candidate of candidates) {
    const { searchResult } = candidate;
    if (candidate.repeatedInBatch && !successfullyProcessedUrls.has(candidate.normalizedUrl)) continue;
    if (!candidate.knownDiscovery && !candidate.repeatedInBatch && !selectedNewUrls.has(candidate.normalizedUrl)) continue;
    if (!candidate.knownDiscovery && !candidate.repeatedInBatch) result.analysesAttempted += 1;

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
    processedItems.push({ searchResult, processed });
    successfullyProcessedUrls.add(candidate.normalizedUrl);
  }

  // Phase 3: Send one digest notification for all processed items.
  if (processedItems.length > 0) {
    let notificationResults: Map<string, NotificationResult>;
    try {
      notificationResults = await notify(processedItems.map(({ processed }) => processed));
    } catch (error) {
      if (error instanceof NotificationHistoryError) {
        throw new Error(`Monitoring cycle aborted: notification history is unavailable: ${errorMessage(error)}`);
      }
      result.failures += processedItems.length;
      for (const { searchResult, processed } of processedItems) {
        result.outcomes.push({
          sourceTitle: searchResult.title,
          sourceUrl: searchResult.url,
          discoveryStatus: processed.status,
          error: errorMessage(error),
        });
      }
      return result;
    }

    for (const { searchResult, processed } of processedItems) {
      const url = processed.discovery.analysis.sourceUrl;
      const notif = notificationResults.get(url) ?? { status: "not_eligible" as const };
      recordNotification(result, notif);
      result.outcomes.push({
        sourceTitle: searchResult.title,
        sourceUrl: searchResult.url,
        discoveryStatus: processed.status,
        notificationStatus: notif.status,
      });
    }
  }

  return result;
}
