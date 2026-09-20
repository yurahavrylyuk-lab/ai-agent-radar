export interface GeminiUsageRecord {
  timestamp: string;
  provider: "gemini";
  operation: string;
  requestCount: 1;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GeminiUsageData { records: GeminiUsageRecord[]; usageUnknown: boolean; }
/** Persistence boundary for Gemini request and token-usage state. */
export interface GeminiUsageStore {
  getUsageData(): Promise<GeminiUsageData>;
  recordRequest(record: GeminiUsageRecord): Promise<void>;
  markUsageUnknown(): Promise<void>;
}

/** @deprecated Use GeminiUsageStore for new integrations. */
export type GeminiUsageTracker = GeminiUsageStore;

export function isGeminiUsageRecord(value: unknown): value is GeminiUsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.timestamp === "string" && record.provider === "gemini" && typeof record.operation === "string" && record.requestCount === 1 &&
    [record.inputTokens, record.outputTokens, record.totalTokens].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) &&
    (record.totalTokens as number) >= (record.inputTokens as number) + (record.outputTokens as number);
}
