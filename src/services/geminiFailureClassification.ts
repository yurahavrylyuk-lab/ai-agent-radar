import type { ApprovedGeminiModel } from "../config/geminiModels.js";
import type { GeminiFailureClass, GeminiProviderFailureClass } from "../types/index.js";

export const GEMINI_FAILURE_CLASSES = [
  "none",
  "unavailable_503",
  "resource_exhausted_429",
  "unclassified_http_error",
  "timeout",
  "transport_error",
  "response_invalid",
  "accounting_failure",
] as const satisfies readonly GeminiFailureClass[];

export function isGeminiFailureClass(value: unknown): value is GeminiFailureClass {
  return typeof value === "string" && (GEMINI_FAILURE_CLASSES as readonly string[]).includes(value);
}

interface GeminiErrorEnvelope {
  error?: { status?: unknown; details?: unknown };
}

function asEnvelope(value: unknown): GeminiErrorEnvelope | undefined {
  return value !== null && typeof value === "object" ? value as GeminiErrorEnvelope : undefined;
}

function isUnavailable(status: number, parsed: GeminiErrorEnvelope | undefined): boolean {
  const providerStatus = parsed?.error?.status;
  return status === 503 && (providerStatus === undefined || providerStatus === "UNAVAILABLE");
}

function isModelSpecificQuotaFailure(parsed: GeminiErrorEnvelope | undefined, model: ApprovedGeminiModel): boolean {
  if (parsed?.error?.status !== "RESOURCE_EXHAUSTED" || !Array.isArray(parsed.error.details) || parsed.error.details.length === 0) return false;
  let quotaFailureFound = false;
  for (const detail of parsed.error.details) {
    if (!detail || typeof detail !== "object") return false;
    const value = detail as Record<string, unknown>;
    const detailType = value["@type"];
    if (detailType === "type.googleapis.com/google.rpc.Help" || detailType === "type.googleapis.com/google.rpc.RetryInfo") continue;
    if (detailType !== "type.googleapis.com/google.rpc.QuotaFailure" || !Array.isArray(value.violations) || value.violations.length === 0) return false;
    quotaFailureFound = true;
    if (!value.violations.every((violation) => {
      if (!violation || typeof violation !== "object") return false;
      const item = violation as Record<string, unknown>;
      const dimensions = item.quotaDimensions;
      const identity = item.quotaMetric ?? item.quotaId;
      return typeof identity === "string" && identity.trim().length > 0 && !!dimensions && typeof dimensions === "object" &&
        (dimensions as Record<string, unknown>).model === model;
    })) return false;
  }
  return quotaFailureFound;
}

/** Classifies only reviewed structured evidence; provider prose is never inspected or returned. */
export function classifyGeminiHttpFailure(
  status: number,
  parsed: unknown,
  model: ApprovedGeminiModel,
): GeminiFailureClass {
  const envelope = asEnvelope(parsed);
  if (isUnavailable(status, envelope)) return "unavailable_503";
  if (status === 429 && isModelSpecificQuotaFailure(envelope, model)) return "resource_exhausted_429";
  return "unclassified_http_error";
}

export function isReviewedGeminiProviderFailure(value: GeminiFailureClass): value is GeminiProviderFailureClass {
  return value === "unavailable_503" || value === "resource_exhausted_429";
}
