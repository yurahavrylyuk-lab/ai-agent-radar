import { agentAnalysisCategories, type AgentAnalysis, type AgentAnalysisCategory, type StoredDiscovery } from "../types/index.js";

export class DiscoveryHistoryError extends Error {}

export interface DiscoveryHistory {
  getDiscovery(url: string): Promise<StoredDiscovery | undefined>;
  recordDiscovery(analysis: AgentAnalysis, seenAt?: Date): Promise<StoredDiscovery>;
  touchDiscovery(url: string, seenAt?: Date): Promise<StoredDiscovery | undefined>;
}

function nonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }

/** Shared, runtime-neutral discovery validation for JSON and D1 persistence. */
export function isValidAgentAnalysis(value: unknown): value is AgentAnalysis {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const analysis = value as Record<string, unknown>;
  return nonEmptyString(analysis.name) && nonEmptyString(analysis.category) && agentAnalysisCategories.includes(analysis.category as AgentAnalysisCategory) &&
    nonEmptyString(analysis.summary) && typeof analysis.relevanceScore === "number" && Number.isInteger(analysis.relevanceScore) && analysis.relevanceScore >= 1 && analysis.relevanceScore <= 10 &&
    nonEmptyString(analysis.whyItMatters) && nonEmptyString(analysis.educationalValue) && stringArray(analysis.projectOpportunities) && stringArray(analysis.technologies) &&
    nonEmptyString(analysis.sourceTitle) && nonEmptyString(analysis.sourceUrl);
}

export function normalizeDiscoveryUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new DiscoveryHistoryError("Discovery URL must be a non-empty string.");
  try { const url = new URL(trimmed); url.pathname = url.pathname.replace(/\/+$/, "") || "/"; return url.toString(); }
  catch { throw new DiscoveryHistoryError("Discovery URL must be a valid absolute URL."); }
}
