import { NOTIFICATION_RELEVANCE_THRESHOLD } from "./notificationEligibility.js";
import type { AgentAnalysis, StoredDiscovery } from "../types/index.js";

export const discoveryTopicTaxonomy = {
  ai_ml: [
    "large language model",
    "AI agent",
    "AI coding assistant",
    "Codex",
    "Claude Code",
    "Gemini",
    "GPT",
    "open-source model",
  ],
  it_infrastructure: [
    "cloud platform",
    "DevOps",
    "Kubernetes",
    "networking",
    "security advisory",
  ],
  programming: [
    "programming language release",
    "compiler update",
    "standard library change",
  ],
  developer_tools_workflow: [
    "IDE",
    "CLI tool",
    "CI/CD",
    "code review tool",
    "productivity tooling",
  ],
} as const;

export type DiscoveryTopic = keyof typeof discoveryTopicTaxonomy;

export const PREFERRED_AI_CODING_TOOL_BONUS = 1;
export const MAX_DISCOVERY_PRIORITY_SCORE = 10;

const topicPatterns: Record<DiscoveryTopic, readonly RegExp[]> = {
  ai_ml: [
    /\blarge language models?\b/i,
    /\bLLMs?\b/,
    /\bAI agents?\b/i,
    /\bAI coding assistants?\b/i,
    /\bCodex\b/i,
    /\bClaude\s+Code\b/i,
    /\bGemini\b/i,
    /\bGPT(?:-?\d[\w.-]*)?\b/i,
    /\bopen[ -]source models?\b/i,
  ],
  it_infrastructure: [
    /\bcloud platforms?\b/i,
    /\bDevOps\b/i,
    /\bKubernetes\b/i,
    /\bnetworking\b/i,
    /\bsecurity (?:advisories|advisory)\b/i,
  ],
  programming: [
    /\bprogramming language releases?\b/i,
    /\blanguage releases?\b/i,
    /\bcompiler updates?\b/i,
    /\bstandard library (?:changes|updates?)\b/i,
  ],
  developer_tools_workflow: [
    /\bIDEs?\b/i,
    /\bCLI tools?\b/i,
    /\bCI\/CD\b/i,
    /\bcode review tools?\b/i,
    /\bproductivity tool(?:ing|s)?\b/i,
    /\bdeveloper tools?\b/i,
    /\bdevelopment workflows?\b/i,
  ],
};

const preferredToolPatterns = [/\bCodex\b/i, /\bClaude\s+Code\b/i] as const;

function analysisText(analysis: AgentAnalysis): string {
  return [
    analysis.name,
    analysis.summary,
    analysis.whyItMatters,
    analysis.educationalValue,
    analysis.sourceTitle,
    ...analysis.projectOpportunities,
    ...analysis.technologies,
  ].join("\n");
}

/** Returns the P3 topic groups explicitly represented in a validated analysis. */
export function classifyDiscoveryTopics(analysis: AgentAnalysis): DiscoveryTopic[] {
  const text = analysisText(analysis);
  return (Object.keys(topicPatterns) as DiscoveryTopic[]).filter((topic) =>
    topicPatterns[topic].some((pattern) => pattern.test(text))
  );
}

/**
 * Produces a bounded digest-ordering score. The preferred-tool bonus is applied
 * only after the normal notification threshold is met, so keywords cannot make
 * low-relevance content eligible.
 */
export function getDiscoveryPriorityScore(analysis: AgentAnalysis): number {
  const baseScore = analysis.relevanceScore;
  if (baseScore < NOTIFICATION_RELEVANCE_THRESHOLD) return baseScore;

  return hasPreferredTool(analysis)
    ? Math.min(MAX_DISCOVERY_PRIORITY_SCORE, baseScore + PREFERRED_AI_CODING_TOOL_BONUS)
    : baseScore;
}

function hasPreferredTool(analysis: AgentAnalysis): boolean {
  return preferredToolPatterns.some((pattern) => pattern.test(analysisText(analysis)));
}

/** Orders eligible digest candidates without mutating their validated analyses. */
export function compareDiscoveryPriority(a: StoredDiscovery, b: StoredDiscovery): number {
  const priorityDifference = getDiscoveryPriorityScore(b.analysis) - getDiscoveryPriorityScore(a.analysis);
  if (priorityDifference !== 0) return priorityDifference;
  const relevanceDifference = b.analysis.relevanceScore - a.analysis.relevanceScore;
  if (relevanceDifference !== 0) return relevanceDifference;
  return Number(hasPreferredTool(b.analysis)) - Number(hasPreferredTool(a.analysis));
}
