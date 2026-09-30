import { checkGeminiUsage } from "../../services/geminiUsageGuard.js";
import type { GeminiUsageStore } from "../../services/geminiUsageTracker.js";
import type { RuntimeEnvironment } from "../../services/radarRuntimeConfiguration.js";
import type { LlmResult } from "./types.js";

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_TIMEOUT_MS = 30_000;
const GEMINI_503_MAX_RETRIES = 3;
const GEMINI_503_DELAY_MS = 5_000;

interface GeminiResponse {
  output_text?: string;
  steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    total_tokens?: number;
  };
}

export interface GeminiDependencies {
  usageTracker?: GeminiUsageStore;
  environment?: RuntimeEnvironment;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function required(name: "GEMINI_API_KEY" | "GEMINI_MODEL", environment: RuntimeEnvironment): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is not configured. Add it to your .env file.`);
  return value;
}

function usageOf(usage: GeminiResponse["usage"]): LlmResult["usage"] {
  const inputTokens = usage?.total_input_tokens;
  const outputTokens = usage?.total_output_tokens;
  const totalTokens = usage?.total_tokens;
  const thoughtTokens = usage?.total_thought_tokens;
  const requiredCounts = [inputTokens, outputTokens, totalTokens];

  if (!requiredCounts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) ||
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
  return message.replaceAll(apiKey, "[REDACTED]");
}

async function safeErrorMessage(response: Response, apiKey: string): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; status?: unknown } };
    const message = parsed.error?.message ?? parsed.error?.status;
    if (typeof message === "string" && message) return safeMessage(message, apiKey);
  } catch {
    // Fall through to the safely bounded raw response body.
  }
  return safeMessage(body.slice(0, 1_000) || "No response body returned.", apiKey);
}

export async function generateWithGemini(input: string, dependencies: GeminiDependencies = {}): Promise<LlmResult> {
  const environment = dependencies.environment ?? process.env;
  const apiKey = required("GEMINI_API_KEY", environment);
  const model = required("GEMINI_MODEL", environment);
  const tracker = dependencies.usageTracker;
  if (!tracker) throw new Error("Gemini usage tracker is required.");
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const retryDelayMs = dependencies.retryDelayMs ?? GEMINI_503_DELAY_MS;

  if (!(await checkGeminiUsage(tracker, environment)).allowed) throw new Error("Gemini request blocked by usage guard.");

  const maxAttempts = GEMINI_503_MAX_RETRIES + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
      if (controller.signal.aborted) throw new Error("Gemini request timed out after 30 seconds.");
      throw new Error(`Gemini API request failed: ${safeMessage(error, apiKey)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // Every completed HTTP response records requestCount exactly once.
      // Failed responses have no trustworthy usage data so token counts are zero.
      try {
        await tracker.recordRequest({ timestamp: new Date().toISOString(), provider: "gemini", operation: "minimal-test", requestCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      } catch {
        throw new Error("Gemini request failed, and the failed attempt could not be recorded safely.");
      }

      // 503 is the only retryable error. Retry up to GEMINI_503_MAX_RETRIES times.
      if (response.status === 503 && attempt < maxAttempts) {
        await sleep(retryDelayMs);
        continue;
      }

      const message = await safeErrorMessage(response, apiKey);
      throw new Error(`Gemini API request failed: HTTP ${response.status} ${response.statusText}: ${message}`);
    }

    let geminiResponse: GeminiResponse;
    try {
      geminiResponse = await response.json() as GeminiResponse;
    } catch {
      try { await tracker.markUsageUnknown(); } catch {}
      throw new Error("Gemini response was not valid JSON.");
    }

    let usage: LlmResult["usage"];
    try {
      usage = usageOf(geminiResponse.usage);
    } catch (error) {
      try { await tracker.markUsageUnknown(); } catch {}
      throw error;
    }

    try {
      const { thoughtTokens: _thoughtTokens, ...trackedUsage } = usage;
      await tracker.recordRequest({ timestamp: new Date().toISOString(), provider: "gemini", operation: "minimal-test", requestCount: 1, ...trackedUsage });
    } catch {
      throw new Error("Gemini request succeeded, but its usage could not be recorded safely.");
    }

    console.info("[INFO] Gemini request completed.");
    console.info(`[INFO] Gemini tokens used: ${usage.totalTokens}`);
    return { outputText: outputTextOf(geminiResponse), usage };
  }

  // Unreachable at runtime: the loop always returns or throws before exhausting all attempts.
  // Required by TypeScript because it cannot prove the loop body always diverges.
  throw new Error("Gemini request failed after maximum retries.");
}
