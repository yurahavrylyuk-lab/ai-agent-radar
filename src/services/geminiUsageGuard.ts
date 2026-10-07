import type { RuntimeEnvironment } from "./radarRuntimeConfiguration.js";
import { isGeminiUsageRecord, type GeminiUsageData, type GeminiUsageRecord, type GeminiUsageStore } from "./geminiUsageTracker.js";

export interface GeminiUsageLimits { dailyRequests: number; weeklyRequests: number; monthlyRequests: number; dailyTokens: number; weeklyTokens: number; monthlyTokens: number; }
export interface GeminiUsageCounts extends GeminiUsageLimits {}
export type GeminiBlockedReason =
  | "usage_unknown"
  | "daily_request_limit"
  | "weekly_request_limit"
  | "monthly_request_limit"
  | "daily_token_limit"
  | "weekly_token_limit"
  | "monthly_token_limit"
  | "usage_state_unavailable"
  | "invalid_configuration";
export type GeminiAvailability =
  | { allowed: true; counts: GeminiUsageCounts; limits: GeminiUsageLimits }
  | { allowed: false; reason: GeminiBlockedReason };
/** @deprecated Use GeminiAvailability for new integrations. */
export type GeminiUsageCheck = GeminiAvailability;
export type GeminiUsageReader = Pick<GeminiUsageStore, "getUsageData">;
export class InvalidGeminiUsageLimitError extends Error {}

const names = ["GEMINI_DAILY_REQUEST_LIMIT", "GEMINI_WEEKLY_REQUEST_LIMIT", "GEMINI_MONTHLY_REQUEST_LIMIT", "GEMINI_DAILY_TOKEN_LIMIT", "GEMINI_WEEKLY_TOKEN_LIMIT", "GEMINI_MONTHLY_TOKEN_LIMIT"] as const;
const limitReasons = [
  "daily_request_limit",
  "weekly_request_limit",
  "monthly_request_limit",
  "daily_token_limit",
  "weekly_token_limit",
  "monthly_token_limit",
] as const satisfies readonly GeminiBlockedReason[];
const limitLabels: Record<(typeof limitReasons)[number], string> = {
  daily_request_limit: "daily request",
  weekly_request_limit: "weekly request",
  monthly_request_limit: "monthly request",
  daily_token_limit: "daily token",
  weekly_token_limit: "weekly token",
  monthly_token_limit: "monthly token",
};

function positive(name: string, value: string | undefined): number { if (!value || !/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new InvalidGeminiUsageLimitError(`${name} must be a positive integer.`); return Number(value); }
export function getGeminiUsageLimits(env: Record<string, string | undefined> = process.env): GeminiUsageLimits {
  const values = names.map((name) => positive(name, env[name]));
  return { dailyRequests: values[0], weeklyRequests: values[1], monthlyRequests: values[2], dailyTokens: values[3], weeklyTokens: values[4], monthlyTokens: values[5] };
}

/** Validates the local configuration needed to dispatch a Gemini request without exposing values. */
export function validateGeminiConfiguration(env: RuntimeEnvironment = process.env): GeminiUsageLimits {
  if (!env.GEMINI_API_KEY?.trim()) throw new InvalidGeminiUsageLimitError("GEMINI_API_KEY is required.");
  return getGeminiUsageLimits(env);
}

function weekStart(date: Date): number { const value = new Date(date); value.setHours(0, 0, 0, 0); value.setDate(value.getDate() - ((value.getDay() + 6) % 7)); return value.getTime(); }
export function getGeminiUsageCounts(records: GeminiUsageRecord[], now = new Date()): GeminiUsageCounts {
  if (Number.isNaN(now.getTime())) throw new Error("Gemini usage evaluation time is invalid.");
  const counts: GeminiUsageCounts = { dailyRequests: 0, weeklyRequests: 0, monthlyRequests: 0, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 0 };
  for (const record of records) {
    const date = new Date(record.timestamp); if (Number.isNaN(date.getTime())) throw new Error("Gemini usage file contains an invalid request timestamp.");
    const day = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    const week = weekStart(date) === weekStart(now); const month = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    if (day) { counts.dailyRequests++; counts.dailyTokens += record.totalTokens; }
    if (week) { counts.weeklyRequests++; counts.weeklyTokens += record.totalTokens; }
    if (month) { counts.monthlyRequests++; counts.monthlyTokens += record.totalTokens; }
  }
  if (!Object.values(counts).every(Number.isSafeInteger)) throw new Error("Gemini usage totals are invalid.");
  return counts;
}

export function reachedGeminiBlockedReason(c: GeminiUsageCounts, l: GeminiUsageLimits): (typeof limitReasons)[number] | undefined {
  if (c.dailyRequests >= l.dailyRequests) return "daily_request_limit";
  if (c.weeklyRequests >= l.weeklyRequests) return "weekly_request_limit";
  if (c.monthlyRequests >= l.monthlyRequests) return "monthly_request_limit";
  if (c.dailyTokens >= l.dailyTokens) return "daily_token_limit";
  if (c.weeklyTokens >= l.weeklyTokens) return "weekly_token_limit";
  if (c.monthlyTokens >= l.monthlyTokens) return "monthly_token_limit";
}

export function reachedGeminiLimit(c: GeminiUsageCounts, l: GeminiUsageLimits): string | undefined {
  const reason = reachedGeminiBlockedReason(c, l);
  return reason === undefined ? undefined : limitLabels[reason];
}

function isGeminiUsageData(value: unknown): value is GeminiUsageData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return typeof data.usageUnknown === "boolean" && Array.isArray(data.records) && data.records.every(isGeminiUsageRecord);
}

/**
 * Reads only local accounting/configuration state. It never reserves usage, clears a latch,
 * calls a provider, or mutates persistence; availability is an admission snapshot, not a remote probe.
 */
export async function inspectGeminiAvailability(
  reader: GeminiUsageReader,
  environment: RuntimeEnvironment = process.env,
  now = new Date(),
): Promise<GeminiAvailability> {
  let limits: GeminiUsageLimits;
  try { limits = validateGeminiConfiguration(environment); }
  catch { return { allowed: false, reason: "invalid_configuration" }; }

  let data: GeminiUsageData;
  let counts: GeminiUsageCounts;
  try {
    data = await reader.getUsageData();
    if (!isGeminiUsageData(data)) throw new Error("Gemini usage state is invalid.");
    counts = getGeminiUsageCounts(data.records, now);
  } catch { return { allowed: false, reason: "usage_state_unavailable" }; }

  if (data.usageUnknown) return { allowed: false, reason: "usage_unknown" };
  const reason = reachedGeminiBlockedReason(counts, limits);
  return reason === undefined ? { allowed: true, counts, limits } : { allowed: false, reason };
}

/** Logs only bounded, secret-free guard status immediately before each Gemini dispatch. */
export async function checkGeminiUsage(
  tracker: GeminiUsageStore,
  environment: RuntimeEnvironment = process.env,
  now = new Date(),
): Promise<GeminiAvailability> {
  const availability = await inspectGeminiAvailability(tracker, environment, now);
  if (!availability.allowed) {
    if (availability.reason === "invalid_configuration") console.error("[ERROR] Gemini usage limit configuration is invalid.");
    else if (availability.reason === "usage_state_unavailable") console.error("[ERROR] Unable to verify Gemini API usage.");
    else if (availability.reason === "usage_unknown") console.error("[ERROR] Gemini usage is unknown.");
    else console.warn(`[WARN] Gemini ${limitLabels[availability.reason]} limit reached.`);
    console.error("[ERROR] Gemini request blocked for safety.");
    return availability;
  }
  console.info(`[INFO] Gemini usage today: ${availability.counts.dailyRequests}/${availability.limits.dailyRequests} requests`);
  console.info(`[INFO] Gemini tokens today: ${availability.counts.dailyTokens}/${availability.limits.dailyTokens}`);
  return availability;
}
