import type { ThreadsQueryId } from "../types/index.js";

export const THREADS_ENDPOINT = "https://graph.threads.com/v1.0/keyword_search";

export const THREADS_QUERIES: readonly { id: ThreadsQueryId; query: string }[] = Object.freeze([
  { id: "ai_agents", query: "AI agents" },
  { id: "claude_code", query: "Claude Code" },
  { id: "codex", query: "Codex" },
]);

export const THREADS_LIMITS = Object.freeze({
  requestsPerCycle: 3,
  positionsPerQuery: 5,
  observationsPerCycle: 15,
  requestTimeoutMs: 3_000,
  collectorBudgetMs: 9_000,
  successBodyBytes: 131_072,
  errorBodyBytes: 8_192,
  freshnessSeconds: 259_200,
  urlBytes: 2_048,
  textBytes: 8_192,
  postIdCharacters: 64,
  titleBytes: 256,
  snippetBytes: 768,
  rotationWarningMs: 7 * 24 * 60 * 60 * 1_000,
});
