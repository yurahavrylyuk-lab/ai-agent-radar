import type { ApprovedGeminiModel } from "../config/geminiModels.js";
import { getGeminiAccountingIntervalRetirementTime, isGeminiAccountingIntervalInAnyActiveWindow, isGeminiTimestampInAnyActiveWindow } from "./geminiAccountingWindows.js";
import {
  geminiAccountingStatusOf,
  type GeminiAmbiguityReason,
  type GeminiAmbiguityRetirementResult,
  type GeminiReservedReconciliationResult,
  type GeminiUsageData,
  type GeminiUsageRecord,
  type GeminiUsageStore,
} from "./geminiUsageTracker.js";

export const LEGACY_ROW17_DATABASE_ID = "9fb545e2-2f43-4922-8b21-2d79a8de9556";
export const LEGACY_ROW17_SAFE_RETIREMENT_AT = "2026-11-01T00:00:00.000Z";
export const LEGACY_ROW17_EXPECTATION = Object.freeze({
  id: 17,
  timestamp: "2026-10-08T08:02:03.393Z",
  provider: "gemini" as const,
  operation: "analysis",
  requestCount: 1 as const,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  model: "gemini-3.8-flash" as ApprovedGeminiModel,
});

export interface StructuredAmbiguityExpectation {
  id: number;
  timestamp: string;
  model: ApprovedGeminiModel;
  ambiguityReason: GeminiAmbiguityReason;
}

export interface StrandedReservationExpectation {
  id: number;
  timestamp: string;
  model: ApprovedGeminiModel;
  operation: string;
}

export interface LegacyRow17RecoveryEvidence {
  databaseId: string;
  originalInvocationTerminated: boolean;
  now: Date;
}

function exactStructuredRecord(records: GeminiUsageRecord[], expectation: StructuredAmbiguityExpectation): GeminiUsageRecord {
  const matches = records.filter((record) => record.id === expectation.id);
  if (matches.length !== 1) throw new Error("Gemini ambiguity identity does not match exactly one record.");
  const record = matches[0]!;
  if (record.timestamp !== expectation.timestamp || record.model !== expectation.model ||
    record.ambiguityReason !== expectation.ambiguityReason || record.inputTokens !== 0 ||
    record.outputTokens !== 0 || record.totalTokens !== 0) {
    throw new Error("Gemini ambiguity retirement identity does not match durable accounting.");
  }
  return record;
}

/** Operator-only transition. It has no provider or monitoring capability. */
export async function retireStructuredGeminiAmbiguity(
  store: GeminiUsageStore,
  expectation: StructuredAmbiguityExpectation,
  trustedNow: Date,
  originalInvocationTerminated: boolean,
): Promise<GeminiAmbiguityRetirementResult> {
  if (!originalInvocationTerminated) {
    throw new Error("Gemini ambiguity retirement requires proof that the original invocation cannot dispatch.");
  }
  const data = await store.getUsageData();
  if (data.usageUnknown) throw new Error("Gemini legacy usage uncertainty blocks structured retirement.");
  const record = exactStructuredRecord(data.records, expectation);
  const status = geminiAccountingStatusOf(record);
  if (status !== "transport_ambiguous" && status !== "retired_outside_accounting_windows") {
    throw new Error("Gemini ambiguity is not in a retireable accounting state.");
  }
  if (isGeminiAccountingIntervalInAnyActiveWindow(record.timestamp, record.accountingThrough, trustedNow)) {
    throw new Error(`Gemini ambiguity remains active until ${getGeminiAccountingIntervalRetirementTime(record.timestamp, record.accountingThrough).toISOString()}.`);
  }
  return store.retireAmbiguousRequest(expectation);
}

/** Operator-only reconciliation of a stranded pre-dispatch/in-flight reservation. */
export async function reconcileStrandedGeminiReservation(
  store: GeminiUsageStore,
  expectation: StrandedReservationExpectation,
  trustedNow: Date,
  originalInvocationTerminated: boolean,
): Promise<GeminiReservedReconciliationResult> {
  if (!originalInvocationTerminated) {
    throw new Error("Gemini reserved reconciliation requires proof that the original invocation cannot dispatch.");
  }
  if (Number.isNaN(trustedNow.getTime())) throw new Error("Gemini reserved reconciliation requires trusted current time.");
  const data = await store.getUsageData();
  if (data.usageUnknown) throw new Error("Gemini legacy usage uncertainty blocks structured reconciliation.");
  const unresolved = data.records.filter((record) =>
    ["reserved", "transport_ambiguous"].includes(geminiAccountingStatusOf(record)));
  if (unresolved.length !== 1) throw new Error("Gemini reserved reconciliation requires exactly one unresolved record.");
  const record = unresolved[0]!;
  const exactIdentity = record.id === expectation.id && record.timestamp === expectation.timestamp &&
    record.provider === "gemini" && record.operation === expectation.operation && record.requestCount === 1 &&
    record.model === expectation.model && record.inputTokens === 0 && record.outputTokens === 0 && record.totalTokens === 0;
  const recognized = record.accountingStatus === "transport_ambiguous" && record.ambiguityReason === "abandoned_reservation";
  if (!exactIdentity || (record.accountingStatus !== "reserved" && !recognized)) {
    throw new Error("Gemini reserved reconciliation identity does not match durable accounting.");
  }
  if (new Date(record.timestamp).getTime() > trustedNow.getTime()) {
    throw new Error("Gemini reserved reconciliation time precedes the reservation.");
  }
  return store.reconcileAbandonedReservation(expectation);
}

/** Pure validation used by the separately authorized legacy incident runbook. */
export function validateLegacyRow17Recovery(
  data: GeminiUsageData,
  evidence: LegacyRow17RecoveryEvidence,
): void {
  if (evidence.databaseId !== LEGACY_ROW17_DATABASE_ID) throw new Error("Legacy recovery database identity does not match production.");
  if (!evidence.originalInvocationTerminated) throw new Error("Legacy recovery requires proof that the original invocation cannot dispatch.");
  if (!data.usageUnknown) throw new Error("Legacy Gemini usage latch is not set.");
  if (evidence.now.getTime() < new Date(LEGACY_ROW17_SAFE_RETIREMENT_AT).getTime()) {
    throw new Error(`Legacy row 17 remains active until ${LEGACY_ROW17_SAFE_RETIREMENT_AT}.`);
  }
  const row = data.records.find((record) => record.id === LEGACY_ROW17_EXPECTATION.id);
  if (!row || row.timestamp !== LEGACY_ROW17_EXPECTATION.timestamp || row.provider !== LEGACY_ROW17_EXPECTATION.provider ||
    row.operation !== LEGACY_ROW17_EXPECTATION.operation || row.requestCount !== LEGACY_ROW17_EXPECTATION.requestCount ||
    row.inputTokens !== 0 || row.outputTokens !== 0 || row.totalTokens !== 0 ||
    row.model !== LEGACY_ROW17_EXPECTATION.model || geminiAccountingStatusOf(row) !== "legacy") {
    throw new Error("Legacy row 17 does not match the approved incident identity.");
  }
  if (isGeminiTimestampInAnyActiveWindow(row.timestamp, evidence.now)) {
    throw new Error("Legacy row 17 remains inside an active accounting window.");
  }
  if (data.records.some((record) => (record.id ?? 0) > LEGACY_ROW17_EXPECTATION.id ||
    ["reserved", "transport_ambiguous"].includes(geminiAccountingStatusOf(record)))) {
    throw new Error("Unexpected newer or unresolved Gemini accounting state blocks legacy recovery.");
  }
}

/** Testable representation of the only authorized eventual mutation: latch 1 -> 0. */
export function simulateLegacyRow17LatchClear(
  data: GeminiUsageData,
  evidence: LegacyRow17RecoveryEvidence,
): GeminiUsageData {
  validateLegacyRow17Recovery(data, evidence);
  return { records: data.records.map((record) => ({ ...record })), usageUnknown: false };
}
