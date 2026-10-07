import type { ApprovedGeminiModel } from "../config/geminiModels.js";

export interface GeminiUsageRecord {
  timestamp: string;
  provider: "gemini";
  operation: string;
  requestCount: 1;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Missing/null identifies historical usage written before model attribution. */
  model?: string | null;
}

export interface GeminiUsageData { records: GeminiUsageRecord[]; usageUnknown: boolean; }
export interface GeminiUsageReservation { id: string; record: GeminiUsageRecord & { model: ApprovedGeminiModel }; }
export interface GeminiUsageSettlement { inputTokens: number; outputTokens: number; totalTokens: number; }
/** Persistence boundary for Gemini request and token-usage state. */
export interface GeminiUsageStore {
  getUsageData(): Promise<GeminiUsageData>;
  recordRequest(record: GeminiUsageRecord): Promise<void>;
  markUsageUnknown(): Promise<void>;
  reserveRequest(record: GeminiUsageRecord & { model: ApprovedGeminiModel }): Promise<GeminiUsageReservation>;
  settleRequest(reservation: GeminiUsageReservation, usage: GeminiUsageSettlement): Promise<void>;
}

/** @deprecated Use GeminiUsageStore for new integrations. */
export type GeminiUsageTracker = GeminiUsageStore;

export function isGeminiUsageRecord(value: unknown): value is GeminiUsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.timestamp === "string" && record.provider === "gemini" && typeof record.operation === "string" && record.requestCount === 1 &&
    [record.inputTokens, record.outputTokens, record.totalTokens].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) &&
    (record.totalTokens as number) >= (record.inputTokens as number) + (record.outputTokens as number) &&
    (record.model === undefined || record.model === null || (typeof record.model === "string" && record.model.trim().length > 0));
}
