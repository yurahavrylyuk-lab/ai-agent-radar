import { D1BraveUsageStore } from "./d1BraveUsageStore.js";
import { D1DiscoveryHistory } from "./d1DiscoveryHistory.js";
import { D1EmailDeliveryLedger } from "./d1EmailDeliveryLedger.js";
import { D1EmailFeedbackStore } from "./d1EmailFeedbackStore.js";
import { discoveryTopicTaxonomy } from "./discoveryPriority.js";
import { FEEDBACK_CAPABILITY_DAYS } from "./emailFeedback.js";
import { calculateFeedbackPreferenceProfile } from "./feedbackPreferences.js";
import { D1GeminiUsageStore } from "./d1GeminiUsageStore.js";
import { D1MonitoringTelemetry } from "./d1MonitoringTelemetry.js";
import { D1NotificationHistory } from "./d1NotificationHistory.js";
import { D1OpenAIFallbackUsageStore } from "./d1OpenAIFallbackUsageStore.js";
import { isValidAgentAnalysis, isValidBatchSelectionProvenance } from "./discoveryHistoryCore.js";
import { isGeminiUsageRecord } from "./geminiUsageTracker.js";
import { isGeminiFailureClass } from "./geminiFailureClassification.js";
import { isUsageRecord } from "./usageTracker.js";
import { validateCycleSnapshot, validateCycleStart } from "./monitoringTelemetry.js";

type Check = (value: unknown) => boolean;
type Shape = Record<string, Check>;
type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);
const shape = (fields: Shape): Check => v => object(v) && Object.keys(v).length === Object.keys(fields).length &&
  Object.keys(fields).every(k => Object.hasOwn(v, k) && fields[k](v[k]));
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const either = (...checks: Check[]): Check => v => checks.some(check => check(v));
const text = (limit: number): Check => v => typeof v === "string" && v.length > 0 && v.length <= limit;
const integer = (min: number, max = Number.MAX_SAFE_INTEGER): Check => v =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const array = (check: Check, limit: number): Check => v => Array.isArray(v) && v.length <= limit && v.every(check);
const matches = (pattern: RegExp): Check => v => typeof v === "string" && pattern.test(v);
const iso: Check = v => typeof v === "string" && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export const logicalDate: Check = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && iso(v + "T00:00:00.000Z");
const deliveryKey: Check = v => typeof v === "string" && v.startsWith("daily-digest/") && logicalDate(v.slice(13));
const hash = matches(/^[a-f0-9]{64}$/);
const uuid = matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const token = text(256);
const url = text(2048);
const aliases = array(url, 100);
const email = oneOf("email");
const claim = shape({ key: deliveryKey, token, generation: integer(1) });
const attempt = shape({ cycleId: uuid, ordinal: integer(1, 3) });
const http = either(integer(100, 599), oneOf(null));
const ambiguity = oneOf("timeout", "network_error", "response_usage_unavailable", "abandoned_reservation", "settlement_uncertain");
const geminiUsage = shape({ inputTokens: integer(0), outputTokens: integer(0), totalTokens: integer(0) });
const reservation = shape({ id: matches(/^d1:[1-9]\d{0,15}$/), record: isGeminiUsageRecord });
const evidence = shape({ failureClass: isGeminiFailureClass, httpStatus: http, accountingError: oneOf(true, false), observedAt: iso });
const settlement = either(
  shape({ kind: oneOf("exact"), usage: geminiUsage, evidence }),
  shape({ kind: oneOf("confirmed_zero"), evidence }),
  shape({ kind: oneOf("transport_ambiguous"), reason: ambiguity, evidence }),
);
const limits = shape({ dailyRequests: integer(1), weeklyRequests: integer(1), monthlyRequests: integer(1),
  dailyTokens: integer(1), weeklyTokens: integer(1), monthlyTokens: integer(1) });
const lunaReservation = shape({ cycleId: uuid, attemptId: uuid, scheduledAt: iso, reservedAt: iso });
const lunaEvidence = shape({ outcome: oneOf("none", "timeout", "transport_error", "http_failure", "invalid_response", "usage_unknown"),
  httpStatus: http, endedAt: iso, durationMs: integer(0) });
const resendOutcome = either(
  shape({ kind: oneOf("accepted"), id: token }),
  shape({ kind: oneOf("rejected"), rejection: oneOf("validation", "authentication", "permission", "quota") }),
  shape({ kind: oneOf("ambiguous"), reason: oneOf("timeout", "transport", "concurrent", "invalid_response", "http") }),
  shape({ kind: oneOf("payload_conflict") }),
);
const frozen = shape({
  identity: shape({ key: deliveryKey, logicalDate, scheduledAt: iso }), payloadVersion: oneOf(1),
  content: shape({ from: text(1024), subject: text(1024), text: text(65536), html: text(196608) }),
  payloadSha256: hash, aliases: array(url, 128), mode: oneOf("normal", "degraded", "status_only"),
  reason: oneOf("selected", "no_eligible_stories", "ai_unavailable", "ai_no_selections", "discovery_unavailable",
    "history_unavailable", "preparation_unavailable", "persistence_unavailable"),
});
const topicKeys = Object.keys(discoveryTopicTaxonomy);
const utf8 = new TextEncoder();
const feedbackBinding = shape({
  deliveryKey, slot: integer(1, 4), payloadSha256: hash, storySha256: hash, discoveryKey: hash,
  displayTitle: value => text(256)(value) && utf8.encode(value as string).byteLength <= 256,
  kind: oneOf("analyzed", "raw"), topics: array(oneOf(...topicKeys), topicKeys.length),
  issuedAt: iso, expiresAt: iso, keyId: matches(/^[A-Za-z0-9_-]{1,32}$/),
  relevantDigest: hash, notRelevantDigest: hash,
});
const verify = (fn: (v: unknown) => unknown): Check => v => {
  try { fn(v); return true; } catch { return false; }
};

function operation<A extends unknown[], R>(run: (...args: A) => Promise<R>, checks: { [K in keyof A]-?: Check },
  nullable: readonly number[] = [], dates: readonly number[] = []) {
  return {
    run,
    invoke(args: unknown[]): Promise<R> {
      if (args.length !== checks.length || !checks.every((check, index) =>
        (args[index] === null && nullable.includes(index)) || check(args[index]))) throw new InvalidGatewayRequest();
      const decoded = args.map((value, index) => dates.includes(index) && value !== null ? new Date(value as string)
        : value === null && nullable.includes(index) ? undefined : value);
      return run(...decoded as A);
    },
  };
}
export class InvalidGatewayRequest extends Error {}

async function acquireDay(db: D1Database, date: string, mode: "admit" | "recover"): Promise<boolean> {
  // An unacknowledged insert is deliberately never retried or read back as execution authority.
  const prerequisite = mode === "admit" ? "" : `AND EXISTS (
    SELECT 1 FROM controlled_execution_locks WHERE name = 'github-batch:admit:' || ?2
    AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes'))
    AND EXISTS (SELECT 1 FROM email_deliveries WHERE delivery_key = 'daily-digest/' || ?2)`;
  const result = await db.prepare(`INSERT OR IGNORE INTO controlled_execution_locks (name,created_at)
    SELECT ?1,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ?2 = date('now') ${prerequisite}`)
    .bind(`github-batch:${mode}:${date}`, date).run();
  if (!result.success || ![0, 1].includes(result.meta.changes)) throw new Error("Daily authority unavailable.");
  return result.meta.changes === 1;
}

export function batchGatewayOperations(db: D1Database) {
  const history = new D1DiscoveryHistory(db);
  const notifications = new D1NotificationHistory(db);
  const brave = new D1BraveUsageStore(db, 2048);
  const gemini = new D1GeminiUsageStore(db, 2048);
  const ledger = new D1EmailDeliveryLedger(db);
  const telemetry = new D1MonitoringTelemetry(db);
  const luna = new D1OpenAIFallbackUsageStore(db);
  return {
    "daily.admit": operation((date: string) => acquireDay(db, date, "admit"), [logicalDate]),
    "daily.recover": operation((date: string) => acquireDay(db, date, "recover"), [logicalDate]),
    "history.getDiscovery": operation(history.getDiscovery.bind(history), [url]),
    "history.getDiscoveries": operation(history.getDiscoveries.bind(history), [aliases]),
    "history.listRecentDiscoveries": operation(history.listRecentDiscoveries.bind(history),
      [shape({ fromInclusive: iso, beforeExclusive: iso, limit: integer(1, 100) })]),
    "history.touchDiscovery": operation(history.touchDiscovery.bind(history), [url, iso], [1], [1]),
    "history.touchDiscoveries": operation(history.touchDiscoveries.bind(history), [aliases, iso], [1], [1]),
    "history.recordDiscoveryWithOutcome": operation(history.recordDiscoveryWithOutcome.bind(history),
      [isValidAgentAnalysis, iso, oneOf(null), isValidBatchSelectionProvenance], [1, 2, 3], [1]),
    "notifications.getNotificationRecord": operation(notifications.getNotificationRecord.bind(notifications), [url, email]),
    "notifications.getNotificationRecords": operation(notifications.getNotificationRecords.bind(notifications), [aliases, email]),
    "notifications.hasNotificationBeenSent": operation(notifications.hasNotificationBeenSent.bind(notifications), [url, email]),
    "brave.getRecords": operation(brave.getRecords.bind(brave), []),
    "brave.recordRequest": operation(brave.recordRequest.bind(brave), [v =>
      isUsageRecord(v) && v.provider === "brave" && v.operation === "web-search" && v.requestCount === 1 && iso(v.timestamp)]),
    "gemini.getUsageData": operation(gemini.getUsageData.bind(gemini), []),
    "gemini.markUsageUnknown": operation(gemini.markUsageUnknown.bind(gemini), []),
    "gemini.reserveRequest": operation(gemini.reserveRequest.bind(gemini),
      [isGeminiUsageRecord, shape({ limits, cycleRequestsRemaining: integer(1, 3) })]),
    "gemini.settleRequest": operation(gemini.settleRequest.bind(gemini), [reservation, geminiUsage]),
    "gemini.confirmZeroRequest": operation(gemini.confirmZeroRequest.bind(gemini), [reservation]),
    "gemini.markRequestAmbiguous": operation(gemini.markRequestAmbiguous.bind(gemini), [reservation, ambiguity]),
    "gemini.settleObservedAttempt": operation(gemini.settleObservedAttempt.bind(gemini), [attempt, reservation, settlement]),
    "luna.reserve": operation(luna.reserve.bind(luna), [uuid, limits]),
    "luna.markIntent": operation(luna.markIntent.bind(luna), [lunaReservation]),
    "luna.markObserved": operation(luna.markObserved.bind(luna), [lunaReservation]),
    "luna.settleExact": operation(luna.settleExact.bind(luna), [lunaReservation, geminiUsage, lunaEvidence]),
    "luna.markUnknown": operation(luna.markUnknown.bind(luna), [lunaReservation, lunaEvidence]),
    "luna.cancelBeforeDispatch": operation(luna.cancelBeforeDispatch.bind(luna), [lunaReservation]),
    "ledger.read": operation(ledger.read.bind(ledger), [deliveryKey]),
    "ledger.reserve": operation(ledger.reserve.bind(ledger), [frozen]),
    "ledger.reserveWithBindings": operation(async (
      delivery: Parameters<typeof ledger.reserveWithBindings>[0],
      bindings: Parameters<typeof ledger.reserveWithBindings>[1],
    ) => {
      if (delivery.mode === "status_only" || bindings.length === 0 || bindings.some((binding, index) =>
        binding.deliveryKey !== delivery.identity.key || binding.slot !== index + 1 ||
        binding.payloadSha256 !== delivery.payloadSha256 || binding.issuedAt !== delivery.identity.scheduledAt ||
        Date.parse(binding.expiresAt) - Date.parse(binding.issuedAt) !== FEEDBACK_CAPABILITY_DAYS * 86_400_000 ||
        binding.relevantDigest === binding.notRelevantDigest ||
        (binding.kind === "raw" && binding.topics.length !== 0) ||
        binding.topics.some((topic, i) => i > 0 && topicKeys.indexOf(topic) <= topicKeys.indexOf(binding.topics[i - 1]!)))) {
        throw new InvalidGatewayRequest();
      }
      return ledger.reserveWithBindings(delivery, bindings);
    }, [frozen, array(feedbackBinding, 4)]),
    "feedback.getPreferenceProfile": operation(async (at: string) =>
      calculateFeedbackPreferenceProfile(await new D1EmailFeedbackStore(db).loadPreferenceObservations(at)), [iso]),
    "feedback.pruneExpired": operation(() => new D1EmailFeedbackStore(db).pruneExpired(new Date().toISOString()), []),
    "ledger.claim": operation(ledger.claim.bind(ledger), [deliveryKey, token]),
    "ledger.admitDispatch": operation(ledger.admitDispatch.bind(ledger), [claim]),
    "ledger.verifyDispatch": operation(ledger.verifyDispatch.bind(ledger), [claim]),
    "ledger.cancelUndispatched": operation(ledger.cancelUndispatched.bind(ledger), [claim]),
    "ledger.recordOutcome": operation(ledger.recordOutcome.bind(ledger), [claim, hash, resendOutcome]),
    "ledger.reconcileAccepted": operation(ledger.reconcileAccepted.bind(ledger), [deliveryKey]),
    "ledger.reconcileOneOlder": operation(ledger.reconcileOneOlder.bind(ledger), [logicalDate]),
    "telemetry.createCycle": operation(telemetry.createCycle.bind(telemetry), [verify(validateCycleStart)]),
    "telemetry.checkpoint": operation(telemetry.checkpoint.bind(telemetry),
      [uuid, oneOf("started", "sources_complete", "gemini_complete", "email_attempting", "completed"), verify(validateCycleSnapshot)]),
    "telemetry.bindAttempt": operation(telemetry.bindAttempt.bind(telemetry), [attempt, reservation]),
    "telemetry.markDispatchIntent": operation(telemetry.markDispatchIntent.bind(telemetry), [attempt]),
    "telemetry.markDispatchObserved": operation(telemetry.markDispatchObserved.bind(telemetry), [attempt]),
    "telemetry.recordEvidence": operation(telemetry.recordEvidence.bind(telemetry), [attempt, evidence]),
    "telemetry.recordRetryDecision": operation(telemetry.recordRetryDecision.bind(telemetry),
      [attempt, oneOf("not_evaluated", "retry", "stop"), oneOf("none", "retryable_503", "non_retryable", "max_attempts", "deadline", "quota", "accounting", "telemetry", "cancelled")]),
    "telemetry.completeCycle": operation(telemetry.completeCycle.bind(telemetry), [uuid, verify(validateCycleSnapshot)]),
    "telemetry.readCycle": operation(telemetry.readCycle.bind(telemetry), [uuid]),
  };
}

export type BatchGatewayOperations = ReturnType<typeof batchGatewayOperations>;
