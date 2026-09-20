import "dotenv/config";
import { analyzeSearchResult } from "./services/analysisAgent.js";
import { searchWeb } from "./tools/webSearch.js";
import { LocalJsonBraveUsageStore } from "./services/localJsonBraveUsageStore.js";
import type { AgentAnalysis, SearchResult } from "./types/index.js";

const DISCOVERY_QUERY = "new AI agent developer tool framework release";

function printDiscovery(result: SearchResult): void {
  console.info("DISCOVERY");
  console.info(`Title: ${result.title}`);
  console.info(`URL: ${result.url}`);
  console.info(`Snippet: ${result.snippet ?? "(not available)"}`);
}

function printAnalysis(analysis: AgentAnalysis): void {
  console.info("\nANALYSIS");
  console.info(`Name: ${analysis.name}`);
  console.info(`Category: ${analysis.category}`);
  console.info(`Summary: ${analysis.summary}`);
  console.info(`Relevance score: ${analysis.relevanceScore}`);
  console.info(`Why it matters: ${analysis.whyItMatters}`);
  console.info(`Educational value: ${analysis.educationalValue}`);
  console.info(`Project opportunities: ${analysis.projectOpportunities.join("; ")}`);
  console.info(`Technologies: ${analysis.technologies.join(", ")}`);
  console.info(`Source title: ${analysis.sourceTitle}`);
  console.info(`Source URL: ${analysis.sourceUrl}`);
}

try {
  const results = await searchWeb(DISCOVERY_QUERY, { usageTracker: new LocalJsonBraveUsageStore() });
  const selectedResult = results[0];
  if (!selectedResult) throw new Error("Brave Search returned no valid results to analyze.");

  printDiscovery(selectedResult);
  const analysis = await analyzeSearchResult(selectedResult);

  if (analysis.sourceTitle !== selectedResult.title || analysis.sourceUrl !== selectedResult.url) {
    throw new Error("Analysis source integrity verification failed.");
  }

  printAnalysis(analysis);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[ERROR] Discovery integration test failed: ${message}`);
  process.exitCode = 1;
}
