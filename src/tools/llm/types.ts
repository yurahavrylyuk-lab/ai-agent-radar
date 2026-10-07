export interface LlmResult {
  outputText: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; thoughtTokens?: number };
  /** Provider-neutral signal consumed only after domain validation succeeds. */
  usedFallback?: boolean;
}
