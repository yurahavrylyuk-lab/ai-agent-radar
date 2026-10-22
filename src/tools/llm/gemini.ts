import { APPROVED_GEMINI_MODELS, type ApprovedGeminiModel } from "../../config/geminiModels.js";
import { checkGeminiUsage } from "../../services/geminiUsageGuard.js";
import { classifyGeminiHttpFailure, isReviewedGeminiProviderFailure } from "../../services/geminiFailureClassification.js";
import { areGeminiTimestampsInSameUtcWindows } from "../../services/geminiAccountingWindows.js";
import type { GeminiAmbiguityReason, GeminiUsageReservation, GeminiUsageStore } from "../../services/geminiUsageTracker.js";
import type { RuntimeEnvironment } from "../../services/radarRuntimeConfiguration.js";
import type { AttemptRef, AttemptSettlement, MonitoringTelemetry } from "../../services/monitoringTelemetry.js";
import type { GeminiBatchAttemptSummary, GeminiBatchRetrySkipReason, GeminiProviderFailureClass } from "../../types/index.js";
import type { LlmResult } from "./types.js";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_TIMEOUT_MS = 90_000;
export const GEMINI_BATCH_CUTOFF_MS = 75_000;
export const MAX_GEMINI_BATCH_DISPATCHES = 3;
const GEMINI_503_MAX_RETRIES = 3;
const GEMINI_503_DELAY_MS = 5_000;
export const MAX_GEMINI_ATTEMPTS_PER_ANALYSIS = APPROVED_GEMINI_MODELS.length * (GEMINI_503_MAX_RETRIES + 1);

interface GeminiResponse {
  output_text?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number; total_tokens?: number };
}

interface GeminiErrorBody {
  error?: { message?: unknown; status?: unknown; details?: unknown };
}

class GeminiReviewedProviderFailureError extends Error {
  constructor(message: string, readonly providerFailureClass: GeminiProviderFailureClass) {
    super(message);
    this.name = "GeminiReviewedProviderFailureError";
  }
}

/** Returns only classification attached at the validated provider/accounting boundary. */
export function getGeminiProviderFailureClass(error: unknown): GeminiProviderFailureClass | undefined {
  return error instanceof GeminiReviewedProviderFailureError ? error.providerFailureClass : undefined;
}

export interface GeminiCycleContext {
  remainingRequests?: number;
  dispatchBlockedByTimeout: boolean;
  providerAttempts: number;
  fallbacks: number;
  analysesUsingFallbackModel: number;
  requestsByModel: Record<ApprovedGeminiModel, number>;
}

export function createGeminiCycleContext(): GeminiCycleContext {
  return {
    dispatchBlockedByTimeout: false,
    providerAttempts: 0,
    fallbacks: 0,
    analysesUsingFallbackModel: 0,
    requestsByModel: { "gemini-3.8-flash": 0, "gemini-3.6-flash": 0, "gemini-3.5-flash-lite": 0 },
  };
}

export interface GeminiBatchCycleContext extends GeminiCycleContext {
  batchStarted: boolean;
  reservationAttempts: number;
  reservations: number;
  providerDispatches: number;
  attempts: GeminiBatchAttemptSummary[];
  retryEligible: boolean;
  retryAttempted: boolean;
  retrySkipReason: GeminiBatchRetrySkipReason;
}

/** Create once per cycle; never replace this context to retry a consumed batch. */
export function createGeminiBatchCycleContext(): GeminiBatchCycleContext {
  return { ...createGeminiCycleContext(), batchStarted: false, reservationAttempts: 0, reservations: 0, providerDispatches: 0,
    attempts: [], retryEligible: false, retryAttempted: false, retrySkipReason: "none" };
}

export interface GeminiDependencies {
  usageTracker?: GeminiUsageStore;
  environment?: RuntimeEnvironment;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  /** Monotonic clock for the provider interaction deadline; tests may supply a deterministic clock. */
  monotonicNow?: () => number;
  retryDelayMs?: number;
  cycleContext?: GeminiCycleContext;
  now?: () => Date;
  /** Deterministic offline hook at the final handoff before fetch; production leaves this unset. */
  beforeDispatch?: (reservation: GeminiUsageReservation) => void | Promise<void>;
  /** Offline deterministic hooks for the bounded Batch-only backoff. */
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  attemptTelemetry?: {
    repository: MonitoringTelemetry;
    cycleId: string;
    settle: (ref: AttemptRef, reservation: GeminiUsageReservation, outcome: AttemptSettlement) => Promise<void>;
  };
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function requiredApiKey(environment: RuntimeEnvironment): string {
  const value = environment.GEMINI_API_KEY?.trim();
  if (!value) throw new Error("GEMINI_API_KEY is not configured. Add it to your .env file.");
  return value;
}

function usageOf(usage: GeminiResponse["usage"]): LlmResult["usage"] {
  const inputTokens = usage?.total_input_tokens;
  const outputTokens = usage?.total_output_tokens;
  const totalTokens = usage?.total_tokens;
  const thoughtTokens = usage?.total_thought_tokens;
  if (![inputTokens, outputTokens, totalTokens].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) ||
    totalTokens! < inputTokens! + outputTokens! ||
    (thoughtTokens !== undefined && (!Number.isSafeInteger(thoughtTokens) || thoughtTokens < 0))) {
    throw new Error("Gemini response did not include valid token usage.");
  }
  return { inputTokens: inputTokens!, outputTokens: outputTokens!, totalTokens: totalTokens!, ...(thoughtTokens === undefined ? {} : { thoughtTokens }) };
}

function outputTextOf(response: GeminiResponse): string {
  if (response.output_text) return response.output_text;
  return response.steps?.find((step) => step.type === "model_output")?.content?.find((part) => part.type === "text")?.text ?? "";
}

function safeMessage(value: unknown, apiKey: string): string {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "Unknown Gemini API error";
  return message.replaceAll(apiKey, "[REDACTED]").slice(0, 1_000);
}

function parseErrorBody(body: string): GeminiErrorBody | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" ? parsed as GeminiErrorBody : undefined;
  } catch { return undefined; }
}

function errorMessage(body: string, parsed: GeminiErrorBody | undefined, apiKey: string): string {
  const message = parsed?.error?.message ?? parsed?.error?.status;
  return safeMessage(typeof message === "string" && message ? message : body || "No response body returned.", apiKey);
}

function initializeFrozenAllowance(context: GeminiCycleContext, check: Awaited<ReturnType<typeof checkGeminiUsage>>): void {
  if (!check.allowed || context.remainingRequests !== undefined) return;
  context.remainingRequests = Math.min(
    check.limits.dailyRequests - check.counts.dailyRequests,
    check.limits.weeklyRequests - check.counts.weeklyRequests,
    check.limits.monthlyRequests - check.counts.monthlyRequests,
  );
}

async function settleExactUsage(
  tracker: GeminiUsageStore,
  reservation: Awaited<ReturnType<GeminiUsageStore["reserveRequest"]>>,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number },
  message: string,
): Promise<void> {
  try { await tracker.settleRequest(reservation, usage); }
  catch {
    try { await tracker.markRequestAmbiguous(reservation, "settlement_uncertain"); } catch { /* The unresolved record still fails closed. */ }
    throw new Error(message);
  }
}

async function preserveAmbiguity(
  tracker: GeminiUsageStore,
  reservation: GeminiUsageReservation,
  reason: GeminiAmbiguityReason,
): Promise<void> {
  try { await tracker.markRequestAmbiguous(reservation, reason); }
  catch { throw new Error("Gemini request outcome is ambiguous, and its durable ambiguity state could not be verified safely."); }
}

async function rejectBeforeDispatch(
  tracker: GeminiUsageStore,
  reservation: GeminiUsageReservation,
  message: string,
): Promise<never> {
  try { await tracker.confirmZeroRequest(reservation); }
  catch { throw new Error("Gemini request was not dispatched, but confirmed-zero accounting could not be recorded safely."); }
  throw new Error(message);
}

export async function generateWithGemini(input: string, dependencies: GeminiDependencies = {}): Promise<LlmResult> {
  return generateWithGeminiPolicy(input, dependencies);
}

export async function generateBatchWithGemini(
  input: string,
  dependencies: Omit<GeminiDependencies, "cycleContext"> & { cycleContext: GeminiBatchCycleContext },
): Promise<LlmResult> {
  const context = dependencies.cycleContext;
  // Consume synchronously, including admission/configuration failures and concurrent invocations.
  if (context.batchStarted) throw new Error("Gemini batch has already started for this cycle.");
  context.batchStarted = true;
  return generateWithGeminiPolicy(input, dependencies, context);
}

/** Share the accounting state machine; Batch permits one same-model retry only after reviewed confirmed-zero evidence. */
async function generateWithGeminiPolicy(
  input: string,
  dependencies: GeminiDependencies,
  batchContext?: GeminiBatchCycleContext,
): Promise<LlmResult> {
  const environment = dependencies.environment ?? process.env;
  const apiKey = requiredApiKey(environment);
  const tracker = dependencies.usageTracker;
  if (!tracker) throw new Error("Gemini usage tracker is required.");
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const retryDelayMs = dependencies.retryDelayMs ?? GEMINI_503_DELAY_MS;
  const sleepImplementation = dependencies.sleep ?? sleep;
  const random = dependencies.random ?? Math.random;
  const context = dependencies.cycleContext ?? createGeminiCycleContext();
  const now = dependencies.now ?? (() => new Date());
  const maxAttemptsPerModel = batchContext ? MAX_GEMINI_BATCH_DISPATCHES : GEMINI_503_MAX_RETRIES + 1;
  const models = batchContext ? [APPROVED_GEMINI_MODELS[0]] : APPROVED_GEMINI_MODELS;
  const timeoutMs = dependencies.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  let batchDeadlineStartedAt: number | undefined;

  if (context.dispatchBlockedByTimeout) {
    throw new Error("Gemini requests stopped for this cycle after a timeout.");
  }

  for (const [modelIndex, model] of models.entries()) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      const batchCutoffMs = Math.min(timeoutMs, GEMINI_BATCH_CUTOFF_MS);
      if (batchContext && batchDeadlineStartedAt !== undefined && monotonicNow() - batchDeadlineStartedAt >= batchCutoffMs) {
        batchContext.retrySkipReason = "budget";
        throw new Error("Gemini batch retry was not dispatched because its provider cutoff expired.");
      }
      const usageCheck = await checkGeminiUsage(tracker, environment, now());
      if (!usageCheck.allowed) {
        if (batchContext && attempt > 1) batchContext.retrySkipReason = "admission";
        throw new Error("Gemini request blocked by usage guard.");
      }
      initializeFrozenAllowance(context, usageCheck);
      if ((context.remainingRequests ?? 0) <= 0) {
        if (batchContext && attempt > 1) batchContext.retrySkipReason = "admission";
        throw new Error("Gemini request blocked by frozen cycle request allowance.");
      }

      let reservation: Awaited<ReturnType<GeminiUsageStore["reserveRequest"]>>;
      try {
        if (batchContext) batchContext.reservationAttempts += 1;
        reservation = await tracker.reserveRequest({
          timestamp: now().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1,
          inputTokens: 0, outputTokens: 0, totalTokens: 0, model,
        }, { limits: usageCheck.limits, cycleRequestsRemaining: context.remainingRequests ?? 0 });
      } catch {
        if (batchContext && attempt > 1) batchContext.retrySkipReason = "accounting";
        throw new Error("Gemini request could not be reserved safely.");
      }

      if (batchContext) batchContext.reservations += 1;
      context.remainingRequests = (context.remainingRequests ?? 1) - 1;
      context.providerAttempts += 1;
      context.requestsByModel[model] += 1;

      const attemptRef: AttemptRef | undefined = dependencies.attemptTelemetry && batchContext
        ? { cycleId: dependencies.attemptTelemetry.cycleId, ordinal: attempt as 1 | 2 | 3 }
        : undefined;
      const observedAt = () => new Date(Math.max(now().getTime(), new Date(reservation.record.timestamp).getTime())).toISOString();
      const settleAttempt = async (outcome: AttemptSettlement): Promise<void> => {
        if (dependencies.attemptTelemetry && attemptRef) {
          await dependencies.attemptTelemetry.settle(attemptRef, reservation, outcome);
          return;
        }
        if (outcome.kind === "exact") await settleExactUsage(tracker, reservation, outcome.usage,
          "Gemini request succeeded, but its usage could not be recorded safely.");
        else if (outcome.kind === "confirmed_zero") await tracker.confirmZeroRequest(reservation);
        else await preserveAmbiguity(tracker, reservation, outcome.reason);
      };
      if (dependencies.attemptTelemetry && attemptRef) {
        try { await dependencies.attemptTelemetry.repository.bindAttempt(attemptRef, reservation); }
        catch {
          await rejectBeforeDispatch(tracker, reservation, "Gemini request telemetry could not be bound before provider dispatch.");
        }
      }

      if (!areGeminiTimestampsInSameUtcWindows(reservation.record.timestamp, now())) {
        await rejectBeforeDispatch(tracker, reservation,
          "Gemini request was not dispatched because its accounting window changed after reservation.");
      }

      try { await dependencies.beforeDispatch?.(reservation); }
      catch { await rejectBeforeDispatch(tracker, reservation, "Gemini request failed before provider dispatch."); }

      if (batchContext && !areGeminiTimestampsInSameUtcWindows(reservation.record.timestamp, now())) {
        await rejectBeforeDispatch(tracker, reservation,
          "Gemini request was not dispatched because its accounting window changed after reservation.");
      }

      if (batchContext && batchDeadlineStartedAt !== undefined && monotonicNow() - batchDeadlineStartedAt >= batchCutoffMs) {
        batchContext.retrySkipReason = "budget";
        await rejectBeforeDispatch(tracker, reservation, "Gemini batch retry was not dispatched because its overall deadline expired.");
      }
      const controller = new AbortController();
      const deadlineStartedAt = batchContext ? (batchDeadlineStartedAt ??= monotonicNow()) : monotonicNow();
      const providerDeadlineMs = batchContext ? batchCutoffMs : timeoutMs;
      const deadlineExpired = () => controller.signal.aborted || monotonicNow() - deadlineStartedAt >= providerDeadlineMs;
      const remainingTimeoutMs = Math.max(1, providerDeadlineMs - (monotonicNow() - deadlineStartedAt));
      const timeout = setTimeout(() => controller.abort(), remainingTimeoutMs);
      let response: Response | undefined;
      let errorBody: string | undefined;
      let parsedErrorBody: GeminiErrorBody | undefined;
      let geminiResponse: GeminiResponse | undefined;
      let telemetryObservationFailed = false;
      if (dependencies.attemptTelemetry && attemptRef) {
        try { await dependencies.attemptTelemetry.repository.markDispatchIntent(attemptRef); }
        catch {
          clearTimeout(timeout);
          await settleAttempt({ kind: "confirmed_zero", evidence: { failureClass: "accounting_failure", httpStatus: null, accountingError: true, observedAt: observedAt() } });
          throw new Error("Gemini request telemetry intent could not be recorded before provider dispatch.");
        }
      }
      try {
        if (batchContext) batchContext.providerDispatches += 1;
        let responsePromise: Promise<Response> | undefined;
        let synchronousDispatchError: unknown;
        try {
          responsePromise = fetchImplementation(GEMINI_INTERACTIONS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify({ model, input }),
            signal: controller.signal,
          });
        } catch (error) { synchronousDispatchError = error; }
        if (dependencies.attemptTelemetry && attemptRef) {
          try { await dependencies.attemptTelemetry.repository.markDispatchObserved(attemptRef); }
          catch { telemetryObservationFailed = true; }
        }
        if (synchronousDispatchError !== undefined) throw synchronousDispatchError;
        if (!responsePromise) throw new Error("Gemini fetch did not return a response promise.");
        response = await responsePromise;
        if (response.ok) {
          const body = await response.text();
          if (!deadlineExpired()) geminiResponse = JSON.parse(body) as GeminiResponse;
        } else {
          errorBody = (await response.text()).slice(0, 10_000);
          if (!deadlineExpired()) parsedErrorBody = parseErrorBody(errorBody);
        }
      } catch (error) {
        const timedOut = deadlineExpired();
        const reason: GeminiAmbiguityReason = timedOut
          ? "timeout"
          : response === undefined ? "network_error" : "response_usage_unavailable";
        if (reason === "timeout") context.dispatchBlockedByTimeout = true;
        try { await settleAttempt({ kind: "transport_ambiguous", reason, evidence: {
          failureClass: timedOut ? "timeout" : response === undefined ? "transport_error" : "response_invalid",
          httpStatus: response?.status ?? null, accountingError: telemetryObservationFailed, observedAt: observedAt(),
        } }); }
        catch { throw new Error("Gemini request outcome is ambiguous, and its durable ambiguity state could not be verified safely."); }
        if (batchContext) batchContext.attempts.push({ ordinal: attempt as 1 | 2 | 3,
          failureClass: timedOut ? "timeout" : response === undefined ? "transport_error" : "response_invalid",
          httpStatus: response?.status ?? null, accountingError: false, accountingOutcome: "transport_ambiguous",
          elapsedMs: Math.min(timeoutMs, Math.max(0, Math.trunc(monotonicNow() - deadlineStartedAt))) });
        if (timedOut) throw new Error("Gemini request timed out after 90 seconds.");
        if (response?.ok) throw new Error("Gemini response was not valid JSON.");
        if (response !== undefined) throw new Error("Gemini API error response could not be read safely.");
        throw new Error(`Gemini API request failed: ${safeMessage(error, apiKey)}`);
      } finally { clearTimeout(timeout); }

      if (deadlineExpired()) {
        context.dispatchBlockedByTimeout = true;
        try { await settleAttempt({ kind: "transport_ambiguous", reason: "timeout", evidence: {
          failureClass: "timeout", httpStatus: response?.status ?? null, accountingError: telemetryObservationFailed, observedAt: observedAt(),
        } }); }
        catch { throw new Error("Gemini request outcome is ambiguous, and its durable ambiguity state could not be verified safely."); }
        if (batchContext) batchContext.attempts.push({ ordinal: attempt as 1 | 2 | 3, failureClass: "timeout",
          httpStatus: response?.status ?? null, accountingError: false, accountingOutcome: "transport_ambiguous", elapsedMs: timeoutMs });
        throw new Error("Gemini request timed out after 90 seconds.");
      }

      if (!response.ok) {
        const body = errorBody ?? "";
        const parsed = parsedErrorBody;
        const message = errorMessage(body, parsed, apiKey);
        const failureClass = classifyGeminiHttpFailure(response.status, parsed, model);
        const providerFailureClass: GeminiProviderFailureClass | undefined = isReviewedGeminiProviderFailure(failureClass)
          ? failureClass
          : undefined;
        const zeroUsageIsConfirmed = providerFailureClass !== undefined;

        if (!zeroUsageIsConfirmed) {
          await settleAttempt({ kind: "transport_ambiguous", reason: "response_usage_unavailable", evidence: {
            failureClass, httpStatus: response.status, accountingError: telemetryObservationFailed, observedAt: observedAt(),
          } });
          if (batchContext) batchContext.attempts.push({ ordinal: attempt as 1 | 2 | 3, failureClass,
            httpStatus: response.status, accountingError: false, accountingOutcome: "transport_ambiguous",
            elapsedMs: Math.min(timeoutMs, Math.max(0, Math.trunc(monotonicNow() - deadlineStartedAt))) });
          throw new Error(`Gemini API request failed with unconfirmed usage: HTTP ${response.status} ${response.statusText}: ${message}`);
        }
        try { await settleAttempt({ kind: "confirmed_zero", evidence: {
          failureClass, httpStatus: response.status, accountingError: telemetryObservationFailed, observedAt: observedAt(),
        } }); }
        catch {
          if (batchContext) batchContext.attempts.push({ ordinal: attempt as 1 | 2 | 3, failureClass, providerFailureClass,
            httpStatus: response.status, accountingError: true, accountingOutcome: "transport_ambiguous",
            elapsedMs: Math.min(timeoutMs, Math.max(0, Math.trunc(monotonicNow() - deadlineStartedAt))) });
          throw new Error("Gemini request failed, and the confirmed-zero attempt could not be recorded safely.");
        }

        if (batchContext) {
          batchContext.attempts.push({ ordinal: attempt as 1 | 2 | 3, failureClass, providerFailureClass,
            httpStatus: response.status, accountingError: false,
            accountingOutcome: "confirmed_zero", elapsedMs: Math.min(timeoutMs, Math.max(0, Math.trunc(monotonicNow() - deadlineStartedAt))) });
          if (telemetryObservationFailed) {
            batchContext.retrySkipReason = "accounting";
            throw new Error("Gemini provider outcome was settled, but dispatch telemetry could not be recorded safely.");
          }
          if (providerFailureClass === "unavailable_503" && attempt < MAX_GEMINI_BATCH_DISPATCHES) {
            batchContext.retryEligible = true;
            const delay = attempt === 1
              ? 1_500 + Math.floor(Math.min(1, Math.max(0, random())) * 500)
              : 3_000 + Math.floor(Math.min(1, Math.max(0, random())) * 1_000);
            if (monotonicNow() - deadlineStartedAt + delay > batchCutoffMs - 10_000) {
              batchContext.retrySkipReason = "budget";
              if (dependencies.attemptTelemetry && attemptRef) await dependencies.attemptTelemetry.repository.recordRetryDecision(attemptRef, "stop", "deadline");
              throw new GeminiReviewedProviderFailureError(
                `Gemini API request failed: HTTP ${response.status} ${response.statusText}: ${message}`,
                providerFailureClass,
              );
            }
            if (dependencies.attemptTelemetry && attemptRef) await dependencies.attemptTelemetry.repository.recordRetryDecision(attemptRef, "retry", "retryable_503");
            await sleepImplementation(delay);
            if (monotonicNow() - deadlineStartedAt > batchCutoffMs - 10_000) {
              batchContext.retrySkipReason = "budget";
              throw new GeminiReviewedProviderFailureError(
                `Gemini API request failed: HTTP ${response.status} ${response.statusText}: ${message}`,
                providerFailureClass,
              );
            }
            batchContext.retryAttempted = true;
            continue;
          }
          if (dependencies.attemptTelemetry && attemptRef) await dependencies.attemptTelemetry.repository.recordRetryDecision(
            attemptRef, "stop", providerFailureClass === "unavailable_503" ? "max_attempts" : "non_retryable");
          batchContext.retrySkipReason = providerFailureClass === "unavailable_503" ? "exhausted" : "not_eligible";
        }

        if (!batchContext && providerFailureClass === "unavailable_503") {
          if (attempt < maxAttemptsPerModel) { await sleep(retryDelayMs); continue; }
          if (modelIndex < models.length - 1) { context.fallbacks += 1; break; }
        } else if (!batchContext && providerFailureClass === "resource_exhausted_429" && modelIndex < models.length - 1) {
          context.fallbacks += 1;
          break;
        }
        throw new GeminiReviewedProviderFailureError(
          `Gemini API request failed: HTTP ${response.status} ${response.statusText}: ${message}`,
          providerFailureClass,
        );
      }

      if (!geminiResponse) {
        await settleAttempt({ kind: "transport_ambiguous", reason: "response_usage_unavailable", evidence: {
          failureClass: "response_invalid", httpStatus: response.status, accountingError: telemetryObservationFailed, observedAt: observedAt(),
        } });
        throw new Error("Gemini response was not valid JSON.");
      }

      let usage: LlmResult["usage"];
      try { usage = usageOf(geminiResponse.usage); }
      catch {
        await settleAttempt({ kind: "transport_ambiguous", reason: "response_usage_unavailable", evidence: {
          failureClass: "response_invalid", httpStatus: response.status, accountingError: telemetryObservationFailed, observedAt: observedAt(),
        } });
        throw new Error("Gemini response did not include valid token usage.");
      }
      const { thoughtTokens: _thoughtTokens, ...trackedUsage } = usage;
      try {
        await settleAttempt({ kind: "exact", usage: trackedUsage, evidence: {
          failureClass: "none", httpStatus: response.status, accountingError: telemetryObservationFailed, observedAt: observedAt(),
        } });
      } catch (error) {
        if (dependencies.attemptTelemetry) throw new Error("Gemini request succeeded, but its usage and attempt evidence could not be recorded safely.");
        if (batchContext) batchContext.attempts.push({ ordinal: attempt as 1 | 2 | 3, failureClass: "accounting_failure",
          httpStatus: response.status, accountingError: true, accountingOutcome: "transport_ambiguous",
          elapsedMs: Math.min(timeoutMs, Math.max(0, Math.trunc(monotonicNow() - deadlineStartedAt))) });
        throw error;
      }
      if (telemetryObservationFailed) throw new Error("Gemini request succeeded, but dispatch telemetry could not be recorded safely.");
      if (batchContext) batchContext.attempts.push({ ordinal: attempt as 1 | 2 | 3, failureClass: "none",
        httpStatus: response.status, accountingError: false, accountingOutcome: "exact",
        elapsedMs: Math.min(timeoutMs, Math.max(0, Math.trunc(monotonicNow() - deadlineStartedAt))) });

      console.info("[INFO] Gemini request completed.");
      console.info(`[INFO] Gemini tokens used: ${usage.totalTokens}`);
      return { outputText: outputTextOf(geminiResponse), usage, usedFallback: modelIndex > 0 };
    }
  }
  throw new Error("Gemini request failed after exhausting the approved model pool.");
}
