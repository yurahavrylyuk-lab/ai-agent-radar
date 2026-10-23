import type { ApprovedGeminiModel } from "../config/geminiModels.js";
import type { BraveDiscoverySourceHealth, GeminiFailureClass, RssDiscoverySourceHealth } from "../types/index.js";
import type { GeminiAmbiguityReason, GeminiUsageReservation, GeminiUsageSettlement } from "./geminiUsageTracker.js";

export type AttemptRef = { cycleId: string; ordinal: 1 | 2 | 3 };
export interface CycleStart { cycleId: string; scheduledAt: string; startedAt: string; sourceSha: string | null; workerVersion: string | null; }
export type CyclePhase = "started" | "sources_complete" | "gemini_complete" | "email_attempting" | "completed";
export type RetryDecision = "not_evaluated" | "retry" | "stop";
export type RetryReason = "none" | "retryable_503" | "non_retryable" | "max_attempts" | "deadline" | "quota" | "accounting" | "telemetry" | "cancelled";

export interface CycleDeliverySnapshot {
  deliveryMode: "normal" | "degraded" | "status_only";
  deliveryReason: "selected" | "no_eligible_stories" | "ai_unavailable" | "ai_no_selections" | "discovery_unavailable" | "history_unavailable" | "preparation_unavailable" | "persistence_unavailable";
  analyzedStories: number; rawStories: number; replayStories: number; emailAttempts: 0 | 1;
  emailOutcome: "accepted" | "failed" | "unknown" | "not_attempted";
  historyOutcome: "not_required" | "recorded" | "unavailable" | "persistence_failed";
  finalizationReached: boolean;
}
export interface CycleSnapshotV1 {
  version: 1;
  braveHealth: BraveDiscoverySourceHealth | null;
  rssHealth: RssDiscoverySourceHealth | null;
  outage: boolean | null;
  candidateCounts: { received: number | null; unique: number | null; submitted: number | null };
  geminiDispatchCount: number | null;
  delivery: CycleDeliverySnapshot | null;
  accounting: { reserved: number; exact: number; confirmedZero: number; ambiguous: number; unavailable: boolean };
}
export interface AttemptEvidence { failureClass: GeminiFailureClass; httpStatus: number | null; accountingError: boolean; observedAt: string; }
export type AttemptSettlement =
  | { kind: "exact"; usage: GeminiUsageSettlement; evidence: AttemptEvidence }
  | { kind: "confirmed_zero"; evidence: AttemptEvidence }
  | { kind: "transport_ambiguous"; reason: GeminiAmbiguityReason; evidence: AttemptEvidence };
export interface PersistedAttempt {
  cycleId: string; ordinal: 1 | 2 | 3; usageId: number; model: ApprovedGeminiModel;
  startedAt: string; updatedAt: string; endedAt: string | null;
  dispatchStatus: "not_dispatched" | "intent" | "observed";
  failureClass: GeminiFailureClass; httpStatus: number | null; accountingStatus: "reserved" | "exact" | "confirmed_zero" | "transport_ambiguous" | "unresolved";
  accountingError: boolean; settlementStatus: "pending" | "settled" | "unresolved";
  retryDecision: RetryDecision; retryReason: RetryReason;
}
export interface MonitoringTelemetry {
  createCycle(start: CycleStart): Promise<void>;
  checkpoint(cycleId: string, phase: CyclePhase, snapshot: CycleSnapshotV1): Promise<void>;
  bindAttempt(ref: AttemptRef, reservation: GeminiUsageReservation): Promise<void>;
  markDispatchIntent(ref: AttemptRef): Promise<void>;
  markDispatchObserved(ref: AttemptRef): Promise<void>;
  recordEvidence(ref: AttemptRef, evidence: AttemptEvidence): Promise<void>;
  recordRetryDecision(ref: AttemptRef, decision: RetryDecision, reason: RetryReason): Promise<void>;
  completeCycle(cycleId: string, snapshot: CycleSnapshotV1): Promise<void>;
  readCycle(cycleId: string): Promise<{ cycle: CycleStart; phase: CyclePhase; snapshot: CycleSnapshotV1; attempts: PersistedAttempt[] } | null>;
}

const encoder = new TextEncoder();
const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown, max: number, nullable = false): boolean => (nullable && value === null) || (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max);
const member = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && values.includes(value as T);

export function validateCycleStart(value: unknown): CycleStart {
  if (!isObject(value) || !exactKeys(value, ["cycleId", "scheduledAt", "startedAt", "sourceSha", "workerVersion"]) ||
    typeof value.cycleId !== "string" || !uuid.test(value.cycleId) || typeof value.scheduledAt !== "string" || !isoUtc.test(value.scheduledAt) ||
    typeof value.startedAt !== "string" || !isoUtc.test(value.startedAt) || value.startedAt < value.scheduledAt ||
    !(value.sourceSha === null || (typeof value.sourceSha === "string" && /^[0-9a-f]{40}$/.test(value.sourceSha))) ||
    !(value.workerVersion === null || (typeof value.workerVersion === "string" && uuid.test(value.workerVersion)))) {
    throw new Error("Monitoring cycle start is invalid.");
  }
  return value as unknown as CycleStart;
}

function validDelivery(value: unknown): value is CycleDeliverySnapshot {
  if (!isObject(value) || !exactKeys(value, ["deliveryMode", "deliveryReason", "analyzedStories", "rawStories", "replayStories", "emailAttempts", "emailOutcome", "historyOutcome", "finalizationReached"])) return false;
  return member(value.deliveryMode, ["normal", "degraded", "status_only"]) &&
    member(value.deliveryReason, ["selected", "no_eligible_stories", "ai_unavailable", "ai_no_selections", "discovery_unavailable", "history_unavailable", "preparation_unavailable", "persistence_unavailable"]) &&
    count(value.analyzedStories, 4) && count(value.rawStories, 4) && count(value.replayStories, 4) && count(value.emailAttempts, 1) &&
    member(value.emailOutcome, ["accepted", "failed", "unknown", "not_attempted"]) &&
    member(value.historyOutcome, ["not_required", "recorded", "unavailable", "persistence_failed"]) && typeof value.finalizationReached === "boolean";
}

export function validateCycleSnapshot(value: unknown): CycleSnapshotV1 {
  if (!isObject(value) || !exactKeys(value, ["version", "braveHealth", "rssHealth", "outage", "candidateCounts", "geminiDispatchCount", "delivery", "accounting"]) || value.version !== 1 ||
    !(value.braveHealth === null || member(value.braveHealth, ["healthy", "degraded", "unavailable", "quota_blocked"])) ||
    !(value.rssHealth === null || member(value.rssHealth, ["healthy", "degraded", "unavailable"])) ||
    !(value.outage === null || typeof value.outage === "boolean") || !isObject(value.candidateCounts) ||
    !exactKeys(value.candidateCounts, ["received", "unique", "submitted"]) || !count(value.candidateCounts.received, 100_000, true) ||
    !count(value.candidateCounts.unique, 100_000, true) || !count(value.candidateCounts.submitted, 50, true) ||
    !count(value.geminiDispatchCount, 3, true) || !(value.delivery === null || validDelivery(value.delivery)) ||
    !isObject(value.accounting) || !exactKeys(value.accounting, ["reserved", "exact", "confirmedZero", "ambiguous", "unavailable"]) ||
    !count(value.accounting.reserved, 3) || !count(value.accounting.exact, 3) || !count(value.accounting.confirmedZero, 3) ||
    !count(value.accounting.ambiguous, 3) || typeof value.accounting.unavailable !== "boolean") {
    throw new Error("Monitoring cycle snapshot is invalid.");
  }
  const encoded = JSON.stringify(value);
  if (encoder.encode(encoded).byteLength > 8192) throw new Error("Monitoring cycle snapshot exceeds its byte limit.");
  return value as unknown as CycleSnapshotV1;
}

export function serializeCycleSnapshot(value: CycleSnapshotV1): string { return JSON.stringify(validateCycleSnapshot(value)); }
export function parseCycleSnapshot(value: string): CycleSnapshotV1 {
  if (encoder.encode(value).byteLength > 8192) throw new Error("Monitoring cycle snapshot exceeds its byte limit.");
  try { return validateCycleSnapshot(JSON.parse(value) as unknown); }
  catch { throw new Error("Monitoring cycle snapshot is invalid."); }
}
