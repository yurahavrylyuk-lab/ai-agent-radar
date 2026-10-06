import { JsonDiscoveryHistory, DiscoveryHistoryError, type DiscoveryHistory } from "./discoveryHistory.js";
import { normalizeDiscoveryUrl } from "./discoveryHistoryCore.js";
import { getNotificationReplayWindow } from "../config/notificationReplay.js";
import { getPreAnalysisCandidatePriority, MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES } from "./discoveryPriority.js";
import { processSearchResult } from "./discoveryProcessor.js";
import { NotificationHistoryError } from "./notificationHistory.js";
import { notifyDeliveryDigest, type DigestDeliveryResult, type NotificationOrchestratorDependencies } from "./notificationOrchestrator.js";
import { LocalJsonBraveUsageStore } from "./localJsonBraveUsageStore.js";
import { LocalJsonGeminiUsageStore } from "./localJsonGeminiUsageStore.js";
import { JsonNotificationHistory } from "./notificationHistory.js";
import { generateWithGemini } from "../tools/llm/gemini.js";
import { analyzeSearchResult } from "./analysisAgent.js";
import { BraveUsageGuardDeniedError, searchWeb } from "../tools/webSearch.js";
import type { DeliveryCandidate, DiscoveryProcessingResult, MonitoringCycleResult, MonitoringSearchFailure, NotificationResult, SearchResult } from "../types/index.js";

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
export const MAX_SEARCH_FAILURE_ERROR_LENGTH = 240;

type WebSearch = (query: string) => Promise<SearchResult[]>;
type DiscoveryLookup = (url: string) => Promise<boolean>;
type DiscoveryProcessor = (result: SearchResult) => Promise<DiscoveryProcessingResult>;
type NotificationProcessor = (candidates: DeliveryCandidate[]) => Promise<DigestDeliveryResult>;

export interface MonitoringCycleDependencies {
  search?: WebSearch;
  /** Optional persistence adapter shared by duplicate checks and discovery processing. */
  history?: DiscoveryHistory;
  hasDiscovery?: DiscoveryLookup;
  process?: DiscoveryProcessor;
  /** Optional dependencies for the provider-independent notification orchestration. */
  notification?: NotificationOrchestratorDependencies;
  notify?: NotificationProcessor;
  now?: () => Date;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown error").slice(0, 500);
}

function searchFailureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown search error")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, "[redacted-url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[-_ ]?key|token|secret|authorization|credential|password)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, MAX_SEARCH_FAILURE_ERROR_LENGTH);
}

function emptyResult(
  query: string,
  searchResultsReceived: number,
  searchFailures: MonitoringSearchFailure[] = [],
): MonitoringCycleResult {
  return {
    query,
    searchResultsReceived,
    searchFailures,
    resultsProcessed: 0,
    newDiscoveries: 0,
    duplicates: 0,
    analysesAttempted: 0,
    notificationsSent: 0,
    notificationsAlreadySent: 0,
    notificationsNotEligible: 0,
    failures: searchFailures.length,
    stoppedByAnalysisCap: false,
    replayCandidatesConsidered: 0,
    replayCandidatesEligible: 0,
    freshStoriesSent: 0,
    replayStoriesSent: 0,
    replayLookupTruncated: false,
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
  const cycleStartedAt = (dependencies.now ?? (() => new Date()))();
  if (Number.isNaN(cycleStartedAt.getTime())) throw new Error("Monitoring cycle timestamp is invalid.");
  const search = dependencies.search ?? ((searchQuery: string) => searchWeb(searchQuery, { usageTracker: new LocalJsonBraveUsageStore() }));
  const queries = query === undefined ? MONITORING_QUERIES : [query];
  const searchResults: SearchResult[] = [];
  const searchFailures: MonitoringSearchFailure[] = [];
  for (const [queryIndex, searchQuery] of queries.entries()) {
    try {
      searchResults.push(...await search(searchQuery));
    } catch (error) {
      if (query === undefined && error instanceof BraveUsageGuardDeniedError) break;
      if (query === undefined) {
        searchFailures.push({ queryOrdinal: queryIndex + 1, error: searchFailureMessage(error) });
        continue;
      }
      throw new Error(`Monitoring cycle search failed: ${errorMessage(error)}`);
    }
  }

  if (query === undefined && searchResults.length === 0 && searchFailures.length > 0) {
    const firstFailure = searchFailures[0];
    throw new Error(
      `Monitoring cycle search failed: no usable results after ${searchFailures.length} non-quota failure(s). `
      + `First failure at query ${firstFailure.queryOrdinal}: ${firstFailure.error}`,
    );
  }

  const result = emptyResult(query ?? MONITORING_QUERIES.join(" | "), searchResults.length, searchFailures);
  const discoveryHistory = dependencies.history ?? new JsonDiscoveryHistory();
  const hasDiscovery = dependencies.hasDiscovery ?? (async (url: string) => (await discoveryHistory.getDiscovery(url)) !== undefined);
  const process = dependencies.process ?? ((searchResult: SearchResult) => processSearchResult(searchResult, {
    history: discoveryHistory,
    analyze: (r) => analyzeSearchResult(r, { generate: (input) => generateWithGemini(input, { usageTracker: new LocalJsonGeminiUsageStore() }) }),
  }));
  const notification = dependencies.notification ?? { history: new JsonNotificationHistory() };
  const notify = dependencies.notify ?? ((candidates: DeliveryCandidate[]) => notifyDeliveryDigest(candidates, notification));

  let replayDiscoveries = [] as Awaited<ReturnType<DiscoveryHistory["listRecentDiscoveries"]>>["discoveries"];
  const replayWindow = getNotificationReplayWindow(cycleStartedAt);
  if (replayWindow) {
    try {
      const replayLookup = await discoveryHistory.listRecentDiscoveries(replayWindow);
      replayDiscoveries = replayLookup.discoveries;
      result.replayCandidatesConsidered = replayDiscoveries.length;
      result.replayLookupTruncated = replayLookup.truncated;
    } catch (error) {
      throw new Error(`Monitoring cycle aborted: replay discovery history is unavailable: ${errorMessage(error)}`);
    }
  }

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
  const preferredCandidates = newCandidates
    .filter((candidate) => getPreAnalysisCandidatePriority(candidate.searchResult) > 0);
  const nonPreferredCandidates = newCandidates
    .filter((candidate) => getPreAnalysisCandidatePriority(candidate.searchResult) === 0);
  const selectedNewUrls = new Set<string>();
  for (const candidate of preferredCandidates.slice(0, MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES)) {
    selectedNewUrls.add(candidate.normalizedUrl);
  }
  for (const candidate of nonPreferredCandidates) {
    if (selectedNewUrls.size >= MAX_NEW_ANALYSES_PER_CYCLE) break;
    selectedNewUrls.add(candidate.normalizedUrl);
  }
  for (const candidate of preferredCandidates.slice(MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES)) {
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

  // Phase 3: Merge fresh analyses with bounded durable replay candidates and send at most one digest.
  const deliveryCandidates: DeliveryCandidate[] = [
    ...processedItems
      .filter(({ processed }) => processed.status === "new")
      .map(({ processed }) => ({ discovery: processed.discovery, origin: "fresh" as const })),
    ...replayDiscoveries.map((discovery) => ({ discovery, origin: "replay" as const })),
  ];
  if (deliveryCandidates.length > 0) {
    let delivery: DigestDeliveryResult;
    try {
      delivery = await notify(deliveryCandidates);
    } catch (error) {
      if (error instanceof NotificationHistoryError) {
        throw new Error(`Monitoring cycle aborted: notification history is unavailable: ${errorMessage(error)}`);
      }
      result.failures += new Set(deliveryCandidates.map((candidate) => candidate.discovery.normalizedUrl)).size;
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

    result.replayCandidatesEligible = delivery.eligibleCandidates
      .filter((candidate) => candidate.origin === "replay").length;
    result.freshStoriesSent = delivery.sentCandidates
      .filter((candidate) => candidate.origin === "fresh").length;
    result.replayStoriesSent = delivery.sentCandidates
      .filter((candidate) => candidate.origin === "replay").length;

    const processedUrls = new Set(processedItems.map(({ processed }) => processed.discovery.normalizedUrl));
    for (const { searchResult, processed } of processedItems) {
      const url = processed.discovery.analysis.sourceUrl;
      const notif = delivery.notifications.get(url) ?? { status: "not_eligible" as const };
      recordNotification(result, notif);
      result.outcomes.push({
        sourceTitle: searchResult.title,
        sourceUrl: searchResult.url,
        discoveryStatus: processed.status,
        notificationStatus: notif.status,
      });
    }
    for (const candidate of deliveryCandidates) {
      if (candidate.origin !== "replay" || processedUrls.has(candidate.discovery.normalizedUrl)) continue;
      const notif = delivery.notifications.get(candidate.discovery.analysis.sourceUrl);
      if (notif) recordNotification(result, notif);
    }
  } else {
    for (const { searchResult, processed } of processedItems) {
      const notif = { status: "not_eligible" as const };
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
