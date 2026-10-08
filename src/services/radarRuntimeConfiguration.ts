import { validateGeminiConfiguration } from "./geminiUsageGuard.js";
import { getBraveUsageLimits } from "./usageGuard.js";

export type RuntimeEnvironment = Record<string, string | undefined>;

export const requiredRadarSecretNames = [
  "BRAVE_SEARCH_API_KEY",
  "GEMINI_API_KEY",
  "RESEND_API_KEY",
  "NOTIFICATION_EMAIL",
] as const;

export const radarConfigurationNames = [
  ...requiredRadarSecretNames,
  "BRAVE_DAILY_SEARCH_LIMIT",
  "BRAVE_WEEKLY_SEARCH_LIMIT",
  "BRAVE_MONTHLY_SEARCH_LIMIT",
  "GEMINI_MODEL",
  "GEMINI_DAILY_REQUEST_LIMIT",
  "GEMINI_WEEKLY_REQUEST_LIMIT",
  "GEMINI_MONTHLY_REQUEST_LIMIT",
  "GEMINI_DAILY_TOKEN_LIMIT",
  "GEMINI_WEEKLY_TOKEN_LIMIT",
  "GEMINI_MONTHLY_TOKEN_LIMIT",
  "X_DISCOVERY_ENABLED",
  "X_BEARER_TOKEN",
] as const;

export interface RadarRuntimeConfiguration {
  environment: RuntimeEnvironment;
}

function copyEnvironment(source: RuntimeEnvironment): RuntimeEnvironment {
  const environment: RuntimeEnvironment = {};
  for (const name of radarConfigurationNames) {
    environment[name] = source[name];
  }
  return environment;
}

function validateNonGeminiConfiguration(environment: RuntimeEnvironment): void {
  for (const name of requiredRadarSecretNames.filter((name) => name !== "GEMINI_API_KEY")) {
    if (!environment[name]?.trim()) throw new Error(`${name} is required.`);
  }
  getBraveUsageLimits(environment);
}

/** Validates all Worker/local runtime configuration without exposing secret values. */
export function createRadarRuntimeConfiguration(source: RuntimeEnvironment): RadarRuntimeConfiguration {
  const environment = copyEnvironment(source);
  validateNonGeminiConfiguration(environment);
  validateGeminiConfiguration(environment);
  return { environment };
}

/** Defers only Gemini admission validation so safe replay delivery can run while Gemini is blocked. */
export function createMonitoringRuntimeConfiguration(source: RuntimeEnvironment): RadarRuntimeConfiguration {
  const environment = copyEnvironment(source);
  validateNonGeminiConfiguration(environment);
  return { environment };
}
