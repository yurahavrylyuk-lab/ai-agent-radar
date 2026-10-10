import { APPROVED_GEMINI_MODELS, type ApprovedGeminiModel } from "../../config/geminiModels.js";
import { checkGeminiUsage } from "../../services/geminiUsageGuard.js";
import { areGeminiTimestampsInSameUtcWindows } from "../../services/geminiAccountingWindows.js";
import type { GeminiAmbiguityReason, GeminiUsageReservation, GeminiUsageStore } from "../../services/geminiUsageTracker.js";
import type { RuntimeEnvironment } from "../../services/radarRuntimeConfiguration.js";
import type { LlmResult } from "./types.js";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_TIMEOUT_MS = 90_000;
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

export interface GeminiDependencies {
  usageTracker?: GeminiUsageStore;
  environment?: RuntimeEnvironment;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  cycleContext?: GeminiCycleContext;
  now?: () => Date;
  /** Deterministic offline hook at the final handoff before fetch; production leaves this unset. */
  beforeDispatch?: (reservation: GeminiUsageReservation) => void | Promise<void>;
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

function isUnavailable(status: number, parsed: GeminiErrorBody | undefined): boolean {
  const providerStatus = parsed?.error?.status;
  return status === 503 && (providerStatus === undefined || providerStatus === "UNAVAILABLE");
}

function isModelSpecificQuotaFailure(parsed: GeminiErrorBody | undefined, model: ApprovedGeminiModel): boolean {
  if (parsed?.error?.status !== "RESOURCE_EXHAUSTED" || !Array.isArray(parsed.error.details) || parsed.error.details.length === 0) return false;
  let quotaFailureFound = false;
  for (const detail of parsed.error.details) {
    if (!detail || typeof detail !== "object") return false;
    const value = detail as Record<string, unknown>;
    const detailType = value["@type"];
    if (detailType === "type.googleapis.com/google.rpc.Help" || detailType === "type.googleapis.com/google.rpc.RetryInfo") continue;
    if (detailType !== "type.googleapis.com/google.rpc.QuotaFailure" || !Array.isArray(value.violations) || value.violations.length === 0) return false;
    quotaFailureFound = true;
    const violationsAreModelSpecific = value.violations.every((violation) => {
      if (!violation || typeof violation !== "object") return false;
      const item = violation as Record<string, unknown>;
      const dimensions = item.quotaDimensions;
      const identity = item.quotaMetric ?? item.quotaId;
      return typeof identity === "string" && identity.trim().length > 0 && !!dimensions && typeof dimensions === "object" &&
        (dimensions as Record<string, unknown>).model === model;
    });
    if (!violationsAreModelSpecific) return false;
  }
  return quotaFailureFound;
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

export async function generateWithGemini(input: string, dependencies: GeminiDependencies = {}): Promise<LlmResult> {
  const environment = dependencies.environment ?? process.env;
  const apiKey = requiredApiKey(environment);
  const tracker = dependencies.usageTracker;
  if (!tracker) throw new Error("Gemini usage tracker is required.");
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const retryDelayMs = dependencies.retryDelayMs ?? GEMINI_503_DELAY_MS;
  const context = dependencies.cycleContext ?? createGeminiCycleContext();
  const now = dependencies.now ?? (() => new Date());
  const maxAttemptsPerModel = GEMINI_503_MAX_RETRIES + 1;

  if (context.dispatchBlockedByTimeout) {
    throw new Error("Gemini requests stopped for this cycle after a timeout.");
  }

  for (const [modelIndex, model] of APPROVED_GEMINI_MODELS.entries()) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      const usageCheck = await checkGeminiUsage(tracker, environment, now());
      if (!usageCheck.allowed) throw new Error("Gemini request blocked by usage guard.");
      initializeFrozenAllowance(context, usageCheck);
      if ((context.remainingRequests ?? 0) <= 0) throw new Error("Gemini request blocked by frozen cycle request allowance.");

      let reservation: Awaited<ReturnType<GeminiUsageStore["reserveRequest"]>>;
      try {
        reservation = await tracker.reserveRequest({
          timestamp: now().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1,
          inputTokens: 0, outputTokens: 0, totalTokens: 0, model,
        }, { limits: usageCheck.limits, cycleRequestsRemaining: context.remainingRequests ?? 0 });
      } catch { throw new Error("Gemini request could not be reserved safely."); }

      context.remainingRequests = (context.remainingRequests ?? 1) - 1;
      context.providerAttempts += 1;
      context.requestsByModel[model] += 1;

      if (!areGeminiTimestampsInSameUtcWindows(reservation.record.timestamp, now())) {
        await preserveAmbiguity(tracker, reservation, "abandoned_reservation");
        throw new Error("Gemini request was not dispatched because its accounting window changed after reservation.");
      }

      await dependencies.beforeDispatch?.(reservation);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? GEMINI_TIMEOUT_MS);
      let response: Response | undefined;
      let errorBody: string | undefined;
      let parsedErrorBody: GeminiErrorBody | undefined;
      let geminiResponse: GeminiResponse | undefined;
      try {
        response = await fetchImplementation(GEMINI_INTERACTIONS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ model, input }),
          signal: controller.signal,
        });
        if (response.ok) {
          const body = await response.text();
          geminiResponse = JSON.parse(body) as GeminiResponse;
        } else {
          errorBody = (await response.text()).slice(0, 10_000);
          parsedErrorBody = parseErrorBody(errorBody);
        }
      } catch (error) {
        const reason: GeminiAmbiguityReason = controller.signal.aborted
          ? "timeout"
          : response === undefined ? "network_error" : "response_usage_unavailable";
        if (reason === "timeout") context.dispatchBlockedByTimeout = true;
        await preserveAmbiguity(tracker, reservation, reason);
        if (controller.signal.aborted) throw new Error("Gemini request timed out after 90 seconds.");
        if (response?.ok) throw new Error("Gemini response was not valid JSON.");
        if (response !== undefined) throw new Error("Gemini API error response could not be read safely.");
        throw new Error(`Gemini API request failed: ${safeMessage(error, apiKey)}`);
      } finally { clearTimeout(timeout); }

      if (!response.ok) {
        const body = errorBody ?? "";
        const parsed = parsedErrorBody;
        const message = errorMessage(body, parsed, apiKey);
        const zeroUsageIsConfirmed = isUnavailable(response.status, parsed) ||
          (response.status === 429 && isModelSpecificQuotaFailure(parsed, model));

        if (!zeroUsageIsConfirmed) {
          await preserveAmbiguity(tracker, reservation, "response_usage_unavailable");
          throw new Error(`Gemini API request failed with unconfirmed usage: HTTP ${response.status} ${response.statusText}: ${message}`);
        }
        try { await tracker.confirmZeroRequest(reservation); }
        catch { throw new Error("Gemini request failed, and the confirmed-zero attempt could not be recorded safely."); }

        if (isUnavailable(response.status, parsed)) {
          if (attempt < maxAttemptsPerModel) { await sleep(retryDelayMs); continue; }
          if (modelIndex < APPROVED_GEMINI_MODELS.length - 1) { context.fallbacks += 1; break; }
        } else if (response.status === 429 && isModelSpecificQuotaFailure(parsed, model) && modelIndex < APPROVED_GEMINI_MODELS.length - 1) {
          context.fallbacks += 1;
          break;
        }
        throw new Error(`Gemini API request failed: HTTP ${response.status} ${response.statusText}: ${message}`);
      }

      if (!geminiResponse) {
        await preserveAmbiguity(tracker, reservation, "response_usage_unavailable");
        throw new Error("Gemini response was not valid JSON.");
      }

      let usage: LlmResult["usage"];
      try { usage = usageOf(geminiResponse.usage); }
      catch {
        await preserveAmbiguity(tracker, reservation, "response_usage_unavailable");
        throw new Error("Gemini response did not include valid token usage.");
      }
      const { thoughtTokens: _thoughtTokens, ...trackedUsage } = usage;
      await settleExactUsage(tracker, reservation, trackedUsage,
        "Gemini request succeeded, but its usage could not be recorded safely.");

      console.info("[INFO] Gemini request completed.");
      console.info(`[INFO] Gemini tokens used: ${usage.totalTokens}`);
      return { outputText: outputTextOf(geminiResponse), usage, usedFallback: modelIndex > 0 };
    }
  }
  throw new Error("Gemini request failed after exhausting the approved model pool.");
}
