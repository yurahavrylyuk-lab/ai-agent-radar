import type { GeminiUsageData, GeminiUsageRecord, GeminiUsageTracker } from "./geminiUsageTracker.js";

export interface GeminiUsageLimits { dailyRequests: number; weeklyRequests: number; monthlyRequests: number; dailyTokens: number; weeklyTokens: number; monthlyTokens: number; }
export interface GeminiUsageCounts extends GeminiUsageLimits {}
export type GeminiUsageCheck = { allowed: true; counts: GeminiUsageCounts; limits: GeminiUsageLimits } | { allowed: false };
export class InvalidGeminiUsageLimitError extends Error {}

const names = ["GEMINI_DAILY_REQUEST_LIMIT", "GEMINI_WEEKLY_REQUEST_LIMIT", "GEMINI_MONTHLY_REQUEST_LIMIT", "GEMINI_DAILY_TOKEN_LIMIT", "GEMINI_WEEKLY_TOKEN_LIMIT", "GEMINI_MONTHLY_TOKEN_LIMIT"] as const;
function positive(name: string, value: string | undefined): number { if (!value || !/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new InvalidGeminiUsageLimitError(`${name} must be a positive integer.`); return Number(value); }
export function getGeminiUsageLimits(env = process.env): GeminiUsageLimits {
  const values = names.map((name) => positive(name, env[name]));
  return { dailyRequests: values[0], weeklyRequests: values[1], monthlyRequests: values[2], dailyTokens: values[3], weeklyTokens: values[4], monthlyTokens: values[5] };
}
function weekStart(date: Date): number { const value = new Date(date); value.setHours(0, 0, 0, 0); value.setDate(value.getDate() - ((value.getDay() + 6) % 7)); return value.getTime(); }
export function getGeminiUsageCounts(records: GeminiUsageRecord[], now = new Date()): GeminiUsageCounts {
  const counts: GeminiUsageCounts = { dailyRequests: 0, weeklyRequests: 0, monthlyRequests: 0, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 0 };
  for (const record of records) {
    const date = new Date(record.timestamp); if (Number.isNaN(date.getTime())) throw new Error("Gemini usage file contains an invalid request timestamp.");
    const day = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    const week = weekStart(date) === weekStart(now); const month = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    if (day) { counts.dailyRequests++; counts.dailyTokens += record.totalTokens; }
    if (week) { counts.weeklyRequests++; counts.weeklyTokens += record.totalTokens; }
    if (month) { counts.monthlyRequests++; counts.monthlyTokens += record.totalTokens; }
  } return counts;
}
export function reachedGeminiLimit(c: GeminiUsageCounts, l: GeminiUsageLimits): string | undefined {
  if (c.dailyRequests >= l.dailyRequests) return "daily request"; if (c.weeklyRequests >= l.weeklyRequests) return "weekly request"; if (c.monthlyRequests >= l.monthlyRequests) return "monthly request";
  if (c.dailyTokens >= l.dailyTokens) return "daily token"; if (c.weeklyTokens >= l.weeklyTokens) return "weekly token"; if (c.monthlyTokens >= l.monthlyTokens) return "monthly token";
}
export async function checkGeminiUsage(tracker: GeminiUsageTracker, env = process.env): Promise<GeminiUsageCheck> {
  try {
    const limits = getGeminiUsageLimits(env); const data: GeminiUsageData = await tracker.getUsageData(); if (data.usageUnknown) throw new Error("Unknown Gemini token usage.");
    const counts = getGeminiUsageCounts(data.records); const limit = reachedGeminiLimit(counts, limits);
    if (limit) { console.warn(`[WARN] Gemini ${limit} limit reached.`); console.warn("[WARN] Gemini request blocked."); return { allowed: false }; }
    console.info(`[INFO] Gemini usage today: ${counts.dailyRequests}/${limits.dailyRequests} requests`); console.info(`[INFO] Gemini tokens today: ${counts.dailyTokens}/${limits.dailyTokens}`); return { allowed: true, counts, limits };
  } catch (error) { console.error(error instanceof InvalidGeminiUsageLimitError ? `[ERROR] Gemini usage limit configuration is invalid: ${error.message}` : "[ERROR] Unable to verify Gemini API usage."); console.error("[ERROR] Gemini request blocked for safety."); return { allowed: false }; }
}
