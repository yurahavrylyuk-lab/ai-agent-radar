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

/** A validated analysis retained under its normalized source URL identity. */
export interface StoredDiscovery {
  normalizedUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  analysis: AgentAnalysis;
}

export type DiscoveryProcessingResult =
  | { status: "new"; discovery: StoredDiscovery }
  | { status: "duplicate"; discovery: StoredDiscovery };

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

export interface MonitoringCycleResult {
  query: string;
  searchResultsReceived: number;
  resultsProcessed: number;
  newDiscoveries: number;
  duplicates: number;
  analysesAttempted: number;
  notificationsSent: number;
  notificationsAlreadySent: number;
  notificationsNotEligible: number;
  failures: number;
  stoppedByAnalysisCap: boolean;
  outcomes: MonitoringCycleOutcome[];
}
