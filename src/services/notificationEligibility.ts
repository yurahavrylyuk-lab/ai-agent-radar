import type { DiscoveryProcessingResult } from "../types/index.js";

export const NOTIFICATION_RELEVANCE_THRESHOLD = 7;

/** Returns whether a newly stored discovery is useful enough to notify about. */
export function isNotificationEligible(result: DiscoveryProcessingResult): boolean {
  return result.status === "new" && result.discovery.analysis.relevanceScore >= NOTIFICATION_RELEVANCE_THRESHOLD;
}
