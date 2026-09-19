import type { UsageRecord, UsageTracker } from "./usageTracker.js";

export interface BraveUsageLimits {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BraveUsageCounts {
  daily: number;
  weekly: number;
  monthly: number;
}

export type UsageCheck =
  | { allowed: true; counts: BraveUsageCounts; limits: BraveUsageLimits }
  | { allowed: false };

export class InvalidUsageLimitConfigurationError extends Error {}

function parsePositiveInteger(name: string, value: string | undefined): number {
  if (!value || !/^\d+$/.test(value.trim())) {
    throw new InvalidUsageLimitConfigurationError(`${name} must be a positive integer.`);
  }

  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new InvalidUsageLimitConfigurationError(`${name} must be a positive integer.`);
  }

  return parsedValue;
}

export function getBraveUsageLimits(environment = process.env): BraveUsageLimits {
  return {
    daily: parsePositiveInteger("BRAVE_DAILY_SEARCH_LIMIT", environment.BRAVE_DAILY_SEARCH_LIMIT),
    weekly: parsePositiveInteger("BRAVE_WEEKLY_SEARCH_LIMIT", environment.BRAVE_WEEKLY_SEARCH_LIMIT),
    monthly: parsePositiveInteger(
      "BRAVE_MONTHLY_SEARCH_LIMIT",
      environment.BRAVE_MONTHLY_SEARCH_LIMIT
    )
  };
}

function isSameDay(date: Date, comparison: Date): boolean {
  return (
    date.getFullYear() === comparison.getFullYear() &&
    date.getMonth() === comparison.getMonth() &&
    date.getDate() === comparison.getDate()
  );
}

function startOfWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const daysSinceMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  return start;
}

function isSameWeek(date: Date, comparison: Date): boolean {
  return startOfWeek(date).getTime() === startOfWeek(comparison).getTime();
}

function isSameMonth(date: Date, comparison: Date): boolean {
  return date.getFullYear() === comparison.getFullYear() && date.getMonth() === comparison.getMonth();
}

function getRecordDate(record: UsageRecord): Date | undefined {
  const date = new Date(record.timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function getBraveUsageCounts(records: UsageRecord[], now = new Date()): BraveUsageCounts {
  return records.reduce<BraveUsageCounts>(
    (counts, record) => {
      if (record.provider !== "brave" || record.operation !== "web-search") {
        return counts;
      }

      const recordDate = getRecordDate(record);
      if (!recordDate) {
        throw new Error("Usage file contains an invalid request timestamp.");
      }

      if (isSameDay(recordDate, now)) {
        counts.daily += record.requestCount;
      }
      if (isSameWeek(recordDate, now)) {
        counts.weekly += record.requestCount;
      }
      if (isSameMonth(recordDate, now)) {
        counts.monthly += record.requestCount;
      }

      return counts;
    },
    { daily: 0, weekly: 0, monthly: 0 }
  );
}

export function evaluateBraveUsage(
  counts: BraveUsageCounts,
  limits: BraveUsageLimits
): "daily" | "weekly" | "monthly" | undefined {
  if (counts.daily >= limits.daily) {
    return "daily";
  }
  if (counts.weekly >= limits.weekly) {
    return "weekly";
  }
  if (counts.monthly >= limits.monthly) {
    return "monthly";
  }

  return undefined;
}

export async function checkBraveSearchUsage(
  tracker: UsageTracker,
  environment = process.env,
  now = new Date()
): Promise<UsageCheck> {
  try {
    const limits = getBraveUsageLimits(environment);
    const counts = getBraveUsageCounts(await tracker.getRecords(), now);
    const reachedPeriod = evaluateBraveUsage(counts, limits);

    if (reachedPeriod) {
      console.warn(`[WARN] Brave ${reachedPeriod} API limit reached.`);
      console.warn("[WARN] Search request blocked.");
      return { allowed: false };
    }

    console.info(`[INFO] Brave usage today: ${counts.daily}/${limits.daily}`);
    console.info(`[INFO] Brave usage this week: ${counts.weekly}/${limits.weekly}`);
    console.info(`[INFO] Brave usage this month: ${counts.monthly}/${limits.monthly}`);
    return { allowed: true, counts, limits };
  } catch (error) {
    if (error instanceof InvalidUsageLimitConfigurationError) {
      console.error(`[ERROR] Brave usage limit configuration is invalid: ${error.message}`);
    } else {
      console.error("[ERROR] Unable to verify Brave API usage.");
    }

    console.error("[ERROR] Search request blocked for safety.");
    return { allowed: false };
  }
}
