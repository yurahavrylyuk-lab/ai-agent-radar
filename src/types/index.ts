import type { GeminiBlockedReason, GeminiTimeoutAccountingDiagnostic } from "../services/geminiUsageGuard.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
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

/** Application-owned X attribution. This is never accepted from model output. */
export interface XSourceProvenance {
  kind: "x";
  postId: string;
  authorId: string;
  postUrl: string;
  label: string;
}

/** A validated analysis retained under its normalized source URL identity. */
export interface StoredDiscovery {
  normalizedUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  analysis: AgentAnalysis;
  sourceProvenance?: XSourceProvenance;
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

export interface MonitoringCycleResult {
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
}
