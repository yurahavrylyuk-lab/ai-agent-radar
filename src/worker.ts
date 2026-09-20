import { D1BraveUsageStore } from "./services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "./services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "./services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "./services/d1NotificationHistory.js";
import { analyzeSearchResult } from "./services/analysisAgent.js";
import { processSearchResult } from "./services/discoveryProcessor.js";
import { notifyDiscovery } from "./services/notificationOrchestrator.js";
import { createRadarRuntimeConfiguration } from "./services/radarRuntimeConfiguration.js";
import { generateWithGemini } from "./tools/llm/gemini.js";
import { sendWithResend } from "./tools/email/resend.js";
import { searchWeb } from "./tools/webSearch.js";
import type { MonitoringCycleDependencies } from "./services/monitor.js";

/** Worker binding names only. Secret values are configured outside source control in Step 8.3. */
export interface RadarWorkerEnv {
  DB: D1Database;
  BRAVE_SEARCH_API_KEY: string;
  BRAVE_DAILY_SEARCH_LIMIT: string;
  BRAVE_WEEKLY_SEARCH_LIMIT: string;
  BRAVE_MONTHLY_SEARCH_LIMIT: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  GEMINI_DAILY_REQUEST_LIMIT: string;
  GEMINI_WEEKLY_REQUEST_LIMIT: string;
  GEMINI_MONTHLY_REQUEST_LIMIT: string;
  GEMINI_DAILY_TOKEN_LIMIT: string;
  GEMINI_WEEKLY_TOKEN_LIMIT: string;
  GEMINI_MONTHLY_TOKEN_LIMIT: string;
  RESEND_API_KEY: string;
  NOTIFICATION_EMAIL: string;
}

/** Composes cloud persistence without starting a monitoring cycle or invoking a provider. */
export function createWorkerPersistence(env: RadarWorkerEnv) {
  return {
    discoveryHistory: new D1DiscoveryHistory(env.DB),
    notificationHistory: new D1NotificationHistory(env.DB),
    braveUsageStore: new D1BraveUsageStore(env.DB),
    geminiUsageStore: new D1GeminiUsageStore(env.DB),
  };
}

/** Creates cloud-ready cycle dependencies without invoking a monitoring cycle. */
export function createWorkerMonitoringDependencies(env: RadarWorkerEnv): MonitoringCycleDependencies {
  const configuration = createRadarRuntimeConfiguration(env as unknown as Record<string, string | undefined>);
  const persistence = createWorkerPersistence(env);

  return {
    search: (query) => searchWeb(query, {
      usageTracker: persistence.braveUsageStore,
      environment: configuration.environment,
    }),
    process: (result) => processSearchResult(result, {
      history: persistence.discoveryHistory,
      analyze: (searchResult) => analyzeSearchResult(searchResult, {
        generate: (input) => generateWithGemini(input, {
          usageTracker: persistence.geminiUsageStore,
          environment: configuration.environment,
        }),
      }),
    }),
    notification: {
      history: persistence.notificationHistory,
      sendEmail: (content) => sendWithResend(content, {
        environment: configuration.environment,
      }),
    },
    notify: (result) => notifyDiscovery(result, {
      history: persistence.notificationHistory,
      sendEmail: (content) => sendWithResend(content, {
        environment: configuration.environment,
      }),
    }),
  };
}

export default {
  fetch(_request: Request, env: RadarWorkerEnv): Response {
    createWorkerPersistence(env);
    return new Response("AI Agent Radar worker ready", {
      headers: { "content-type": "text/plain; charset=UTF-8" },
    });
  },
};
