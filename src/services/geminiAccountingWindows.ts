export interface GeminiUtcAccountingWindows {
  now: number;
  dayStart: number;
  weekStart: number;
  monthStart: number;
  nextDayStart: number;
  nextWeekStart: number;
  nextMonthStart: number;
}

function validInstant(value: Date, label: string): number {
  const instant = value.getTime();
  if (!Number.isFinite(instant)) throw new Error(`${label} is invalid.`);
  return instant;
}

export function getGeminiUtcAccountingWindows(now = new Date()): GeminiUtcAccountingWindows {
  const instant = validInstant(now, "Gemini accounting time");
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const mondayOffset = (now.getUTCDay() + 6) % 7;
  const weekStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - mondayOffset);
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return {
    now: instant,
    dayStart,
    weekStart,
    monthStart,
    nextDayStart: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    nextWeekStart: weekStart + 7 * 24 * 60 * 60 * 1_000,
    nextMonthStart: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  };
}

export function parseGeminiUsageTimestamp(timestamp: string): number {
  const instant = new Date(timestamp).getTime();
  if (!Number.isFinite(instant)) throw new Error("Gemini usage contains an invalid request timestamp.");
  return instant;
}

export function isGeminiTimestampInAnyActiveWindow(timestamp: string, now = new Date()): boolean {
  const requestInstant = parseGeminiUsageTimestamp(timestamp);
  const windows = getGeminiUtcAccountingWindows(now);
  if (requestInstant > windows.now) throw new Error("Gemini usage contains a future request timestamp.");
  return requestInstant >= windows.dayStart || requestInstant >= windows.weekStart || requestInstant >= windows.monthStart;
}

export function getGeminiAmbiguityRetirementTime(timestamp: string): Date {
  const request = new Date(parseGeminiUsageTimestamp(timestamp));
  const windows = getGeminiUtcAccountingWindows(request);
  return new Date(Math.max(windows.nextDayStart, windows.nextWeekStart, windows.nextMonthStart));
}

export function areGeminiTimestampsInSameUtcWindows(left: string, right = new Date()): boolean {
  const leftInstant = parseGeminiUsageTimestamp(left);
  const windows = getGeminiUtcAccountingWindows(right);
  return leftInstant <= windows.now && leftInstant >= windows.dayStart && leftInstant < windows.nextDayStart &&
    leftInstant >= windows.weekStart && leftInstant < windows.nextWeekStart &&
    leftInstant >= windows.monthStart && leftInstant < windows.nextMonthStart;
}
