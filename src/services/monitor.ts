import { DiscoveryHistoryError, isValidXSourceProvenance, normalizeDiscoveryUrl, type DiscoveryHistory } from "./discoveryHistoryCore.js";
import { getNotificationReplayWindow } from "../config/notificationReplay.js";
import { DISCOVERY_QUERY_DESCRIPTORS, MONITORING_FRESHNESS, MONITORING_QUERIES, type DiscoveryQueryDescriptor } from "../config/discoveryQueries.js";
import { getPreAnalysisCandidatePriority, hasOfficialPreAnalysisPriority, selectPreAnalysisCandidates } from "./discoveryPriority.js";
import { NotificationHistoryError, type NotificationHistory } from "./notificationHistoryCore.js";
import { createDailyEmailContext, finalizeDailyDigest, prepareDailyDigest, notifyDeliveryDigest, type DigestDeliveryResult, type NotificationOrchestratorDependencies } from "./notificationOrchestrator.js";
import { batchAliasKey, isBatchNewsUrl, prepareBatchCandidates } from "./batchCandidates.js";
import { prepareBatchPrompt } from "./batchPrompt.js";
import { BatchAnalysisError } from "./analysisAgent.js";
import { recordBatchSelection } from "./discoveryProcessor.js";
import { type GeminiAvailability, type GeminiBlockedReason } from "./geminiUsageGuard.js";
import { createGeminiCycleContext, getGeminiProviderFailureClass, type GeminiBatchCycleContext, type GeminiCycleContext } from "../tools/llm/gemini.js";
import { xPostIdFromUrl, type XDiscoveryResult } from "./xDiscovery.js";
import { BraveUsageGuardDeniedError } from "../tools/webSearch.js";
import { sendWithResend } from "../tools/email/resend.js";
import type { BatchAnalysisResult, BatchCycleMetrics, BatchDeliveryCandidate, BatchObservation, BraveSearchPage, DailyEmailContext, DeliveryCandidate, DiscoveryProcessingResult, MonitoringCycleResult, MonitoringSearchFailure, NotificationResult, PreparedBatch, RssDiscoveryResult, SearchResult, StoredDiscovery, XSourceProvenance } from "../types/index.js";

export const MONITORING_QUERY = "new AI agent developer tool framework release";
export { MONITORING_QUERIES };
export const MAX_NEW_ANALYSES_PER_CYCLE = 4;
export const MAX_SEARCH_FAILURE_ERROR_LENGTH = 240;

export interface MonitoringSearchOptions { freshness?: "pw"; }
type WebSearch = (query: string, options?: MonitoringSearchOptions) => Promise<SearchResult[]>;
type DiscoveryLookup = (url: string) => Promise<boolean>;
type DiscoveryProcessor = (result: SearchResult, sourceProvenance?: XSourceProvenance) => Promise<DiscoveryProcessingResult>;
type NotificationProcessor = (candidates: DeliveryCandidate[]) => Promise<DigestDeliveryResult>;
type ResolvedXPost = { storyUrl: string; provenance?: XSourceProvenance };

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
  /** Shared, cycle-local provider metrics and frozen request allowance. */
  geminiCycleContext?: GeminiCycleContext;
  /** Read-only pre-discovery Gemini admission snapshot. */
  geminiPreflight?: (now: Date) => Promise<GeminiAvailability>;
  collectX?: (now: Date) => Promise<XDiscoveryResult>;
  /** Bounded durable lookup for a Brave-observed X status URL. */
  resolveXPost?: (postId: string) => Promise<ResolvedXPost | undefined>;
  markXStoryProcessed?: (storyUrl: string) => Promise<void>;
}

export interface BatchMonitoringDependencies {
  searchPage: (query: string, options?: MonitoringSearchOptions) => Promise<BraveSearchPage>;
  history: DiscoveryHistory;
  notification: NotificationOrchestratorDependencies & { history: NotificationHistory };
  geminiPreflight: (now: Date) => Promise<GeminiAvailability>;
  analyze: (batch: PreparedBatch) => Promise<BatchAnalysisResult>;
  geminiCycleContext: GeminiBatchCycleContext;
  collectRss: (now: Date) => Promise<RssDiscoveryResult>;
  now?: () => Date;
  /** Shared by the Worker so initialization failures use the same one-shot finalizer guard. */
  dailyEmailContext?: DailyEmailContext;
}

const geminiBlockedReasons = new Set<GeminiBlockedReason>([
  "usage_unknown",
  "daily_request_limit",
  "weekly_request_limit",
  "monthly_request_limit",
  "daily_token_limit",
  "weekly_token_limit",
  "monthly_token_limit",
  "usage_state_unavailable",
  "invalid_configuration",
]);
const geminiUsageFieldNames = ["dailyRequests", "weeklyRequests", "monthlyRequests", "dailyTokens", "weeklyTokens", "monthlyTokens"] as const;

function hasExactGeminiUsageFields(value: unknown, minimum: number): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === geminiUsageFieldNames.length
    && geminiUsageFieldNames.every((name) => {
      const entry = record[name];
      return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= minimum;
    });
}

function safeGeminiAvailability(value: unknown): GeminiAvailability {
  if (!value || typeof value !== "object") return { allowed: false, reason: "usage_state_unavailable" };
  const availability = value as { allowed?: unknown; reason?: unknown; counts?: unknown; limits?: unknown; timeoutIncompleteAccounting?: unknown };
  if (availability.allowed === false && geminiBlockedReasons.has(availability.reason as GeminiBlockedReason)) {
    return { allowed: false, reason: availability.reason as GeminiBlockedReason };
  }
  const validCounts = hasExactGeminiUsageFields(availability.counts, 0);
  const validLimits = hasExactGeminiUsageFields(availability.limits, 1);
  const diagnostic = availability.timeoutIncompleteAccounting;
  const validDiagnostic = diagnostic === undefined || (!!diagnostic && typeof diagnostic === "object" &&
    Object.keys(diagnostic).length === 3 && ["dailyRequests", "weeklyRequests", "monthlyRequests"].every((name) => {
      const entry = (diagnostic as Record<string, unknown>)[name];
      return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
    }));
  if (availability.allowed === true && validCounts && validLimits && validDiagnostic) return availability as GeminiAvailability;
  return { allowed: false, reason: "usage_state_unavailable" };
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
    geminiProviderAttempts: 0,
    geminiFallbacks: 0,
    analysesUsingFallbackModel: 0,
    geminiRequestsByModel: { "gemini-3.8-flash": 0, "gemini-3.6-flash": 0, "gemini-3.5-flash-lite": 0 },
    replayCandidatesConsidered: 0,
    replayCandidatesEligible: 0,
    freshStoriesSent: 0,
    replayStoriesSent: 0,
    replayLookupTruncated: false,
    xRequestsAttempted: 0,
    xPostsReceived: 0,
    xCandidatesAdmitted: 0,
    xDuplicates: 0,
    xAccountsFailed: 0,
    xTruncated: false,
    xFailures: [],
    outcomes: [],
  };
}

function recordNotification(result: MonitoringCycleResult, notification: NotificationResult): void {
  if (notification.status === "sent") result.notificationsSent += 1;
  if (notification.status === "already_sent") result.notificationsAlreadySent += 1;
  if (notification.status === "not_eligible") result.notificationsNotEligible += 1;
}

/** The scheduled policy: collect the whole bounded pool, analyze once, then deliver persisted stories. */
async function runBatchMonitoringCycleInternal(dependencies: BatchMonitoringDependencies, emailContext: DailyEmailContext): Promise<MonitoringCycleResult> {
  const now = dependencies.now ?? (() => new Date());
  const cycleStartedAt = now();
  if (Number.isNaN(cycleStartedAt.getTime())) throw new Error("Monitoring cycle timestamp is invalid.");
  const result = emptyResult(MONITORING_QUERIES.join(" | "), 0);
  result.xBlockedReason = "disabled";
  const batch: BatchCycleMetrics = {
    searchAttempts: 0, searchSuccesses: 0, searchFailures: 0, rawObservations: 0, acceptedObservations: 0,
    invalid: 0, homepages: 0, duplicates: 0, known: 0, poolCapExcluded: 0, sizeExcluded: 0, submittedCandidates: 0, promptBytes: 0,
    submittedBySource: { brave: 0, rss: 0 },
    discoverySourceHealth: { brave: "healthy", rss: "healthy", outage: false },
    truncationStage: null, status: "empty", reservationAttempts: 0, reservations: 0, providerDispatches: 0,
    returnedStories: 0, acceptedStories: 0, selected: [], freshDelivered: 0, replayDelivered: 0, emailCount: 0,
  };
  result.batch = batch;
  const { history, notification, geminiCycleContext } = dependencies;
  const replayWindow = getNotificationReplayWindow(cycleStartedAt);
  const replay = new Map<string, StoredDiscovery>();
  const inReplayWindow = (discovery: StoredDiscovery) => replayWindow !== undefined
    && discovery.firstSeenAt >= replayWindow.fromInclusive && discovery.firstSeenAt < replayWindow.beforeExclusive;
  if (replayWindow) {
    try {
      const lookup = await history.listRecentDiscoveries(replayWindow);
      // Keep the scan bound even if a dependency violates its adapter contract.
      for (const discovery of lookup.discoveries.slice(0, replayWindow.limit)) {
        if (inReplayWindow(discovery)) replay.set(discovery.normalizedUrl, discovery);
      }
      result.replayCandidatesConsidered = replay.size;
      result.replayLookupTruncated = lookup.truncated || lookup.discoveries.length > replayWindow.limit;
    } catch (error) {
      throw new Error(`Monitoring cycle aborted: replay discovery history is unavailable: ${errorMessage(error)}`);
    }
  }

  const observations: BatchObservation[] = [];
  let braveQuotaBlocked = false;
  for (const [index, descriptor] of DISCOVERY_QUERY_DESCRIPTORS.entries()) {
    batch.searchAttempts += 1;
    try {
      const page = await dependencies.searchPage(descriptor.query, { freshness: MONITORING_FRESHNESS });
      batch.searchSuccesses += 1;
      batch.rawObservations += page.rawCount;
      observations.push(...page.positions.slice(0, 5).map(position => ({
        result: position.result,
        provenance: { kind: "brave" as const, queryOrdinal: index + 1, resultOrdinal: position.resultOrdinal },
      })));
    } catch (error) {
      if (error instanceof BraveUsageGuardDeniedError) {
        braveQuotaBlocked = true;
        break;
      }
      batch.searchFailures += 1;
      result.searchFailures.push({ queryOrdinal: index + 1, error: searchFailureMessage(error) });
      result.failures += 1;
    }
  }
  const braveResultsReceived = batch.rawObservations;
  let rss: RssDiscoveryResult;
  try {
    rss = await dependencies.collectRss(cycleStartedAt);
  } catch {
    rss = {
      observations: [],
      metrics: { status: "configuration", configuredFeeds: 0, attemptedFeeds: 0, succeededFeeds: 0, failedFeeds: 0,
        observedPositions: 0, validCandidates: 0, rejectedItems: 0, itemLimitTruncations: 0, outcomes: [] },
    };
  }
  result.rss = rss.metrics;
  observations.push(...rss.observations);
  batch.rawObservations += rss.metrics.observedPositions;
  result.failures += rss.metrics.failedFeeds;
  if (rss.metrics.status === "configuration") result.failures += 1;
  const braveHealth = braveQuotaBlocked
    ? "quota_blocked" as const
    : batch.searchFailures === 0
      ? "healthy" as const
      : batch.searchSuccesses === 0
        ? "unavailable" as const
        : "degraded" as const;
  const rssHealth = rss.metrics.status !== "collected" || rss.metrics.succeededFeeds === 0
    ? "unavailable" as const
    : rss.metrics.failedFeeds > 0
      ? "degraded" as const
      : "healthy" as const;
  batch.discoverySourceHealth = {
    brave: braveHealth,
    rss: rssHealth,
    outage: braveHealth === "unavailable" && rssHealth === "unavailable",
  };
  result.searchResultsReceived = braveResultsReceived;
  // Any required history read/touch failure rejects before analysis or delivery.
  const pool = await prepareBatchCandidates(observations, { history, notificationHistory: notification.history, seenAt: cycleStartedAt });
  Object.assign(batch, pool.counts);
  result.duplicates = pool.counts.duplicates + pool.counts.known;
  const fresh: BatchDeliveryCandidate[] = [];
  let selectionPersistenceFailed = false;
  let prepared: PreparedBatch | undefined;
  if (pool.candidates.length > 0) {
    try {
      prepared = prepareBatchPrompt(pool.candidates);
      batch.sizeExcluded = prepared.sizeExcluded;
      batch.submittedCandidates = prepared.candidates.length;
      batch.submittedBySource = {
        brave: prepared.candidates.filter(candidate => candidate.provenance.some(entry => entry.kind === "brave")).length,
        rss: prepared.candidates.filter(candidate => candidate.provenance.some(entry => entry.kind === "rss")).length,
      };
      batch.promptBytes = prepared.promptBytes;
      batch.truncationStage = prepared.truncationStage;
    } catch (error) {
      batch.status = "preparation_failed";
      result.failures += 1;
      result.outcomes.push({ sourceTitle: "", sourceUrl: "", error: errorMessage(error) });
    }
  }

  if (prepared) {
    let availability: GeminiAvailability;
    try { availability = safeGeminiAvailability(await dependencies.geminiPreflight(now())); }
    catch { availability = { allowed: false, reason: "usage_state_unavailable" }; }
    if (!availability.allowed) {
      batch.status = "blocked";
      result.geminiBlockedReason = availability.reason;
    } else {
      if (availability.timeoutIncompleteAccounting) result.geminiTimeoutIncompleteAccounting = { ...availability.timeoutIncompleteAccounting };
      result.analysesAttempted = 1;
      let analyzed: BatchAnalysisResult | undefined;
      try {
        analyzed = await dependencies.analyze(prepared);
        batch.status = "validated";
        batch.returnedStories = analyzed.returnedCount;
        batch.acceptedStories = analyzed.selections.length;
        batch.selected = analyzed.selections.map(({ candidate, analysis }) => ({
          candidateId: candidate.candidateId, hostname: new URL(candidate.source.url).hostname,
          score: analysis.relevanceScore, provenance: candidate.provenance.map(pair => ({ ...pair })),
        }));
      } catch (error) {
        batch.status = geminiCycleContext.dispatchBlockedByTimeout ? "timeout" : error instanceof BatchAnalysisError ? "invalid_output" : "provider_failed";
        const providerFailureClass = getGeminiProviderFailureClass(error);
        if (batch.status === "provider_failed" && providerFailureClass !== undefined) {
          batch.providerFailureClass = providerFailureClass;
        }
        result.failures += 1;
        const message = batch.status === "timeout"
          ? "Gemini batch timeout"
          : batch.status === "invalid_output"
            ? "Gemini batch invalid output"
            : "Gemini batch provider failure";
        result.outcomes.push({ sourceTitle: "", sourceUrl: "", error: message });
      }
      if (analyzed) {
        for (const selection of analyzed.selections) {
          try {
            const processed = await recordBatchSelection(selection, { history, seenAt: cycleStartedAt });
            result.resultsProcessed += 1;
            result.outcomes.push({ sourceTitle: selection.candidate.source.title, sourceUrl: selection.candidate.source.url, discoveryStatus: processed.status });
            if (processed.status === "new") {
              result.newDiscoveries += 1;
              fresh.push({ discovery: processed.discovery, origin: "fresh", aliases: selection.candidate.aliases });
            } else {
              result.duplicates += 1;
              if (inReplayWindow(processed.discovery) && replayWindow && (replay.has(processed.discovery.normalizedUrl) || replay.size < replayWindow.limit)) {
                replay.set(processed.discovery.normalizedUrl, processed.discovery);
              }
            }
          } catch (error) {
            selectionPersistenceFailed = true;
            result.failures += 1;
            result.outcomes.push({ sourceTitle: selection.candidate.source.title, sourceUrl: selection.candidate.source.url, error: errorMessage(error) });
          }
        }
      }
    }
  }

  batch.reservationAttempts = geminiCycleContext.reservationAttempts;
  batch.reservations = geminiCycleContext.reservations;
  batch.providerDispatches = geminiCycleContext.providerDispatches;
  batch.attempts = geminiCycleContext.attempts.map(attempt => ({ ...attempt }));
  batch.retryEligible = geminiCycleContext.retryEligible;
  batch.retryAttempted = geminiCycleContext.retryAttempted;
  batch.retrySkipReason = geminiCycleContext.retrySkipReason;
  result.geminiProviderAttempts = geminiCycleContext.providerDispatches;
  result.geminiRequestsByModel["gemini-3.8-flash"] = geminiCycleContext.providerDispatches;
  const replayCandidates: BatchDeliveryCandidate[] = [...replay.values()]
    .filter(discovery => isBatchNewsUrl(discovery.normalizedUrl))
    .map(discovery => ({ discovery, origin: "replay" as const, aliases: [] as readonly string[] }));
  const candidates: BatchDeliveryCandidate[] = [
    ...fresh,
    ...replayCandidates,
  ].map(candidate => ({
    ...candidate,
    aliases: [...new Set([...candidate.aliases, ...(pool.observedAliases.get(batchAliasKey(candidate.discovery.normalizedUrl)) ?? [])])],
  }));
  const deliveryReason = fresh.length > 0 ? "selected" as const
    : batch.status === "validated" ? "ai_no_selections" as const
      : batch.status === "provider_failed" || batch.status === "timeout" || batch.status === "invalid_output" || batch.status === "blocked" ? "ai_unavailable" as const
        : batch.status === "preparation_failed" ? "preparation_unavailable" as const : "no_eligible_stories" as const;
  const preparedDigest = await prepareDailyDigest({ cycleDate: cycleStartedAt.toISOString(),
    fresh: candidates.filter(candidate => candidate.origin === "fresh"),
    replay: candidates.filter(candidate => candidate.origin === "replay"),
    rawCandidates: pool.candidates, observedAliases: pool.observedAliases,
    allowRawFallback: !selectionPersistenceFailed, reason: selectionPersistenceFailed ? "persistence_unavailable" : deliveryReason }, notification.history);
  const digest = batch.discoverySourceHealth.outage && preparedDigest.mode === "status_only"
      && preparedDigest.reason === "no_eligible_stories"
    ? { ...preparedDigest, reason: "discovery_unavailable" as const }
    : preparedDigest;
  result.replayCandidatesEligible = digest.items.filter(item => item.kind === "analyzed" && item.candidate.origin === "replay").length;
  const acceptedItems = digest.items;
  const email = await finalizeDailyDigest(digest, {
    context: emailContext, history: notification.history, sendEmail: notification.sendEmail ?? sendWithResend,
    onAccepted: () => {
      result.notificationsSent = batch.emailCount = 1;
      result.freshStoriesSent = batch.freshDelivered = acceptedItems.filter(item => item.kind === "analyzed" && item.candidate.origin === "fresh").length;
      result.replayStoriesSent = batch.replayDelivered = acceptedItems.filter(item => item.kind === "analyzed" && item.candidate.origin === "replay").length;
    },
  });
  result.delivery = {
    deliveryMode: digest.mode,
    deliveryReason: digest.reason,
    analyzedStories: digest.items.filter(item => item.kind === "analyzed").length,
    rawStories: digest.items.filter(item => item.kind === "raw").length,
    replayStories: digest.items.filter(item => item.kind === "analyzed" && item.candidate.origin === "replay").length,
    ...email,
  };
  if (email.emailOutcome === "failed" || email.historyOutcome === "persistence_failed") result.failures += 1;
  return result;
}

export async function finalizeStatusOnlyMonitoringCycle(
  context: DailyEmailContext,
  sendEmail: NonNullable<NotificationOrchestratorDependencies["sendEmail"]>,
  cycleDate: string,
  reason: "history_unavailable" | "discovery_unavailable" | "preparation_unavailable" = "discovery_unavailable",
): Promise<MonitoringCycleResult> {
  const result = emptyResult(MONITORING_QUERIES.join(" | "), 0);
  result.failures = 1;
  const digest = { mode: "status_only" as const, reason, cycleDate, items: [] };
  const outcome = await finalizeDailyDigest(digest, { context, sendEmail });
  if (outcome.emailOutcome === "accepted") result.notificationsSent = 1;
  result.delivery = {
    deliveryMode: digest.mode, deliveryReason: digest.reason,
    analyzedStories: 0, rawStories: 0, replayStories: 0, ...outcome,
  };
  return result;
}

/** The scheduled Batch cycle always converges on one guarded final email attempt. */
export async function runBatchMonitoringCycle(dependencies: BatchMonitoringDependencies): Promise<MonitoringCycleResult> {
  const context = dependencies.dailyEmailContext ?? createDailyEmailContext();
  try {
    return await runBatchMonitoringCycleInternal(dependencies, context);
  } catch {
    const cycleDate = (dependencies.now ?? (() => new Date()))().toISOString();
    return finalizeStatusOnlyMonitoringCycle(context, dependencies.notification.sendEmail ?? sendWithResend, cycleDate, "history_unavailable");
  }
}

/** Runs one sequential discovery, analysis, and digest-notification cycle. */
export async function runMonitoringCycle(
  query: string | undefined = undefined,
  dependencies: MonitoringCycleDependencies = {},
): Promise<MonitoringCycleResult> {
  const cycleStartedAt = (dependencies.now ?? (() => new Date()))();
  if (Number.isNaN(cycleStartedAt.getTime())) throw new Error("Monitoring cycle timestamp is invalid.");
  const geminiCycleContext = dependencies.geminiCycleContext ?? createGeminiCycleContext();
  const queryDescriptors: readonly DiscoveryQueryDescriptor[] = query === undefined
    ? DISCOVERY_QUERY_DESCRIPTORS
    : [{ id: "custom", query, kind: "broad" }];
  const searchResults: Array<{ result: SearchResult; descriptor: DiscoveryQueryDescriptor; officialPriority?: boolean; sourceProvenance?: XSourceProvenance; xStoryUrl?: string }> = [];
  const searchFailures: MonitoringSearchFailure[] = [];
  const result = emptyResult(query ?? MONITORING_QUERIES.join(" | "), 0, searchFailures);
  const discoveryHistory = dependencies.history;
  if (!discoveryHistory) throw new Error("Monitoring cycle discovery history is required.");
  const hasDiscovery = dependencies.hasDiscovery ?? (async (url: string) => (await discoveryHistory.getDiscovery(url)) !== undefined);
  const geminiPreflight = dependencies.geminiPreflight
    ?? (async () => ({ allowed: false, reason: "usage_state_unavailable" }));
  const search = dependencies.search ?? (async () => { throw new Error("Monitoring cycle search dependency is required."); });
  const process = dependencies.process ?? (async () => { throw new Error("Monitoring cycle processing dependency is required."); });
  const collectX = dependencies.collectX ?? (async () => ({
    candidates: [], postStoryUrls: new Map(), requestsAttempted: 0, postsReceived: 0,
    candidatesAdmitted: 0, duplicates: 0, accountsFailed: 0, truncated: false,
    failures: [], blockedReason: "disabled" as const,
  }));
  const resolveXPost = dependencies.resolveXPost ?? (async () => undefined);
  const markXStoryProcessed = dependencies.markXStoryProcessed ?? (async () => undefined);
  const notification = dependencies.notification;
  const notify = dependencies.notify ?? ((candidates: DeliveryCandidate[]) => notifyDeliveryDigest(candidates, notification));
  const syncGeminiMetrics = () => {
    result.geminiProviderAttempts = geminiCycleContext.providerAttempts;
    result.geminiFallbacks = geminiCycleContext.fallbacks;
    result.analysesUsingFallbackModel = geminiCycleContext.analysesUsingFallbackModel;
    result.geminiRequestsByModel = { ...geminiCycleContext.requestsByModel };
  };

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

  let geminiAvailability: GeminiAvailability;
  try {
    geminiAvailability = safeGeminiAvailability(await geminiPreflight((dependencies.now ?? (() => new Date()))()));
  } catch {
    geminiAvailability = { allowed: false, reason: "usage_state_unavailable" };
  }
  if (!geminiAvailability.allowed) result.geminiBlockedReason = geminiAvailability.reason;
  else if (geminiAvailability.timeoutIncompleteAccounting) {
    result.geminiTimeoutIncompleteAccounting = { ...geminiAvailability.timeoutIncompleteAccounting };
  }

  if (geminiAvailability.allowed) {
    for (const [queryIndex, descriptor] of queryDescriptors.entries()) {
      try {
        const results = await search(descriptor.query, { freshness: MONITORING_FRESHNESS });
        searchResults.push(...results.map((result) => ({ result, descriptor })));
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

    if (query === undefined) {
      let xDiscovery: XDiscoveryResult;
      try {
        xDiscovery = await collectX(cycleStartedAt);
      } catch {
        xDiscovery = { candidates: [], postStoryUrls: new Map(), requestsAttempted: 0, postsReceived: 0, candidatesAdmitted: 0, duplicates: 0, accountsFailed: 0, truncated: false, failures: [], blockedReason: "state_unavailable" };
      }
      result.xRequestsAttempted = xDiscovery.requestsAttempted;
      result.xPostsReceived = xDiscovery.postsReceived;
      result.xCandidatesAdmitted = xDiscovery.candidatesAdmitted;
      result.xDuplicates = xDiscovery.duplicates;
      result.xAccountsFailed = xDiscovery.accountsFailed;
      result.xTruncated = xDiscovery.truncated;
      result.xFailures = xDiscovery.failures.slice(0, 5);
      if (xDiscovery.blockedReason) result.xBlockedReason = xDiscovery.blockedReason;

      for (let index = searchResults.length - 1; index >= 0; index -= 1) {
        const observed = searchResults[index];
        const postId = xPostIdFromUrl(observed.result.url);
        if (!postId) continue;
        let resolved: ResolvedXPost | undefined;
        try { resolved = await resolveXPost(postId); }
        catch {
          if (!result.xBlockedReason) result.xBlockedReason = "state_unavailable";
        }
        if (!resolved) { searchResults.splice(index, 1); continue; }
        try { normalizeDiscoveryUrl(resolved.storyUrl); }
        catch { searchResults.splice(index, 1); continue; }
        observed.officialPriority = hasOfficialPreAnalysisPriority(observed.result, observed.descriptor, cycleStartedAt);
        observed.result = { ...observed.result, url: resolved.storyUrl };
        observed.xStoryUrl = resolved.storyUrl;
        if (resolved.provenance !== undefined && isValidXSourceProvenance(resolved.provenance)) {
          observed.sourceProvenance = { ...resolved.provenance };
        }
      }
      searchResults.push(...xDiscovery.candidates.map((candidate) => ({
        result: candidate.result,
        descriptor: { id: "x_selected_account", query: "", kind: "broad" as const },
        officialPriority: false,
        sourceProvenance: candidate.provenance,
        xStoryUrl: candidate.storyUrl,
      })));
    }
  }
  result.searchResultsReceived = searchResults.length;
  result.failures = searchFailures.length;

  type ProcessedItem = { searchResult: SearchResult; processed: DiscoveryProcessingResult };
  const processedItems: ProcessedItem[] = [];

  if (geminiAvailability.allowed) {
  // Phase 1: Identify unique unseen candidates before assigning scarce analysis slots.
  type Candidate = {
    searchResult: SearchResult;
    normalizedUrl: string;
    knownDiscovery: boolean;
    repeatedInBatch: boolean;
    officialPriority: boolean;
    sourceProvenance?: XSourceProvenance;
    xStoryUrl?: string;
  };
  const candidates: Candidate[] = [];
  const firstCandidateByUrl = new Map<string, Candidate>();
  for (const observation of searchResults) {
    const { result: searchResult, descriptor, xStoryUrl } = observation;
    const sourceProvenance = observation.sourceProvenance !== undefined
      && isValidXSourceProvenance(observation.sourceProvenance)
      ? observation.sourceProvenance
      : undefined;
    const officialPriority = observation.officialPriority
      ?? hasOfficialPreAnalysisPriority(searchResult, descriptor, cycleStartedAt);
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeDiscoveryUrl(searchResult.url);
    } catch (error) {
      throw new Error(`Monitoring cycle aborted: unable to verify discovery history: ${errorMessage(error)}`);
    }

    const firstCandidate = firstCandidateByUrl.get(normalizedUrl);
    if (firstCandidate) {
      if (sourceProvenance) result.xDuplicates += 1;
      firstCandidate.officialPriority ||= officialPriority;
      if (sourceProvenance && !firstCandidate.sourceProvenance) {
        firstCandidate.sourceProvenance = { ...sourceProvenance };
      }
      if (xStoryUrl && !firstCandidate.xStoryUrl) firstCandidate.xStoryUrl = xStoryUrl;
      candidates.push({
        searchResult,
        normalizedUrl,
        knownDiscovery: firstCandidate.knownDiscovery,
        repeatedInBatch: true,
        officialPriority: false,
        sourceProvenance,
        xStoryUrl,
      });
      continue;
    }

    let knownDiscovery: boolean;
    try {
      knownDiscovery = await hasDiscovery(searchResult.url);
    } catch (error) {
      throw new Error(`Monitoring cycle aborted: unable to verify discovery history: ${errorMessage(error)}`);
    }
    const candidate = {
      searchResult,
      normalizedUrl,
      knownDiscovery,
      repeatedInBatch: false,
      officialPriority,
      sourceProvenance,
      xStoryUrl,
    };
    candidates.push(candidate);
    if (sourceProvenance && knownDiscovery) result.xDuplicates += 1;
    firstCandidateByUrl.set(normalizedUrl, candidate);
  }

  const newCandidates = candidates
    .filter((candidate) => !candidate.knownDiscovery && !candidate.repeatedInBatch);
  const selectedNewUrls = new Set(selectPreAnalysisCandidates(
    newCandidates.map((candidate) => ({
      value: candidate.normalizedUrl,
      normalizedUrl: candidate.normalizedUrl,
      preferred: getPreAnalysisCandidatePriority(candidate.searchResult) > 0,
      officialPriority: candidate.officialPriority,
    })),
    MAX_NEW_ANALYSES_PER_CYCLE,
  ));
  result.stoppedByAnalysisCap = newCandidates.length > MAX_NEW_ANALYSES_PER_CYCLE;

  // Phase 2: Process known URLs and selected new URLs in stable provider order.
  const successfullyProcessedUrls = new Set<string>();
  const markedXStoryUrls = new Set<string>();

  for (const candidate of candidates) {
    const { searchResult } = candidate;
    if (candidate.repeatedInBatch && !successfullyProcessedUrls.has(candidate.normalizedUrl)) continue;
    if (!candidate.knownDiscovery && !candidate.repeatedInBatch && !selectedNewUrls.has(candidate.normalizedUrl)) continue;
    if (!candidate.knownDiscovery && !candidate.repeatedInBatch) result.analysesAttempted += 1;

    let processed: DiscoveryProcessingResult;
    try {
      processed = await process(searchResult, candidate.sourceProvenance);
    } catch (error) {
      if (error instanceof DiscoveryHistoryError) {
        throw new Error(`Monitoring cycle aborted: discovery history is unavailable: ${errorMessage(error)}`);
      }
      result.failures += 1;
      syncGeminiMetrics();
      result.outcomes.push({ sourceTitle: searchResult.title, sourceUrl: searchResult.url, error: errorMessage(error) });
      if (geminiCycleContext.dispatchBlockedByTimeout) break;
      continue;
    }

    result.resultsProcessed += 1;
    if (processed.status === "new") result.newDiscoveries += 1;
    if (processed.status === "duplicate") result.duplicates += 1;
    processedItems.push({ searchResult, processed });
    successfullyProcessedUrls.add(candidate.normalizedUrl);
    if (candidate.xStoryUrl && !markedXStoryUrls.has(candidate.xStoryUrl)) {
      markedXStoryUrls.add(candidate.xStoryUrl);
      try { await markXStoryProcessed(candidate.xStoryUrl); }
      catch { result.xBlockedReason = "state_unavailable"; }
    }
  }
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
      syncGeminiMetrics();
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

  syncGeminiMetrics();
  return result;
}
