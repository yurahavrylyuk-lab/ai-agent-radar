import "dotenv/config";
import { analyzeSearchResult } from "./services/analysisAgent.js";
import type { AgentAnalysis, SearchResult } from "./types/index.js";

const testResult: SearchResult = {
  title: "Example: New open-source framework for building multi-agent applications",
  snippet: "A TypeScript framework that lets developers create AI agents, connect tools, maintain state, and coordinate multiple specialized agents.",
  url: "https://example.com/test-ai-agent",
};

function printAnalysis(analysis: AgentAnalysis): void {
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
  printAnalysis(await analyzeSearchResult(testResult));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[ERROR] Analysis Agent test failed: ${message}`);
  process.exitCode = 1;
}
