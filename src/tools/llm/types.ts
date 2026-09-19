export interface LlmResult {
  outputText: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; thoughtTokens?: number };
}
