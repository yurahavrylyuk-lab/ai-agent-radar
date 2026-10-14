import type { BatchCandidate, BatchObservation, CandidatePool, SearchResult } from "../types/index.js";
import { normalizeDiscoveryUrl, type DiscoveryHistory } from "./discoveryHistoryCore.js";
import type { NotificationHistory } from "./notificationHistoryCore.js";

const encoder = new TextEncoder();

/** Cycle-local fragment grouping; never a replacement for durable URL keys. */
export function batchAliasKey(url: string): string {
  const canonical = new URL(normalizeDiscoveryUrl(url));
  canonical.hash = "";
  return canonical.toString();
}

function parseBatchUrl(value: string): URL | undefined {
  if (typeof value !== "string" || encoder.encode(value).byteLength > 2048) return undefined;
  try {
    const url = new URL(normalizeDiscoveryUrl(value));
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function isBatchNewsUrl(url: string): boolean {
  const parsed = parseBatchUrl(url);
  return parsed !== undefined && parsed.pathname !== "/";
}

function validSource(value: unknown): value is SearchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return typeof source.title === "string" && source.title.trim().length > 0
    && typeof source.url === "string"
    && [source.snippet, source.publishedAt, source.source].every((field) => field === undefined || typeof field === "string");
}

/** Prepares at most fifty observed positions using verified durable history. */
export async function prepareBatchCandidates(
  observations: readonly BatchObservation[],
  dependencies: { history: DiscoveryHistory; notificationHistory: NotificationHistory; seenAt: Date },
): Promise<CandidatePool> {
  const counts: CandidatePool["counts"] = { acceptedObservations: 0, invalid: 0, homepages: 0, duplicates: 0, known: 0 };
  const bounded: BatchObservation[] = [];
  for (const observation of observations) {
    if (!observation || !Number.isInteger(observation.queryOrdinal) || observation.queryOrdinal < 1 || observation.queryOrdinal > 10
        || !Number.isInteger(observation.resultOrdinal) || observation.resultOrdinal < 1 || observation.resultOrdinal > 5) {
      counts.invalid += 1;
      continue;
    }
    bounded.push(observation);
  }
  bounded.sort((left, right) => left.queryOrdinal - right.queryOrdinal || left.resultOrdinal - right.resultOrdinal);

  const positions = new Set<string>();
  const groups = new Map<string, Omit<BatchCandidate, "candidateId">>();
  for (const observation of bounded) {
    const { queryOrdinal, resultOrdinal, result } = observation;
    const position = `${queryOrdinal}:${resultOrdinal}`;
    if (positions.has(position)) {
      counts.invalid += 1;
      continue;
    }
    positions.add(position);
    // A null/invalid source still consumes its original bounded provider position.
    counts.acceptedObservations += 1;
    if (!validSource(result)) {
      counts.invalid += 1;
      continue;
    }
    const url = parseBatchUrl(result.url);
    if (!url) {
      counts.invalid += 1;
      continue;
    }
    if (url.pathname === "/") {
      counts.homepages += 1;
      continue;
    }
    const normalizedUrl = url.toString();
    const aliasKey = batchAliasKey(normalizedUrl);
    const existing = groups.get(aliasKey);
    if (existing) {
      counts.duplicates += 1;
      if (!existing.aliases.includes(normalizedUrl)) existing.aliases.push(normalizedUrl);
      existing.provenance.push({ queryOrdinal, resultOrdinal });
    } else {
      groups.set(aliasKey, { source: result, normalizedUrl, aliasKey, aliases: [normalizedUrl], provenance: [{ queryOrdinal, resultOrdinal }] });
    }
  }

  const observedAliases = new Map<string, readonly string[]>();
  const candidates: BatchCandidate[] = [];
  for (const group of groups.values()) {
    observedAliases.set(group.aliasKey, [...group.aliases]);
    let known = false;
    const existingAliases: string[] = [];
    for (const alias of group.aliases) {
      // Read both evidence sources for every alias, even after an earlier match.
      const discovery = await dependencies.history.getDiscovery(alias);
      const notification = await dependencies.notificationHistory.getNotificationRecord(alias, "email");
      if (discovery) existingAliases.push(alias);
      if (discovery || notification) known = true;
    }
    for (const alias of existingAliases) await dependencies.history.touchDiscovery(alias, dependencies.seenAt);
    if (known) {
      counts.known += 1;
      continue;
    }
    candidates.push({ ...group, candidateId: `c${String(candidates.length + 1).padStart(3, "0")}` });
  }
  return { candidates, observedAliases, counts };
}
