import "dotenv/config";
import { notifyDiscovery } from "./services/notificationOrchestrator.js";
import { processSearchResult } from "./services/discoveryProcessor.js";
import { searchWeb } from "./tools/webSearch.js";
import { LocalJsonBraveUsageStore } from "./services/localJsonBraveUsageStore.js";
import { JsonDiscoveryHistory } from "./services/discoveryHistory.js";
import { JsonNotificationHistory } from "./services/notificationHistory.js";
import { LocalJsonGeminiUsageStore } from "./services/localJsonGeminiUsageStore.js";
import { analyzeSearchResult } from "./services/analysisAgent.js";
import { sendWithResend } from "./tools/email/resend.js";
import { generateWithGemini } from "./tools/llm/gemini.js";
import type { AgentAnalysis, SearchResult } from "./types/index.js";

const DISCOVERY_QUERY = "new AI agent developer tool framework release";

function printSelectedResult(result: SearchResult): void {
  console.info("SELECTED DISCOVERY");
  console.info(`Title: ${result.title}`);
  console.info(`URL: ${result.url}`);
  console.info(`Snippet: ${result.snippet ?? "(not available)"}`);
}

function printAnalysis(analysis: AgentAnalysis): void {
  console.info("\nANALYSIS");
  console.info(`Name: ${analysis.name}`);
  console.info(`Category: ${analysis.category}`);
  console.info(`Relevance score: ${analysis.relevanceScore}`);
  console.info(`Summary: ${analysis.summary}`);
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
  if (!selectedResult) throw new Error("Brave Search returned no valid results to process.");
  printSelectedResult(selectedResult);

  const processing = await processSearchResult(selectedResult, { history: new JsonDiscoveryHistory(), analyze: (result) => analyzeSearchResult(result, { generate: (input) => generateWithGemini(input, { usageTracker: new LocalJsonGeminiUsageStore() }) }) });
  console.info(`\nDiscovery processing status: ${processing.status}`);

  if (processing.status === "new") {
    const analysis = processing.discovery.analysis;
    if (analysis.sourceTitle !== selectedResult.title || analysis.sourceUrl !== selectedResult.url) {
      throw new Error("Analysis source integrity verification failed.");
    }
    printAnalysis(analysis);
  }

  const notification = await notifyDiscovery(processing, { history: new JsonNotificationHistory(), sendEmail: sendWithResend });
  console.info(`\nNotification status: ${notification.status}`);
  if (notification.status !== "not_eligible") {
    console.info(`Notification sent at: ${notification.record.sentAt}`);
    if (notification.record.providerMessageId) console.info(`Provider message ID: ${notification.record.providerMessageId}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[ERROR] End-to-end test failed: ${message}`);
  process.exitCode = 1;
}
