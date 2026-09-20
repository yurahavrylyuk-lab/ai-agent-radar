import assert from "node:assert/strict";
import test from "node:test";
import { D1BraveUsageStore } from "../src/services/d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "../src/services/d1DiscoveryHistory.js";
import { D1GeminiUsageStore } from "../src/services/d1GeminiUsageStore.js";
import { D1NotificationHistory } from "../src/services/d1NotificationHistory.js";
import { createRadarRuntimeConfiguration } from "../src/services/radarRuntimeConfiguration.js";
import worker, { createWorkerMonitoringDependencies, createWorkerPersistence, type RadarWorkerEnv } from "../src/worker.js";

function environment(): RadarWorkerEnv {
  return {
    DB: {} as D1Database,
    BRAVE_SEARCH_API_KEY: "brave-test-key",
    BRAVE_DAILY_SEARCH_LIMIT: "10",
    BRAVE_WEEKLY_SEARCH_LIMIT: "50",
    BRAVE_MONTHLY_SEARCH_LIMIT: "200",
    GEMINI_API_KEY: "gemini-test-key",
    GEMINI_MODEL: "gemini-3.6-flash",
    GEMINI_DAILY_REQUEST_LIMIT: "5",
    GEMINI_WEEKLY_REQUEST_LIMIT: "20",
    GEMINI_MONTHLY_REQUEST_LIMIT: "50",
    GEMINI_DAILY_TOKEN_LIMIT: "10000",
    GEMINI_WEEKLY_TOKEN_LIMIT: "30000",
    GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
    RESEND_API_KEY: "resend-test-key",
    NOTIFICATION_EMAIL: "radar@example.test",
  };
}

test("Worker runtime configuration preserves configured limits and rejects missing secrets", () => {
  const configuration = createRadarRuntimeConfiguration(environment());
  assert.equal(configuration.environment.BRAVE_DAILY_SEARCH_LIMIT, "10");
  assert.equal(configuration.environment.GEMINI_MONTHLY_TOKEN_LIMIT, "100000");
  const missing = environment();
  missing.GEMINI_API_KEY = "";
  assert.throws(() => createRadarRuntimeConfiguration(missing), /GEMINI_API_KEY is required/);
});

test("Worker composition uses D1 stores and does not schedule or start monitoring", () => {
  const persistence = createWorkerPersistence(environment());
  const dependencies = createWorkerMonitoringDependencies(environment());
  assert.ok(persistence.discoveryHistory instanceof D1DiscoveryHistory);
  assert.ok(persistence.notificationHistory instanceof D1NotificationHistory);
  assert.ok(persistence.braveUsageStore instanceof D1BraveUsageStore);
  assert.ok(persistence.geminiUsageStore instanceof D1GeminiUsageStore);
  assert.equal(typeof dependencies.search, "function");
  assert.equal(typeof dependencies.process, "function");
  assert.equal(typeof dependencies.notify, "function");
  assert.equal("scheduled" in worker, false);
});
