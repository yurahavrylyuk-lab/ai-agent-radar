import { analyzeSearchResult } from "./analysisAgent.js";
import { isValidAgentAnalysis, normalizeDiscoveryUrl, type DiscoveryHistory } from "./discoveryHistoryCore.js";
import { isBatchNewsUrl } from "./batchCandidates.js";
import type { AgentAnalysis, BatchSelection, DiscoveryProcessingResult, SearchResult, XSourceProvenance } from "../types/index.js";

type AnalyzeSearchResult = (result: SearchResult) => Promise<AgentAnalysis>;

export interface DiscoveryProcessorDependencies {
  history?: DiscoveryHistory;
  analyze?: AnalyzeSearchResult;
  now?: () => Date;
  sourceProvenance?: XSourceProvenance;
}

function verifySourceIntegrity(analysis: AgentAnalysis, result: SearchResult): void {
  if (analysis.sourceTitle !== result.title || analysis.sourceUrl !== result.url) {
    throw new Error("Analysis result source integrity verification failed.");
  }
}

/** Persist a batch interpretation without invoking an analyzer or generator. */
export async function recordBatchSelection(
  selection: BatchSelection,
  dependencies: { history: DiscoveryHistory; seenAt: Date },
): Promise<DiscoveryProcessingResult> {
  const { candidate, analysis } = selection;
  if (!isValidAgentAnalysis(analysis)) {
    throw new Error("Batch discovery analysis is invalid.");
  }
  verifySourceIntegrity(analysis, candidate.source);
  if (!isBatchNewsUrl(analysis.sourceUrl) || normalizeDiscoveryUrl(analysis.sourceUrl) !== candidate.normalizedUrl) {
    throw new Error("Batch discovery source identity is invalid.");
  }

  const { history, seenAt } = dependencies;
  const existing = await history.getDiscovery(candidate.normalizedUrl);
  if (existing) {
    const discovery = await history.touchDiscovery(candidate.normalizedUrl, seenAt);
    if (!discovery) throw new Error("Known discovery could not be updated safely.");
    return { status: "duplicate", discovery };
  }

  if (!history.recordDiscoveryWithOutcome) {
    throw new Error("Discovery insert outcome is required for batch persistence.");
  }
  const { discovery, created } = await history.recordDiscoveryWithOutcome(analysis, seenAt);
  return { status: created === true ? "new" : "duplicate", discovery };
}

export async function processSearchResult(
  result: SearchResult,
  dependencies: DiscoveryProcessorDependencies = {},
): Promise<DiscoveryProcessingResult> {
  const history = dependencies.history;
  if (!history) throw new Error("Discovery history is required.");
  const existing = await history.getDiscovery(result.url);
  const now = dependencies.now ?? (() => new Date());

  if (existing) {
    const discovery = await history.touchDiscovery(result.url, now());
    if (!discovery) throw new Error("Known discovery could not be updated safely.");
    return { status: "duplicate", discovery };
  }

  const analyze = dependencies.analyze ?? analyzeSearchResult;
  const analysis = await analyze(result);
  verifySourceIntegrity(analysis, result);
  const discovery = await history.recordDiscovery(analysis, now(), dependencies.sourceProvenance);
  return { status: "new", discovery };
}
