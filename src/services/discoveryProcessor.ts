import { analyzeSearchResult } from "./analysisAgent.js";
import { JsonDiscoveryHistory, type DiscoveryHistory } from "./discoveryHistory.js";
import type { AgentAnalysis, DiscoveryProcessingResult, SearchResult } from "../types/index.js";

type AnalyzeSearchResult = (result: SearchResult) => Promise<AgentAnalysis>;

export interface DiscoveryProcessorDependencies {
  history?: DiscoveryHistory;
  analyze?: AnalyzeSearchResult;
  now?: () => Date;
}

function verifySourceIntegrity(analysis: AgentAnalysis, result: SearchResult): void {
  if (analysis.sourceTitle !== result.title || analysis.sourceUrl !== result.url) {
    throw new Error("Analysis result source integrity verification failed.");
  }
}

export async function processSearchResult(
  result: SearchResult,
  dependencies: DiscoveryProcessorDependencies = {},
): Promise<DiscoveryProcessingResult> {
  const history = dependencies.history ?? new JsonDiscoveryHistory();
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
  const discovery = await history.recordDiscovery(analysis, now());
  return { status: "new", discovery };
}
