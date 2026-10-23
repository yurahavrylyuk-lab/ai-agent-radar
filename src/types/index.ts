import type { GeminiBlockedReason, GeminiTimeoutAccountingDiagnostic } from "../services/geminiUsageGuard.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
}

export interface BraveSearchPage {
  rawCount: number;
  positions: Array<{ resultOrdinal: number; result: SearchResult | null }>;
}

export type DiscoveryProvenance =
  | { kind: "brave"; queryOrdinal: number; resultOrdinal: number }
  | { kind: "rss"; feedId: string; itemOrdinal: number };

export interface BatchObservation {
  result: SearchResult | null;
  provenance: DiscoveryProvenance;
}

export interface BatchCandidate {
  candidateId: string;
  source: SearchResult;
  normalizedUrl: string;
  aliasKey: string;
  aliases: string[];
  provenance: DiscoveryProvenance[];
}

export type BatchTruncationStage = "initial" | "snippet384" | "snippet192" | "snippet128" | "snippet96" | "snippet0" | "title128" | "tail";

export interface PreparedBatch {
  prompt: string;
  /** Only submitted candidates, retaining their original source records and IDs. */
  candidates: readonly BatchCandidate[];
  promptBytes: number;
  sizeExcluded: number;
  truncationStage: BatchTruncationStage;
  snippetBytesLimit: 192 | 128 | 96 | 0;
}

export interface CandidatePool {
  candidates: BatchCandidate[];
  observedAliases: ReadonlyMap<string, readonly string[]>;
  counts: { acceptedObservations: number; invalid: number; homepages: number; duplicates: number; known: number; poolCapExcluded: number };
}

export type RssFailureReason = "disabled" | "configuration" | "http" | "redirect" | "timeout" | "body_limit" | "encoding" | "parse" | "structure" | "ok";

export interface RssCycleMetrics {
  status: "disabled" | "configuration" | "collected";
  configuredFeeds: number; attemptedFeeds: number; succeededFeeds: number; failedFeeds: number;
  observedPositions: number; validCandidates: number; rejectedItems: number; itemLimitTruncations: number;
  outcomes: Array<{ feedId: string; reason: RssFailureReason; httpStatus?: number; elapsedMs: number }>;
}

export interface RssDiscoveryResult {
  observations: BatchObservation[];
  metrics: RssCycleMetrics;
}

export const agentAnalysisCategories = [
  "new_agent",
  "new_product",
  "developer_tool",
  "framework",
  "major_update",
  "open_source",
  "industry_news",
  "other",
] as const;

export type AgentAnalysisCategory = (typeof agentAnalysisCategories)[number];

/** Provider-neutral interpretation of one discovery for learning or project-building. */
export interface AgentAnalysis {
  name: string;
  category: AgentAnalysisCategory;
  summary: string;
  /** Integer from 1–10: 1–3 low, 4–6 interesting, 7–8 useful, 9–10 highly relevant. */
  relevanceScore: number;
  whyItMatters: string;
  educationalValue: string;
  projectOpportunities: string[];
  technologies: string[];
  sourceTitle: string;
  sourceUrl: string;
}

export interface BatchSelection {
  candidate: BatchCandidate;
  analysis: AgentAnalysis;
}

export interface BatchAnalysisResult {
  returnedCount: number;
  selections: BatchSelection[];
}

/** Application-owned X attribution. This is never accepted from model output. */
export interface XSourceProvenance {
  kind: "x";
  postId: string;
  authorId: string;
  postUrl: string;
  label: string;
}

/** Bounded durable evidence that this discovery was selected by Batch Gemini. */
export interface BatchSelectionProvenance {
  kind: "batch";
}

/** A validated analysis retained under its normalized source URL identity. */
export interface StoredDiscovery {
  normalizedUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  analysis: AgentAnalysis;
  sourceProvenance?: XSourceProvenance;
  batchSelectionProvenance?: BatchSelectionProvenance;
}

export type DiscoveryProcessingResult =
  | { status: "new"; discovery: StoredDiscovery }
  | { status: "duplicate"; discovery: StoredDiscovery };

export type DeliveryCandidateOrigin = "fresh" | "replay";

/** A completed stored analysis admitted to the single digest-delivery path. */
export interface DeliveryCandidate {
  discovery: StoredDiscovery;
  origin: DeliveryCandidateOrigin;
}

/** Observed cycle-local aliases retain their existing durable notification keys. */
export interface BatchDeliveryCandidate extends DeliveryCandidate {
  aliases: readonly string[];
}

export type DailyDigestMode = "normal" | "degraded" | "status_only";
export type DailyDigestReason = "selected" | "no_eligible_stories" | "ai_unavailable" | "ai_no_selections"
  | "discovery_unavailable" | "history_unavailable" | "preparation_unavailable" | "persistence_unavailable";
export type DailyDigestItem =
  | { kind: "analyzed"; candidate: BatchDeliveryCandidate }
  | { kind: "raw"; candidate: BatchCandidate };
export interface DailyDigestInput {
  cycleDate: string;
  fresh: readonly BatchDeliveryCandidate[];
  replay: readonly BatchDeliveryCandidate[];
  rawCandidates: readonly BatchCandidate[];
  observedAliases: ReadonlyMap<string, readonly string[]>;
  allowRawFallback: boolean;
  reason: DailyDigestReason;
}
export interface PreparedDailyDigest {
  mode: DailyDigestMode;
  reason: DailyDigestReason;
  cycleDate: string;
  items: DailyDigestItem[];
}
export interface DailyEmailContext { emailAttempted: boolean }
export type DailyEmailOutcomeValue = "accepted" | "failed" | "unknown" | "not_attempted";
export type DailyHistoryOutcome = "not_required" | "recorded" | "unavailable" | "persistence_failed";
export interface DailyEmailOutcome {
  emailAttempts: 0 | 1;
  emailOutcome: DailyEmailOutcomeValue;
  historyOutcome: DailyHistoryOutcome;
  finalizationReached: boolean;
}

export interface DailyDeliveryTelemetry extends DailyEmailOutcome {
  deliveryMode: DailyDigestMode;
  deliveryReason: DailyDigestReason;
  analyzedStories: number;
  rawStories: number;
  replayStories: number;
}

/** Provider-neutral content ready for a future email transport. */
export interface DiscoveryEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Provider-neutral acknowledgement from a future email transport. */
export interface EmailSendResult {
  id: string;
}

export const notificationChannels = ["email"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

/** A successful delivery record, independent from a notification provider. */
export interface NotificationRecord {
  normalizedUrl: string;
  channel: NotificationChannel;
  sentAt: string;
  providerMessageId?: string;
}

export type NotificationResult =
  | { status: "not_eligible" }
  | { status: "already_sent"; record: NotificationRecord }
  | { status: "sent"; record: NotificationRecord };

export interface MonitoringCycleOutcome {
  sourceTitle: string;
  sourceUrl: string;
  discoveryStatus?: DiscoveryProcessingResult["status"];
  notificationStatus?: NotificationResult["status"];
  error?: string;
}

/** One failed default-query search attempt, identified by its one-based query position. */
export interface MonitoringSearchFailure {
  queryOrdinal: number;
  error: string;
}

export type XBlockedReason =
  | "disabled"
  | "config"
  | "auth"
  | "rate_limit"
  | "budget"
  | "state_unavailable"
  | "price_expired"
  | "contract_drift";

export type XAccountFailureReason =
  | "auth"
  | "rate_limit"
  | "account_unavailable"
  | "timeout"
  | "provider_error"
  | "malformed_response"
  | "state_unavailable"
  | "contract_drift";

export interface XAccountFailure {
  accountOrdinal: number;
  reason: XAccountFailureReason;
}

export type GeminiFailureClass =
  | "none"
  | "unavailable_503"
  | "resource_exhausted_429"
  | "unclassified_http_error"
  | "timeout"
  | "transport_error"
  | "response_invalid"
  | "accounting_failure";
export type GeminiProviderFailureClass = Extract<GeminiFailureClass, "resource_exhausted_429" | "unavailable_503">;
export type GeminiBatchAccountingOutcome = "exact" | "confirmed_zero" | "transport_ambiguous" | "pre_dispatch_zero";
export type GeminiBatchRetrySkipReason = "none" | "not_eligible" | "accounting" | "admission" | "budget" | "exhausted";
export interface GeminiBatchAttemptSummary {
  ordinal: 1 | 2 | 3;
  failureClass?: GeminiFailureClass;
  providerFailureClass?: GeminiProviderFailureClass;
  httpStatus?: number | null;
  accountingError?: boolean;
  accountingOutcome: GeminiBatchAccountingOutcome;
  elapsedMs: number;
}

export type BraveDiscoverySourceHealth = "healthy" | "degraded" | "unavailable" | "quota_blocked";
export type RssDiscoverySourceHealth = "healthy" | "degraded" | "unavailable";

export interface DiscoverySourceHealthMetrics {
  brave: BraveDiscoverySourceHealth;
  rss: RssDiscoverySourceHealth;
  outage: boolean;
}

export interface BatchCycleMetrics {
  searchAttempts: number; searchSuccesses: number; searchFailures: number;
  rawObservations: number; acceptedObservations: number;
  invalid: number; homepages: number; duplicates: number; known: number;
  poolCapExcluded: number; sizeExcluded: number; submittedCandidates: number; promptBytes: number;
  submittedBySource: { brave: number; rss: number };
  discoverySourceHealth: DiscoverySourceHealthMetrics;
  truncationStage: BatchTruncationStage | null;
  status: "empty" | "blocked" | "preparation_failed" | "provider_failed" | "timeout" | "invalid_output" | "validated";
  providerFailureClass?: GeminiProviderFailureClass;
  reservationAttempts: number; reservations: number; providerDispatches: number;
  returnedStories: number; acceptedStories: number;
  selected: Array<{
    candidateId: string; hostname: string; score: number;
    provenance: DiscoveryProvenance[];
  }>;
  freshDelivered: number; replayDelivered: number; emailCount: number;
  attempts?: GeminiBatchAttemptSummary[];
  retryEligible?: boolean;
  retryAttempted?: boolean;
  retrySkipReason?: GeminiBatchRetrySkipReason;
}

export interface MonitoringCycleResult {
  batch?: BatchCycleMetrics;
  rss?: RssCycleMetrics;
  query: string;
  searchResultsReceived: number;
  searchFailures: MonitoringSearchFailure[];
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
  geminiRequestsByModel: Record<"gemini-3.8-flash" | "gemini-3.6-flash" | "gemini-3.5-flash-lite", number>;
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
  xFailures: XAccountFailure[];
  xBlockedReason?: XBlockedReason;
  /** Present only when pre-discovery Gemini admission blocked new discovery for this cycle. */
  geminiBlockedReason?: GeminiBlockedReason;
  /** Counts timeout records whose token usage remains unknown in active accounting windows. */
  geminiTimeoutIncompleteAccounting?: GeminiTimeoutAccountingDiagnostic;
  outcomes: MonitoringCycleOutcome[];
  /** Closed, bounded final-delivery evidence for the scheduled Batch path. */
  delivery?: DailyDeliveryTelemetry;
}
