export interface OpenAIFallbackLimits {
  dailyRequests: number;
  weeklyRequests: number;
  monthlyRequests: number;
  dailyTokens: number;
  weeklyTokens: number;
  monthlyTokens: number;
}

export const OPENAI_FALLBACK = Object.freeze({
  model: "gpt-6-luna" as const,
  reasoning: "low" as const,
  maxOutputTokens: 12_288,
  inputBudget: 12_288,
  outputBudget: 12_288,
  reservationTokens: 24_576,
  timeoutMs: 15_000,
  admissionMs: 30_000,
  responseBodyBytes: 131_072,
});

const CEILINGS: OpenAIFallbackLimits = {
  dailyRequests: 1,
  weeklyRequests: 7,
  monthlyRequests: 31,
  dailyTokens: 24_576,
  weeklyTokens: 172_032,
  monthlyTokens: 761_856,
};

const entries = [
  ["OPENAI_DAILY_REQUEST_LIMIT", "dailyRequests"],
  ["OPENAI_WEEKLY_REQUEST_LIMIT", "weeklyRequests"],
  ["OPENAI_MONTHLY_REQUEST_LIMIT", "monthlyRequests"],
  ["OPENAI_DAILY_TOKEN_LIMIT", "dailyTokens"],
  ["OPENAI_WEEKLY_TOKEN_LIMIT", "weeklyTokens"],
  ["OPENAI_MONTHLY_TOKEN_LIMIT", "monthlyTokens"],
] as const;

export function parseOpenAIFallbackLimits(environment: Record<string, string | undefined>): OpenAIFallbackLimits | null {
  const parsed = {} as OpenAIFallbackLimits;
  for (const [variable, field] of entries) {
    const raw = environment[variable];
    if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > CEILINGS[field]) return null;
    parsed[field] = value;
  }
  return parsed;
}
