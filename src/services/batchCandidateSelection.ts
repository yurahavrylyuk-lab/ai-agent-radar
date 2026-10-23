import { RSS_FEEDS } from "../config/rssSources.js";
import type { BatchCandidate, DiscoveryProvenance } from "../types/index.js";

export const MAX_GEMINI_ANALYSIS_CANDIDATES = 24;

type CandidateSource = "brave" | "rss";

interface QueueEntry {
  candidate: BatchCandidate;
  originalIndex: number;
  position: number;
}

interface OwnedCandidate {
  source: CandidateSource;
  queueIndex: number;
  entry: QueueEntry;
}

const SOURCE_PATTERN: readonly CandidateSource[] = ["brave", "brave", "brave", "rss"];
const HOST_PREFERENCE_LIMIT = 2;

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareProvenance(left: DiscoveryProvenance, right: DiscoveryProvenance): number {
  if (left.kind !== right.kind) return left.kind === "brave" ? -1 : 1;
  if (left.kind === "brave" && right.kind === "brave") {
    return left.queryOrdinal - right.queryOrdinal || left.resultOrdinal - right.resultOrdinal;
  }
  if (left.kind === "rss" && right.kind === "rss") {
    const feedOrder = new Map(RSS_FEEDS.map((feed, index) => [feed.id, index]));
    return (feedOrder.get(left.feedId) ?? RSS_FEEDS.length) - (feedOrder.get(right.feedId) ?? RSS_FEEDS.length)
      || left.itemOrdinal - right.itemOrdinal;
  }
  return 0;
}

function assignCandidate(candidate: BatchCandidate, originalIndex: number): OwnedCandidate {
  const ordered = [...candidate.provenance].sort(compareProvenance);
  const brave = ordered.find((entry): entry is Extract<DiscoveryProvenance, { kind: "brave" }> => entry.kind === "brave");
  if (brave) {
    return {
      source: "brave",
      queueIndex: brave.queryOrdinal - 1,
      entry: { candidate, originalIndex, position: brave.resultOrdinal },
    };
  }
  const rss = ordered.find((entry): entry is Extract<DiscoveryProvenance, { kind: "rss" }> => entry.kind === "rss");
  const queueIndex = rss ? RSS_FEEDS.findIndex(feed => feed.id === rss.feedId) : -1;
  if (!rss || queueIndex < 0) throw new Error("Gemini candidate provenance is invalid.");
  return {
    source: "rss",
    queueIndex,
    entry: { candidate, originalIndex, position: rss.itemOrdinal },
  };
}

function entryOrder(left: QueueEntry, right: QueueEntry): number {
  return left.position - right.position
    || left.originalIndex - right.originalIndex
    || compareCodeUnits(left.candidate.candidateId, right.candidate.candidateId);
}

/** Selects only the bounded Gemini analysis subset; full-pool delivery remains owned by the caller. */
export function selectGeminiCandidates(candidates: readonly BatchCandidate[]): {
  candidates: readonly BatchCandidate[];
  preFilterInputCount: number;
  selectorExcluded: number;
} {
  const braveQueues: QueueEntry[][] = Array.from({ length: 10 }, () => []);
  const rssQueues: QueueEntry[][] = Array.from({ length: RSS_FEEDS.length }, () => []);
  for (const [originalIndex, candidate] of candidates.entries()) {
    const owned = assignCandidate(candidate, originalIndex);
    (owned.source === "brave" ? braveQueues : rssQueues)[owned.queueIndex]!.push(owned.entry);
  }
  for (const queue of [...braveQueues, ...rssQueues]) queue.sort(entryOrder);

  const queues = { brave: braveQueues, rss: rssQueues };
  const cursors: Record<CandidateSource, number> = { brave: 0, rss: 0 };
  const selected = new Set<BatchCandidate>();
  const ordered: BatchCandidate[] = [];
  const hostCounts = new Map<string, number>();
  let preferHostDiversity = true;
  let noProgressSlots = 0;
  let patternIndex = 0;

  const pick = (source: CandidateSource): BatchCandidate | undefined => {
    const sourceQueues = queues[source];
    if (sourceQueues.length === 0) return undefined;
    for (let offset = 0; offset < sourceQueues.length; offset += 1) {
      const queueIndex = (cursors[source] + offset) % sourceQueues.length;
      const entry = sourceQueues[queueIndex]!.find(({ candidate }) => {
        if (selected.has(candidate)) return false;
        const hostname = new URL(candidate.normalizedUrl).hostname;
        return !preferHostDiversity || (hostCounts.get(hostname) ?? 0) < HOST_PREFERENCE_LIMIT;
      });
      if (!entry) continue;
      cursors[source] = (queueIndex + 1) % sourceQueues.length;
      return entry.candidate;
    }
    return undefined;
  };

  while (ordered.length < MAX_GEMINI_ANALYSIS_CANDIDATES) {
    const requestedSource = SOURCE_PATTERN[patternIndex % SOURCE_PATTERN.length]!;
    patternIndex += 1;
    const borrowedSource: CandidateSource = requestedSource === "brave" ? "rss" : "brave";
    const candidate = pick(requestedSource) ?? pick(borrowedSource);
    if (candidate) {
      selected.add(candidate);
      ordered.push(candidate);
      const hostname = new URL(candidate.normalizedUrl).hostname;
      hostCounts.set(hostname, (hostCounts.get(hostname) ?? 0) + 1);
      noProgressSlots = 0;
      continue;
    }

    noProgressSlots += 1;
    if (preferHostDiversity && noProgressSlots >= SOURCE_PATTERN.length) {
      preferHostDiversity = false;
      noProgressSlots = 0;
      continue;
    }
    if (!preferHostDiversity && noProgressSlots >= SOURCE_PATTERN.length) break;
  }

  return {
    candidates: ordered,
    preFilterInputCount: candidates.length,
    selectorExcluded: candidates.length - ordered.length,
  };
}
