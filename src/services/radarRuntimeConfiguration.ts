import { getGeminiUsageLimits } from "./geminiUsageGuard.js";
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
] as const;

export interface RadarRuntimeConfiguration {
  environment: RuntimeEnvironment;
}

/** Validates Worker/local configuration without exposing secret values. */
export function createRadarRuntimeConfiguration(source: RuntimeEnvironment): RadarRuntimeConfiguration {
  const environment: RuntimeEnvironment = {};
  for (const name of radarConfigurationNames) {
    environment[name] = source[name];
  }

  for (const name of requiredRadarSecretNames) {
    if (!environment[name]?.trim()) throw new Error(`${name} is required.`);
  }
  if (!environment.GEMINI_MODEL?.trim()) throw new Error("GEMINI_MODEL is required.");

  getBraveUsageLimits(environment);
  getGeminiUsageLimits(environment);
  return { environment };
}
