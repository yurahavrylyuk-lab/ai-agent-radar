export const APPROVED_GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
] as const;
export const GEMINI_MODEL_POOL_VERSION = 1 as const;

export type ApprovedGeminiModel = (typeof APPROVED_GEMINI_MODELS)[number];

export function isApprovedGeminiModel(value: unknown): value is ApprovedGeminiModel {
  return typeof value === "string"
    && APPROVED_GEMINI_MODELS.includes(value as ApprovedGeminiModel);
}
