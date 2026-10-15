import type { ApprovedGeminiModel } from "../config/geminiModels.js";

export interface GeminiUsageRecord {
  /** Present for database-backed records. Historical JSON records may not have an ID. */
  id?: number;
  timestamp: string;
  provider: "gemini";
  operation: string;
  requestCount: 1;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Missing/null identifies historical usage written before model attribution. */
  model?: string | null;
  /** Missing identifies historical JSON written before structured accounting. */
  accountingStatus?: GeminiAccountingStatus;
  ambiguityReason?: GeminiAmbiguityReason | null;
  /** Inclusive conservative end of the interval in which provider dispatch may have occurred. */
  accountingThrough?: string | null;
  settledAt?: string | null;
  retiredAt?: string | null;
}

export interface GeminiUsageData { records: GeminiUsageRecord[]; usageUnknown: boolean; }
export interface GeminiUsageReservation { id: string; record: GeminiUsageRecord & { model: ApprovedGeminiModel }; }
export interface GeminiUsageSettlement { inputTokens: number; outputTokens: number; totalTokens: number; }
export type GeminiAccountingStatus =
  | "legacy"
  | "reserved"
  | "exact"
  | "confirmed_zero"
  | "transport_ambiguous"
  | "retired_outside_accounting_windows";
export type GeminiAmbiguityReason =
  | "timeout"
  | "network_error"
  | "response_usage_unavailable"
  | "abandoned_reservation"
  | "settlement_uncertain";
export interface GeminiUsageAdmission {
  limits: {
    dailyRequests: number;
    weeklyRequests: number;
    monthlyRequests: number;
    dailyTokens: number;
    weeklyTokens: number;
    monthlyTokens: number;
  };
  cycleRequestsRemaining: number;
}
export interface GeminiAmbiguityRetirementExpectation {
  id: number;
  timestamp: string;
  model: ApprovedGeminiModel;
  ambiguityReason: GeminiAmbiguityReason;
}
export interface GeminiReservedReconciliationExpectation {
  id: number;
  timestamp: string;
  model: ApprovedGeminiModel;
  operation: string;
}
export type GeminiReservedReconciliationResult = "reconciled" | "already_reconciled";
export type GeminiAmbiguityRetirementResult = "retired" | "already_retired";
/** Persistence boundary for Gemini request and token-usage state. */
export interface GeminiUsageStore {
  getUsageData(): Promise<GeminiUsageData>;
  recordRequest(record: GeminiUsageRecord): Promise<void>;
  markUsageUnknown(): Promise<void>;
  reserveRequest(record: GeminiUsageRecord & { model: ApprovedGeminiModel }, admission: GeminiUsageAdmission): Promise<GeminiUsageReservation>;
  settleRequest(reservation: GeminiUsageReservation, usage: GeminiUsageSettlement): Promise<void>;
  confirmZeroRequest(reservation: GeminiUsageReservation): Promise<void>;
  markRequestAmbiguous(reservation: GeminiUsageReservation, reason: GeminiAmbiguityReason): Promise<void>;
  reconcileAbandonedReservation(expectation: GeminiReservedReconciliationExpectation): Promise<GeminiReservedReconciliationResult>;
  retireAmbiguousRequest(expectation: GeminiAmbiguityRetirementExpectation): Promise<GeminiAmbiguityRetirementResult>;
}

/** @deprecated Use GeminiUsageStore for new integrations. */
export type GeminiUsageTracker = GeminiUsageStore;

export function isGeminiUsageRecord(value: unknown): value is GeminiUsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const status = record.accountingStatus ?? "legacy";
  const reason = record.ambiguityReason ?? null;
  const accountingThrough = record.accountingThrough ?? null;
  const settledAt = record.settledAt ?? null;
  const retiredAt = record.retiredAt ?? null;
  const validStatus = ["legacy", "reserved", "exact", "confirmed_zero", "transport_ambiguous", "retired_outside_accounting_windows"].includes(String(status));
  const validReason = reason === null || ["timeout", "network_error", "response_usage_unavailable", "abandoned_reservation", "settlement_uncertain"].includes(String(reason));
  const zero = record.inputTokens === 0 && record.outputTokens === 0 && record.totalTokens === 0;
  const validState = status === "legacy" ? reason === null && settledAt === null && retiredAt === null
    : status === "reserved" ? zero && reason === null && typeof accountingThrough === "string" && settledAt === null && retiredAt === null
    : status === "exact" ? reason === null && typeof accountingThrough === "string" && accountingThrough === settledAt && retiredAt === null
    : status === "confirmed_zero" ? zero && reason === null && typeof accountingThrough === "string" && accountingThrough === settledAt && retiredAt === null
    : status === "transport_ambiguous" ? zero && typeof reason === "string" && typeof accountingThrough === "string" && settledAt === null && retiredAt === null
    : status === "retired_outside_accounting_windows" ? zero && typeof reason === "string" && typeof accountingThrough === "string" && settledAt === null && typeof retiredAt === "string"
    : false;
  return (record.id === undefined || (typeof record.id === "number" && Number.isSafeInteger(record.id) && record.id > 0)) &&
    typeof record.timestamp === "string" && record.provider === "gemini" && typeof record.operation === "string" && record.requestCount === 1 &&
    [record.inputTokens, record.outputTokens, record.totalTokens].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) &&
    (record.totalTokens as number) >= (record.inputTokens as number) + (record.outputTokens as number) &&
    (record.model === undefined || record.model === null || (typeof record.model === "string" && record.model.trim().length > 0)) &&
    validStatus && validReason && validState &&
    (accountingThrough === null || (!Number.isNaN(new Date(accountingThrough as string).getTime()) &&
      new Date(accountingThrough as string).getTime() >= new Date(record.timestamp as string).getTime())) &&
    (settledAt === null || !Number.isNaN(new Date(settledAt as string).getTime())) &&
    (retiredAt === null || !Number.isNaN(new Date(retiredAt as string).getTime()));
}

export function geminiAccountingStatusOf(record: GeminiUsageRecord): GeminiAccountingStatus {
  return record.accountingStatus ?? "legacy";
}
