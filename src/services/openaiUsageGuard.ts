import type { OpenAIUsageData, OpenAIUsageRecord, OpenAIUsageTracker } from "./openaiUsageTracker.js";

export interface OpenAIUsageLimits {
  dailyRequests: number;
  weeklyRequests: number;
  monthlyRequests: number;
  dailyTokens: number;
  weeklyTokens: number;
  monthlyTokens: number;
}

export interface OpenAIUsageCounts {
  dailyRequests: number;
  weeklyRequests: number;
  monthlyRequests: number;
  dailyTokens: number;
  weeklyTokens: number;
  monthlyTokens: number;
}

export type OpenAIUsageCheck =
  | { allowed: true; counts: OpenAIUsageCounts; limits: OpenAIUsageLimits }
  | { allowed: false };

export class InvalidOpenAIUsageLimitError extends Error {}

function parsePositiveInteger(name: string, value: string | undefined): number {
  if (!value || !/^\d+$/.test(value.trim())) {
    throw new InvalidOpenAIUsageLimitError(`${name} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidOpenAIUsageLimitError(`${name} must be a positive integer.`);
  }

  return parsed;
}

export function getOpenAIUsageLimits(environment = process.env): OpenAIUsageLimits {
  return {
    dailyRequests: parsePositiveInteger("OPENAI_DAILY_REQUEST_LIMIT", environment.OPENAI_DAILY_REQUEST_LIMIT),
    weeklyRequests: parsePositiveInteger("OPENAI_WEEKLY_REQUEST_LIMIT", environment.OPENAI_WEEKLY_REQUEST_LIMIT),
    monthlyRequests: parsePositiveInteger("OPENAI_MONTHLY_REQUEST_LIMIT", environment.OPENAI_MONTHLY_REQUEST_LIMIT),
    dailyTokens: parsePositiveInteger("OPENAI_DAILY_TOKEN_LIMIT", environment.OPENAI_DAILY_TOKEN_LIMIT),
    weeklyTokens: parsePositiveInteger("OPENAI_WEEKLY_TOKEN_LIMIT", environment.OPENAI_WEEKLY_TOKEN_LIMIT),
    monthlyTokens: parsePositiveInteger("OPENAI_MONTHLY_TOKEN_LIMIT", environment.OPENAI_MONTHLY_TOKEN_LIMIT)
  };
}

function isSameDay(date: Date, comparison: Date): boolean {
  return date.getFullYear() === comparison.getFullYear() && date.getMonth() === comparison.getMonth() && date.getDate() === comparison.getDate();
}

function startOfWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function isSameWeek(date: Date, comparison: Date): boolean {
  return startOfWeek(date).getTime() === startOfWeek(comparison).getTime();
}

function isSameMonth(date: Date, comparison: Date): boolean {
  return date.getFullYear() === comparison.getFullYear() && date.getMonth() === comparison.getMonth();
}

function getRecordDate(record: OpenAIUsageRecord): Date {
  const date = new Date(record.timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error("OpenAI usage file contains an invalid request timestamp.");
  }

  return date;
}

export function getOpenAIUsageCounts(records: OpenAIUsageRecord[], now = new Date()): OpenAIUsageCounts {
  return records.reduce<OpenAIUsageCounts>(
    (counts, record) => {
      const recordDate = getRecordDate(record);
      const isToday = isSameDay(recordDate, now);
      const isThisWeek = isSameWeek(recordDate, now);
      const isThisMonth = isSameMonth(recordDate, now);

      if (isToday) {
        counts.dailyRequests += 1;
        counts.dailyTokens += record.totalTokens;
      }
      if (isThisWeek) {
        counts.weeklyRequests += 1;
        counts.weeklyTokens += record.totalTokens;
      }
      if (isThisMonth) {
        counts.monthlyRequests += 1;
        counts.monthlyTokens += record.totalTokens;
      }

      return counts;
    },
    { dailyRequests: 0, weeklyRequests: 0, monthlyRequests: 0, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 0 }
  );
}

export function getReachedOpenAILimit(
  counts: OpenAIUsageCounts,
  limits: OpenAIUsageLimits
): string | undefined {
  if (counts.dailyRequests >= limits.dailyRequests) return "daily request";
  if (counts.weeklyRequests >= limits.weeklyRequests) return "weekly request";
  if (counts.monthlyRequests >= limits.monthlyRequests) return "monthly request";
  if (counts.dailyTokens >= limits.dailyTokens) return "daily token";
  if (counts.weeklyTokens >= limits.weeklyTokens) return "weekly token";
  if (counts.monthlyTokens >= limits.monthlyTokens) return "monthly token";
  return undefined;
}

export async function checkOpenAIUsage(
  tracker: OpenAIUsageTracker,
  environment = process.env,
  now = new Date()
): Promise<OpenAIUsageCheck> {
  try {
    const limits = getOpenAIUsageLimits(environment);
    const usageData: OpenAIUsageData = await tracker.getUsageData();
    if (usageData.usageUnknown) {
      throw new Error("A previous OpenAI response did not include verifiable token usage.");
    }

    const counts = getOpenAIUsageCounts(usageData.records, now);
    const reachedLimit = getReachedOpenAILimit(counts, limits);
    if (reachedLimit) {
      console.warn(`[WARN] OpenAI ${reachedLimit} limit reached.`);
      console.warn("[WARN] OpenAI request blocked.");
      return { allowed: false };
    }

    console.info(`[INFO] OpenAI usage today: ${counts.dailyRequests}/${limits.dailyRequests} requests`);
    console.info(`[INFO] OpenAI tokens today: ${counts.dailyTokens}/${limits.dailyTokens}`);
    return { allowed: true, counts, limits };
  } catch (error) {
    if (error instanceof InvalidOpenAIUsageLimitError) {
      console.error(`[ERROR] OpenAI usage limit configuration is invalid: ${error.message}`);
    } else {
      console.error("[ERROR] Unable to verify OpenAI API usage.");
    }

    console.error("[ERROR] OpenAI request blocked for safety.");
    return { allowed: false };
  }
}
