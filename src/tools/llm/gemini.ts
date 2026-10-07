import { APPROVED_GEMINI_MODELS, type ApprovedGeminiModel } from "../../config/geminiModels.js";
import { checkGeminiUsage } from "../../services/geminiUsageGuard.js";
import type { GeminiUsageStore } from "../../services/geminiUsageTracker.js";
import type { RuntimeEnvironment } from "../../services/radarRuntimeConfiguration.js";
import type { LlmResult } from "./types.js";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_TIMEOUT_MS = 30_000;
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
  providerAttempts: number;
  fallbacks: number;
  analysesUsingFallbackModel: number;
  requestsByModel: Record<ApprovedGeminiModel, number>;
}

export function createGeminiCycleContext(): GeminiCycleContext {
  return {
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
  return parsed.error.details.every((detail) => {
    if (!detail || typeof detail !== "object") return false;
    const value = detail as Record<string, unknown>;
    if (value["@type"] !== "type.googleapis.com/google.rpc.QuotaFailure" || !Array.isArray(value.violations) || value.violations.length === 0) return false;
    return value.violations.every((violation) => {
      if (!violation || typeof violation !== "object") return false;
      const item = violation as Record<string, unknown>;
      const dimensions = item.quotaDimensions;
      const identity = item.quotaMetric ?? item.quotaId;
      return typeof identity === "string" && identity.length > 0 && !!dimensions && typeof dimensions === "object" &&
        (dimensions as Record<string, unknown>).model === model;
    });
  });
}

function initializeFrozenAllowance(context: GeminiCycleContext, check: Awaited<ReturnType<typeof checkGeminiUsage>>): void {
  if (!check.allowed || context.remainingRequests !== undefined) return;
  context.remainingRequests = Math.min(
    check.limits.dailyRequests - check.counts.dailyRequests,
    check.limits.weeklyRequests - check.counts.weeklyRequests,
    check.limits.monthlyRequests - check.counts.monthlyRequests,
  );
}

async function settleUsage(
  tracker: GeminiUsageStore,
  reservation: Awaited<ReturnType<GeminiUsageStore["reserveRequest"]>>,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number },
  message: string,
): Promise<void> {
  try { await tracker.settleRequest(reservation, usage); } catch { throw new Error(message); }
}

export async function generateWithGemini(input: string, dependencies: GeminiDependencies = {}): Promise<LlmResult> {
  const environment = dependencies.environment ?? process.env;
  const apiKey = requiredApiKey(environment);
  const tracker = dependencies.usageTracker;
  if (!tracker) throw new Error("Gemini usage tracker is required.");
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const retryDelayMs = dependencies.retryDelayMs ?? GEMINI_503_DELAY_MS;
  const context = dependencies.cycleContext ?? createGeminiCycleContext();
  const maxAttemptsPerModel = GEMINI_503_MAX_RETRIES + 1;

  for (const [modelIndex, model] of APPROVED_GEMINI_MODELS.entries()) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      const usageCheck = await checkGeminiUsage(tracker, environment);
      if (!usageCheck.allowed) throw new Error("Gemini request blocked by usage guard.");
      initializeFrozenAllowance(context, usageCheck);
      if ((context.remainingRequests ?? 0) <= 0) throw new Error("Gemini request blocked by frozen cycle request allowance.");

      let reservation: Awaited<ReturnType<GeminiUsageStore["reserveRequest"]>>;
      try {
        reservation = await tracker.reserveRequest({
          timestamp: new Date().toISOString(), provider: "gemini", operation: "analysis", requestCount: 1,
          inputTokens: 0, outputTokens: 0, totalTokens: 0, model,
        });
      } catch { throw new Error("Gemini request could not be reserved safely."); }

      context.remainingRequests = (context.remainingRequests ?? 1) - 1;
      context.providerAttempts += 1;
      context.requestsByModel[model] += 1;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? GEMINI_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImplementation(GEMINI_INTERACTIONS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ model, input }),
          signal: controller.signal,
        });
      } catch (error) {
        // The reservation deliberately remains unknown after an ambiguous transport outcome.
        if (controller.signal.aborted) throw new Error("Gemini request timed out after 30 seconds.");
        throw new Error(`Gemini API request failed: ${safeMessage(error, apiKey)}`);
      } finally { clearTimeout(timeout); }

      if (!response.ok) {
        const body = (await response.text()).slice(0, 10_000);
        const parsed = parseErrorBody(body);
        await settleUsage(tracker, reservation, { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          "Gemini request failed, and the failed attempt could not be recorded safely.");
        const message = errorMessage(body, parsed, apiKey);

        if (isUnavailable(response.status, parsed)) {
          if (attempt < maxAttemptsPerModel) { await sleep(retryDelayMs); continue; }
          if (modelIndex < APPROVED_GEMINI_MODELS.length - 1) { context.fallbacks += 1; break; }
        } else if (response.status === 429 && isModelSpecificQuotaFailure(parsed, model) && modelIndex < APPROVED_GEMINI_MODELS.length - 1) {
          context.fallbacks += 1;
          break;
        }
        throw new Error(`Gemini API request failed: HTTP ${response.status} ${response.statusText}: ${message}`);
      }

      let geminiResponse: GeminiResponse;
      try { geminiResponse = await response.json() as GeminiResponse; }
      catch { throw new Error("Gemini response was not valid JSON."); }

      const usage = usageOf(geminiResponse.usage);
      const { thoughtTokens: _thoughtTokens, ...trackedUsage } = usage;
      await settleUsage(tracker, reservation, trackedUsage,
        "Gemini request succeeded, but its usage could not be recorded safely.");

      console.info("[INFO] Gemini request completed.");
      console.info(`[INFO] Gemini tokens used: ${usage.totalTokens}`);
      return { outputText: outputTextOf(geminiResponse), usage, usedFallback: modelIndex > 0 };
    }
  }
  throw new Error("Gemini request failed after exhausting the approved model pool.");
}
