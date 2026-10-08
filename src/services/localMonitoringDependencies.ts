import { analyzeSearchResult } from "./analysisAgent.js";
import { JsonDiscoveryHistory } from "./discoveryHistory.js";
import { processSearchResult } from "./discoveryProcessor.js";
import { inspectGeminiAvailability } from "./geminiUsageGuard.js";
import { LocalJsonBraveUsageStore } from "./localJsonBraveUsageStore.js";
import { LocalJsonGeminiUsageStore } from "./localJsonGeminiUsageStore.js";
import { LocalJsonXStore } from "./localJsonXStore.js";
import type { MonitoringCycleDependencies } from "./monitor.js";
import { JsonNotificationHistory } from "./notificationHistory.js";
import { collectXDiscoveries } from "./xDiscovery.js";
import { createGeminiCycleContext, generateWithGemini } from "../tools/llm/gemini.js";
import { searchWeb } from "../tools/webSearch.js";

/** Explicit Node/local composition. This module must never enter the Worker graph. */
export function createLocalMonitoringDependencies(
  environment: NodeJS.ProcessEnv = globalThis.process.env,
): MonitoringCycleDependencies {
  const history = new JsonDiscoveryHistory();
  const notificationHistory = new JsonNotificationHistory();
  const braveUsageStore = new LocalJsonBraveUsageStore();
  const geminiUsageStore = new LocalJsonGeminiUsageStore();
  const xStore = new LocalJsonXStore();
  const geminiCycleContext = createGeminiCycleContext();

  return {
    history,
    geminiCycleContext,
    geminiPreflight: (now) => inspectGeminiAvailability(geminiUsageStore, environment, now),
    search: (query, options) => searchWeb(query, {
      usageTracker: braveUsageStore,
      environment,
      freshness: options?.freshness,
    }),
    collectX: (now) => collectXDiscoveries({ store: xStore, environment, now }),
    markXStoryProcessed: (storyUrl) => xStore.markStoryProcessed(storyUrl),
    process: (result, sourceProvenance) => processSearchResult(result, {
      history,
      sourceProvenance,
      analyze: (searchResult) => analyzeSearchResult(searchResult, {
        generate: (input) => generateWithGemini(input, {
          usageTracker: geminiUsageStore,
          environment,
          cycleContext: geminiCycleContext,
        }),
        onValidatedAnalysis: (response) => {
          if (response.usedFallback) geminiCycleContext.analysesUsingFallbackModel += 1;
        },
      }),
    }),
    notification: { history: notificationHistory },
  };
}
