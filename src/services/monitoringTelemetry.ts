import type { ApprovedGeminiModel } from "../config/geminiModels.js";
import { rssStructuralSubreasons, type BraveDiscoverySourceHealth, type DeliveryLedgerObservation, type DiscoverySourceSuccessCounts, type GeminiFailureClass, type RssCycleMetrics, type RssDiscoverySourceHealth, type RssStructuralSubreason, type ThreadsCycleMetrics } from "../types/index.js";
import type { GeminiAmbiguityReason, GeminiUsageReservation, GeminiUsageSettlement } from "./geminiUsageTracker.js";

export type AttemptRef = { cycleId: string; ordinal: 1 | 2 | 3 };
export interface CycleStart { cycleId: string; scheduledAt: string; startedAt: string; sourceSha: string | null; workerVersion: string | null; }
export type CyclePhase = "started" | "sources_complete" | "gemini_complete" | "email_attempting" | "completed";
export type RetryDecision = "not_evaluated" | "retry" | "stop";
export type RetryReason = "none" | "retryable_503" | "non_retryable" | "max_attempts" | "deadline" | "quota" | "accounting" | "telemetry" | "cancelled";

/** Availability is proven only by at least one valid provider response, not by content volume. */
export function isTotalDiscoveryOutage(successes: DiscoverySourceSuccessCounts, threadsEnabled: boolean): boolean {
  return successes.brave === 0 && successes.rss === 0 && (!threadsEnabled || successes.threads === 0);
}

export interface CycleDeliverySnapshot {
  deliveryMode: "normal" | "degraded" | "status_only";
  deliveryReason: "selected" | "no_eligible_stories" | "ai_unavailable" | "ai_no_selections" | "discovery_unavailable" | "history_unavailable" | "preparation_unavailable" | "persistence_unavailable";
  analyzedStories: number; rawStories: number; replayStories: number; emailAttempts: 0 | 1;
  emailOutcome: "accepted" | "failed" | "unknown" | "not_attempted";
  historyOutcome: "not_required" | "recorded" | "unavailable" | "persistence_failed";
  finalizationReached: boolean;
  deliveryLedger?: DeliveryLedgerObservation;
}
export interface GeminiAttemptTiming {
  ordinal: 1 | 2 | 3;
  requestStartedAt: string | null;
  elapsedMs: number | null;
}
export interface CycleLatencyV1 {
  version: 1;
  preFilterInputCount: number | null;
  selectedCount: number | null;
  selectorExcluded: number | null;
  byteExcluded: number | null;
  submittedCount: number | null;
  promptBytes: number | null;
  snippetBytesLimit: 192 | 128 | 96 | 0 | null;
  thinkingMode: "low" | null;
  executionMode: "synchronous" | null;
  attemptTimings: GeminiAttemptTiming[];
}
export type AnalyzerFailoverEligibilityReason = "eligible" | "gemini_not_exhausted" | "configuration" | "timing" | "accounting" | "consumed";
export type AnalyzerFailoverOutcome = "not_attempted" | "success" | "timeout" | "transport_error" | "http_failure" | "invalid_response" | "usage_unknown" | "accounting_failure";
export interface AnalyzerFailoverObservation {
  version: 1; provider: "openai"; model: "gpt-6-luna";
  eligible: boolean; eligibilityReason: AnalyzerFailoverEligibilityReason;
  attempted: boolean; dispatchCount: 0 | 1;
  startedAt: string | null; endedAt: string | null; durationMs: number | null;
  outcome: AnalyzerFailoverOutcome; httpStatus: number | null;
  usage: { inputTokens:number; outputTokens:number; totalTokens:number } | null;
  accountingState: "none" | "reserved" | "exact" | "unknown" | "cancelled_pre_dispatch";
  finalAnalyzer: "gemini" | "openai" | "none";
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
  latency?: CycleLatencyV1;
  analyzerFailover?: AnalyzerFailoverObservation;
  threads?: ThreadsCycleMetrics;
  rssDiagnostics?: RssDiagnosticsV1;
}

export type RssDiagnosticFeedId = "openai_news" | "github_changelog" | "cloudflare_ai" | "chrome_developers";
export type RssDiagnosticReason = "disabled" | "configuration" | "http" | "redirect" | "timeout" | "body_limit" | "encoding" | "parse" | "structure" | "ok";
export type RssDiagnosticsV1 = {
  version: 1; status: "recorded"; collectionStatus: "disabled" | "configuration" | "collected";
  health: RssDiscoverySourceHealth; configuredFeeds: number; attemptedFeeds: number; succeededFeeds: number; failedFeeds: number;
  outcomes: Array<{ feedId: RssDiagnosticFeedId; reason: RssDiagnosticReason; httpStatus?: number; subreason?: RssStructuralSubreason; elapsedMs: number }>;
} | { version: 1; status: "unavailable"; reason: "invalid_metrics" | "snapshot_budget" };

const threadQueryIds = ["ai_agents", "claude_code", "codex"] as const;
const threadReasons = ["ok", "disabled", "configuration", "expired", "public_permission_unapproved", "auth", "permission_or_policy", "rate_limit", "redirect", "http", "transport", "timeout", "body_limit", "malformed", "api_error", "budget", "skipped"] as const;

export function validateThreadsCycleMetrics(value: unknown): ThreadsCycleMetrics {
  const baseKeys = ["enabled", "configured", "publicApprovalAttested", "health", "reason", "authentication", "rotationDue", "attemptedQueries", "succeededQueries", "failedQueries", "skippedQueries", "observedPositions", "validObservations", "rejectedPositions", "outcomes"];
  if (!isObject(value) || !exactKeys(value, [...baseKeys, ...(Object.hasOwn(value, "pipeline") ? ["pipeline"] : [])]) ||
    typeof value.enabled !== "boolean" || typeof value.configured !== "boolean" || typeof value.publicApprovalAttested !== "boolean" ||
    !member(value.health, ["healthy", "degraded", "unavailable", "disabled"]) || !member(value.reason, threadReasons) ||
    !member(value.authentication, ["unknown", "accepted", "rejected"]) || typeof value.rotationDue !== "boolean" ||
    !count(value.attemptedQueries, 3) || !count(value.succeededQueries, 3) || !count(value.failedQueries, 3) || !count(value.skippedQueries, 3) ||
    !count(value.observedPositions, 15) || !count(value.validObservations, 15) || !count(value.rejectedPositions, 15) ||
    !Array.isArray(value.outcomes) || value.outcomes.length > 3) throw new Error("Threads cycle metrics are invalid.");
  const seen = new Set<string>();
  for (const outcome of value.outcomes) {
    if (!isObject(outcome) || !exactKeys(outcome, ["queryId", "reason", "httpStatus", "elapsedMs", "observedPositions", "itemTruncated", "pagingIgnored", "bodyTruncated"]) ||
      !member(outcome.queryId, threadQueryIds) || seen.has(outcome.queryId as string) || !member(outcome.reason, threadReasons) ||
      !(outcome.httpStatus === null || (Number.isInteger(outcome.httpStatus) && Number(outcome.httpStatus) >= 100 && Number(outcome.httpStatus) <= 599)) ||
      !count(outcome.elapsedMs, 9000) || !count(outcome.observedPositions, 5) || typeof outcome.itemTruncated !== "boolean" ||
      typeof outcome.pagingIgnored !== "boolean" || typeof outcome.bodyTruncated !== "boolean") throw new Error("Threads cycle metrics are invalid.");
    seen.add(outcome.queryId as string);
  }
  if (Object.hasOwn(value, "pipeline")) {
    const pipeline = value.pipeline;
    if (!isObject(pipeline) || !exactKeys(pipeline, ["duplicates", "retainedOwned", "retainedAttributed", "submitted", "selected", "delivered"]) ||
      !count(pipeline.duplicates, 15) || !count(pipeline.retainedOwned, 15) || !count(pipeline.retainedAttributed, 50) ||
      !count(pipeline.submitted, 24, true) || !count(pipeline.selected, 4, true) || !count(pipeline.delivered, 4, true)) throw new Error("Threads cycle metrics are invalid.");
  }
  if (encoder.encode(JSON.stringify(value)).byteLength > 1536) throw new Error("Threads cycle metrics exceed their byte limit.");
  return value as unknown as ThreadsCycleMetrics;
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
const rssFeedIds = ["openai_news", "github_changelog", "cloudflare_ai", "chrome_developers"] as const;
const rssReasons = ["disabled", "configuration", "http", "redirect", "timeout", "body_limit", "encoding", "parse", "structure", "ok"] as const;
const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown, max: number, nullable = false): boolean => (nullable && value === null) || (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max);
const member = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && values.includes(value as T);
const validUtcInstant = (value: string): boolean => {
  if (!isoUtc.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};

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

export function validateDeliveryLedgerObservation(value: unknown): DeliveryLedgerObservation {
  const keys = ["version", "key", "action", "state", "reason", "knownDispatchCount", "uncertainSlotCount", "reconciliation", "replayEvidence"];
  if (!isObject(value) || !exactKeys(value, keys) || value.version !== 1 ||
    typeof value.key !== "string" || !/^daily-digest\/\d{4}-\d{2}-\d{2}$/.test(value.key) ||
    !member(value.action, ["first", "recovery", "already_accepted", "in_progress", "blocked"]) ||
    !(value.state === null || member(value.state, ["prepared", "attempting", "ambiguous", "accepted", "confirmed_failed"])) ||
    !member(value.reason, ["prepared", "claimed", "dispatch_admitted", "cancelled_before_dispatch", "provider_accepted", "provider_rejected", "provider_ambiguous", "payload_conflict", "already_accepted", "in_progress", "recovery_required", "ledger_unavailable", "configuration_payload_mismatch", "history_pending", "history_reconciled", "integrity_hold"]) ||
    !count(value.knownDispatchCount, 3) || !count(value.uncertainSlotCount, 3) ||
    Number(value.knownDispatchCount) + Number(value.uncertainSlotCount) > 3 ||
    !member(value.reconciliation, ["not_required", "pending", "complete", "failed"]) ||
    !member(value.replayEvidence, ["same_key_requested", "unknown"])) {
    throw new Error("Monitoring delivery ledger observation is invalid.");
  }
  if (encoder.encode(JSON.stringify(value)).byteLength > 1024) throw new Error("Monitoring delivery ledger observation exceeds its byte limit.");
  return value as unknown as DeliveryLedgerObservation;
}

function validDelivery(value: unknown): value is CycleDeliverySnapshot {
  const keys = ["deliveryMode", "deliveryReason", "analyzedStories", "rawStories", "replayStories", "emailAttempts", "emailOutcome", "historyOutcome", "finalizationReached"];
  if (!isObject(value) || !exactKeys(value, [...keys, ...(Object.hasOwn(value, "deliveryLedger") ? ["deliveryLedger"] : [])])) return false;
  return member(value.deliveryMode, ["normal", "degraded", "status_only"]) &&
    member(value.deliveryReason, ["selected", "no_eligible_stories", "ai_unavailable", "ai_no_selections", "discovery_unavailable", "history_unavailable", "preparation_unavailable", "persistence_unavailable"]) &&
    count(value.analyzedStories, 4) && count(value.rawStories, 4) && count(value.replayStories, 4) && count(value.emailAttempts, 1) &&
    member(value.emailOutcome, ["accepted", "failed", "unknown", "not_attempted"]) &&
    member(value.historyOutcome, ["not_required", "recorded", "unavailable", "persistence_failed"]) && typeof value.finalizationReached === "boolean" &&
    (!Object.hasOwn(value, "deliveryLedger") || (() => { try { validateDeliveryLedgerObservation(value.deliveryLedger); return true; } catch { return false; } })());
}

function validLatency(value: unknown): value is CycleLatencyV1 {
  if (!isObject(value) || !exactKeys(value, ["version", "preFilterInputCount", "selectedCount", "selectorExcluded", "byteExcluded", "submittedCount", "promptBytes", "snippetBytesLimit", "thinkingMode", "executionMode", "attemptTimings"]) ||
    value.version !== 1 || !count(value.preFilterInputCount, 50, true) || !count(value.selectedCount, 24, true) ||
    !count(value.selectorExcluded, 50, true) || !count(value.byteExcluded, 24, true) || !count(value.submittedCount, 24, true) ||
    !count(value.promptBytes, 12_288, true) || !(value.snippetBytesLimit === null || [192, 128, 96, 0].includes(value.snippetBytesLimit as number)) ||
    !(value.thinkingMode === null || value.thinkingMode === "low") ||
    !(value.executionMode === null || value.executionMode === "synchronous") || !Array.isArray(value.attemptTimings) || value.attemptTimings.length > 3) return false;
  let priorOrdinal = 0;
  for (const timing of value.attemptTimings) {
    if (!isObject(timing) || !exactKeys(timing, ["ordinal", "requestStartedAt", "elapsedMs"]) ||
      ![1, 2, 3].includes(timing.ordinal as number) || (timing.ordinal as number) <= priorOrdinal ||
      !(timing.requestStartedAt === null || (typeof timing.requestStartedAt === "string" && validUtcInstant(timing.requestStartedAt))) ||
      !count(timing.elapsedMs, 180_000, true)) return false;
    priorOrdinal = timing.ordinal as number;
  }
  const preFilterInputCount = value.preFilterInputCount as number | null;
  const selectedCount = value.selectedCount as number | null;
  const selectorExcluded = value.selectorExcluded as number | null;
  const submittedCount = value.submittedCount as number | null;
  const byteExcluded = value.byteExcluded as number | null;
  if (preFilterInputCount !== null && selectedCount !== null && selectorExcluded !== null &&
    selectedCount + selectorExcluded !== preFilterInputCount) return false;
  if (selectedCount !== null && submittedCount !== null && byteExcluded !== null &&
    submittedCount + byteExcluded !== selectedCount) return false;
  return true;
}

export function validateAnalyzerFailoverObservation(value: unknown): AnalyzerFailoverObservation {
  const keys=["version","provider","model","eligible","eligibilityReason","attempted","dispatchCount","startedAt","endedAt","durationMs","outcome","httpStatus","usage","accountingState","finalAnalyzer"];
  if(!isObject(value)||!exactKeys(value,keys)||value.version!==1||value.provider!=="openai"||value.model!=="gpt-6-luna"||typeof value.eligible!=="boolean"||
    !member(value.eligibilityReason,["eligible","gemini_not_exhausted","configuration","timing","accounting","consumed"])||typeof value.attempted!=="boolean"||!count(value.dispatchCount,1)||
    !(value.startedAt===null||(typeof value.startedAt==="string"&&validUtcInstant(value.startedAt)))||!(value.endedAt===null||(typeof value.endedAt==="string"&&validUtcInstant(value.endedAt)))||
    !count(value.durationMs,110_000,true)||!(value.httpStatus===null||(Number.isInteger(value.httpStatus)&&Number(value.httpStatus)>=100&&Number(value.httpStatus)<=599))||
    !member(value.outcome,["not_attempted","success","timeout","transport_error","http_failure","invalid_response","usage_unknown","accounting_failure"])||
    !member(value.accountingState,["none","reserved","exact","unknown","cancelled_pre_dispatch"])||!member(value.finalAnalyzer,["gemini","openai","none"]))throw new Error("Monitoring analyzer failover snapshot is invalid.");
  if(value.usage!==null){if(!isObject(value.usage)||!exactKeys(value.usage,["inputTokens","outputTokens","totalTokens"])||!count(value.usage.inputTokens,Number.MAX_SAFE_INTEGER)||!count(value.usage.outputTokens,Number.MAX_SAFE_INTEGER)||!count(value.usage.totalTokens,Number.MAX_SAFE_INTEGER)||value.usage.totalTokens!==Number(value.usage.inputTokens)+Number(value.usage.outputTokens))throw new Error("Monitoring analyzer failover snapshot is invalid.");}
  if((value.attempted&&value.dispatchCount!==1)||(!value.attempted&&value.dispatchCount!==0)||(value.outcome==="success"&&(value.accountingState!=="exact"||value.finalAnalyzer!=="openai"||value.usage===null)))throw new Error("Monitoring analyzer failover snapshot is invalid.");
  if(encoder.encode(JSON.stringify(value)).byteLength>1024)throw new Error("Monitoring analyzer failover snapshot exceeds its byte limit.");
  return value as unknown as AnalyzerFailoverObservation;
}

export function validateRssDiagnostics(value: unknown): RssDiagnosticsV1 {
  if (!isObject(value) || value.version !== 1 || !member(value.status, ["recorded", "unavailable"])) {
    throw new Error("RSS diagnostics are invalid.");
  }
  if (value.status === "unavailable") {
    if (!exactKeys(value, ["version", "status", "reason"]) || !member(value.reason, ["invalid_metrics", "snapshot_budget"])) {
      throw new Error("RSS diagnostics are invalid.");
    }
  } else {
    const keys = ["version", "status", "collectionStatus", "health", "configuredFeeds", "attemptedFeeds", "succeededFeeds", "failedFeeds", "outcomes"];
    if (!exactKeys(value, keys) || !member(value.collectionStatus, ["disabled", "configuration", "collected"]) ||
      !member(value.health, ["healthy", "degraded", "unavailable"]) || !count(value.configuredFeeds, 5) ||
      !count(value.attemptedFeeds, 5) || !count(value.succeededFeeds, 5) || !count(value.failedFeeds, 5) ||
      !Array.isArray(value.outcomes) || value.outcomes.length > 5 || Number(value.attemptedFeeds) > Number(value.configuredFeeds) ||
      Number(value.succeededFeeds) + Number(value.failedFeeds) !== Number(value.attemptedFeeds) || value.outcomes.length !== Number(value.attemptedFeeds)) {
      throw new Error("RSS diagnostics are invalid.");
    }
    const seen = new Set<string>();
    let succeeded = 0;
    let priorIndex = -1;
    for (const outcome of value.outcomes) {
      if (!isObject(outcome) || !exactKeys(outcome, ["feedId", "reason", ...(Object.hasOwn(outcome, "httpStatus") ? ["httpStatus"] : []),
        ...(Object.hasOwn(outcome, "subreason") ? ["subreason"] : []), "elapsedMs"]) ||
        !member(outcome.feedId, rssFeedIds) || seen.has(outcome.feedId as string) || !member(outcome.reason, rssReasons) ||
        !count(outcome.elapsedMs, 5000) || (Object.hasOwn(outcome, "httpStatus") &&
          (!(Number.isInteger(outcome.httpStatus) && Number(outcome.httpStatus) >= 100 && Number(outcome.httpStatus) <= 599) || outcome.reason !== "http")) ||
        (Object.hasOwn(outcome, "subreason") && (outcome.reason !== "structure" || !member(outcome.subreason, rssStructuralSubreasons)))) {
        throw new Error("RSS diagnostics are invalid.");
      }
      const index = rssFeedIds.indexOf(outcome.feedId as RssDiagnosticFeedId);
      if (index <= priorIndex) throw new Error("RSS diagnostics are invalid.");
      priorIndex = index;
      seen.add(outcome.feedId as string);
      if (outcome.reason === "ok") succeeded += 1;
    }
    const collectionStatus = value.collectionStatus as "disabled" | "configuration" | "collected";
    const expectedHealth = succeeded === 0 ? "unavailable" : Number(value.failedFeeds) > 0 ? "degraded" : "healthy";
    if (collectionStatus === "collected") {
      if (value.attemptedFeeds !== value.configuredFeeds || succeeded !== value.succeededFeeds || value.health !== expectedHealth ||
        value.outcomes.some(outcome => outcome.reason === "disabled" || outcome.reason === "configuration")) throw new Error("RSS diagnostics are invalid.");
    } else if (value.attemptedFeeds !== 0 || value.succeededFeeds !== 0 || value.failedFeeds !== 0 || value.outcomes.length !== 0 || value.health !== "unavailable") {
      throw new Error("RSS diagnostics are invalid.");
    }
  }
  if (encoder.encode(JSON.stringify(value)).byteLength > 1024) throw new Error("RSS diagnostics exceed their byte limit.");
  return value as unknown as RssDiagnosticsV1;
}

export function projectRssDiagnostics(metrics: unknown, health: RssDiscoverySourceHealth | null): RssDiagnosticsV1 | undefined {
  if (metrics === undefined) return undefined;
  const unavailable = (): RssDiagnosticsV1 => ({ version: 1, status: "unavailable", reason: "invalid_metrics" });
  if (!isObject(metrics) || !exactKeys(metrics, ["status", "configuredFeeds", "attemptedFeeds", "succeededFeeds", "failedFeeds", "observedPositions", "validCandidates", "rejectedItems", "itemLimitTruncations", "outcomes"]) ||
    !member(metrics.status, ["disabled", "configuration", "collected"]) || !count(metrics.configuredFeeds, 5) || !count(metrics.attemptedFeeds, 5) ||
    !count(metrics.succeededFeeds, 5) || !count(metrics.failedFeeds, 5) || !Array.isArray(metrics.outcomes) || health === null) return unavailable();
  const outcomes: Array<{ feedId: RssDiagnosticFeedId; reason: RssDiagnosticReason; httpStatus?: number; subreason?: RssStructuralSubreason; elapsedMs: number }> = [];
  for (const raw of metrics.outcomes) {
    if (!isObject(raw) || !exactKeys(raw, ["feedId", "reason", ...(Object.hasOwn(raw, "httpStatus") ? ["httpStatus"] : []),
      ...(Object.hasOwn(raw, "subreason") ? ["subreason"] : []), "elapsedMs"]) ||
      !member(raw.feedId, rssFeedIds) || !member(raw.reason, rssReasons) || typeof raw.elapsedMs !== "number" || !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0 ||
      (Object.hasOwn(raw, "httpStatus") && (!(Number.isInteger(raw.httpStatus) && Number(raw.httpStatus) >= 100 && Number(raw.httpStatus) <= 599) || raw.reason !== "http")) ||
      (Object.hasOwn(raw, "subreason") && (raw.reason !== "structure" || !member(raw.subreason, rssStructuralSubreasons)))) return unavailable();
    outcomes.push({ feedId: raw.feedId as RssDiagnosticFeedId, reason: raw.reason as RssDiagnosticReason,
      ...(Object.hasOwn(raw, "httpStatus") ? { httpStatus: raw.httpStatus as number } : {}),
      ...(Object.hasOwn(raw, "subreason") ? { subreason: raw.subreason as RssStructuralSubreason } : {}),
      elapsedMs: Math.min(5000, Math.floor(raw.elapsedMs)) });
  }
  const projected: RssDiagnosticsV1 = { version: 1, status: "recorded", collectionStatus: metrics.status as RssCycleMetrics["status"], health,
    configuredFeeds: metrics.configuredFeeds as number, attemptedFeeds: metrics.attemptedFeeds as number,
    succeededFeeds: metrics.succeededFeeds as number, failedFeeds: metrics.failedFeeds as number, outcomes };
  try { return validateRssDiagnostics(projected); } catch { return unavailable(); }
}

export function attachRssDiagnostics(base: CycleSnapshotV1, diagnostics: RssDiagnosticsV1 | undefined): { snapshot: CycleSnapshotV1; omission: "invalid_metrics" | "snapshot_budget" | null } {
  if (Object.hasOwn(base, "rssDiagnostics")) throw new Error("Monitoring cycle snapshot base already contains RSS diagnostics.");
  const core = validateCycleSnapshot(base);
  if (diagnostics === undefined) return { snapshot: core, omission: null };
  let validated: RssDiagnosticsV1;
  try { validated = validateRssDiagnostics(diagnostics); }
  catch { validated = { version: 1, status: "unavailable", reason: "invalid_metrics" }; }
  const omission = validated.status === "unavailable" ? validated.reason : null;
  const candidate = { ...core, rssDiagnostics: validated };
  if (encoder.encode(JSON.stringify(candidate)).byteLength <= 8192) return { snapshot: validateCycleSnapshot(candidate), omission };
  const marker: RssDiagnosticsV1 = { version: 1, status: "unavailable", reason: "snapshot_budget" };
  const marked = { ...core, rssDiagnostics: marker };
  if (encoder.encode(JSON.stringify(marked)).byteLength <= 8192) return { snapshot: validateCycleSnapshot(marked), omission: "snapshot_budget" };
  return { snapshot: core, omission: "snapshot_budget" };
}

export function validateCycleSnapshot(value: unknown): CycleSnapshotV1 {
  const keys = ["version", "braveHealth", "rssHealth", "outage", "candidateCounts", "geminiDispatchCount", "delivery", "accounting"];
  if (!isObject(value) || !exactKeys(value, [...keys, ...(Object.hasOwn(value,"latency")?["latency"]:[]), ...(Object.hasOwn(value,"analyzerFailover")?["analyzerFailover"]:[]), ...(Object.hasOwn(value,"threads")?["threads"]:[]), ...(Object.hasOwn(value,"rssDiagnostics")?["rssDiagnostics"]:[])]) || value.version !== 1 ||
    !(value.braveHealth === null || member(value.braveHealth, ["healthy", "degraded", "unavailable", "quota_blocked"])) ||
    !(value.rssHealth === null || member(value.rssHealth, ["healthy", "degraded", "unavailable"])) ||
    !(value.outage === null || typeof value.outage === "boolean") || !isObject(value.candidateCounts) ||
    !exactKeys(value.candidateCounts, ["received", "unique", "submitted"]) || !count(value.candidateCounts.received, 100_000, true) ||
    !count(value.candidateCounts.unique, 100_000, true) || !count(value.candidateCounts.submitted, 50, true) ||
    !count(value.geminiDispatchCount, 3, true) || !(value.delivery === null || validDelivery(value.delivery)) ||
    !isObject(value.accounting) || !exactKeys(value.accounting, ["reserved", "exact", "confirmedZero", "ambiguous", "unavailable"]) ||
    !count(value.accounting.reserved, 3) || !count(value.accounting.exact, 3) || !count(value.accounting.confirmedZero, 3) ||
    !count(value.accounting.ambiguous, 3) || typeof value.accounting.unavailable !== "boolean" ||
    ("latency" in value && !validLatency(value.latency)) || ("analyzerFailover" in value && (()=>{try{validateAnalyzerFailoverObservation(value.analyzerFailover);return false;}catch{return true;}})()) ||
    ("threads" in value && (()=>{try{validateThreadsCycleMetrics(value.threads);return false;}catch{return true;}})()) ||
    ("rssDiagnostics" in value && (()=>{try{validateRssDiagnostics(value.rssDiagnostics);return false;}catch{return true;}})())) {
    throw new Error("Monitoring cycle snapshot is invalid.");
  }
  if (Object.hasOwn(value, "rssDiagnostics")) {
    const diagnostics = validateRssDiagnostics(value.rssDiagnostics);
    if (diagnostics.status === "recorded" && value.rssHealth !== null && diagnostics.health !== value.rssHealth) {
      throw new Error("Monitoring cycle snapshot is invalid.");
    }
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
