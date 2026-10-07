import { NOTIFICATION_RELEVANCE_THRESHOLD } from "./notificationEligibility.js";
import type { DiscoveryQueryDescriptor } from "../config/discoveryQueries.js";
import type { AgentAnalysis, SearchResult, StoredDiscovery } from "../types/index.js";

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
export const MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES = 2;
export const MAX_OFFICIAL_PRE_ANALYSIS_CANDIDATES = 1;

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

function containsPreferredTool(value: string): boolean {
  return preferredToolPatterns.some((pattern) => pattern.test(value));
}

/**
 * Returns a small, deterministic pre-analysis signal from Brave result fields.
 * It selects scarce analysis slots only; it never affects notification eligibility.
 */
export function getPreAnalysisCandidatePriority(result: SearchResult): number {
  const candidateText = [result.title, result.snippet ?? "", result.source ?? ""].join("\n");
  return containsPreferredTool(candidateText) ? PREFERRED_AI_CODING_TOOL_BONUS : 0;
}

function canonicalHostname(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.port
    ) return undefined;
    return parsed.hostname.toLowerCase().replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

function parseProviderPageAge(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const dated = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  const calendar = dateOnly ?? dated;
  if (!calendar) return undefined;
  const year = Number(calendar[1]);
  const month = Number(calendar[2]);
  const day = Number(calendar[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return undefined;
  if (!dateOnly && !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const date = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Grants only a bounded pre-analysis opportunity for a recent result observed
 * through its matching targeted official query. It is neither source trust nor
 * a relevance score.
 */
export function hasOfficialPreAnalysisPriority(
  result: SearchResult,
  descriptor: DiscoveryQueryDescriptor,
  cycleStartedAt: Date,
): boolean {
  if (descriptor.kind !== "official" || !descriptor.officialHostnames?.length || Number.isNaN(cycleStartedAt.getTime())) return false;
  const hostname = canonicalHostname(result.url);
  if (!hostname || !descriptor.officialHostnames.includes(hostname)) return false;
  const age = parseProviderPageAge(result.publishedAt);
  if (!age) return false;
  const sevenDaysAgo = cycleStartedAt.getTime() - (7 * 24 * 60 * 60 * 1000);
  return age.getTime() >= sevenDaysAgo && age.getTime() <= cycleStartedAt.getTime();
}

export interface PreAnalysisCandidate<T> {
  readonly value: T;
  readonly normalizedUrl: string;
  readonly preferred: boolean;
  readonly officialPriority: boolean;
}

/** Selects scarce analysis slots while preserving the P3 and P5 bounded lanes. */
export function selectPreAnalysisCandidates<T>(
  candidates: readonly PreAnalysisCandidate<T>[],
  maximum = 4,
): T[] {
  const selected: PreAnalysisCandidate<T>[] = [];
  const select = (candidate: PreAnalysisCandidate<T>) => {
    if (selected.length < maximum && !selected.some(({ normalizedUrl }) => normalizedUrl === candidate.normalizedUrl)) selected.push(candidate);
  };
  const preferred = candidates.filter((candidate) => candidate.preferred);
  const nonPreferred = candidates.filter((candidate) => !candidate.preferred);
  for (const candidate of preferred.slice(0, MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES)) select(candidate);
  for (const candidate of nonPreferred.filter((candidate) => candidate.officialPriority).slice(0, MAX_OFFICIAL_PRE_ANALYSIS_CANDIDATES)) select(candidate);
  for (const candidate of nonPreferred) select(candidate);
  for (const candidate of preferred.slice(MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES)) select(candidate);
  return selected.map(({ value }) => value);
}

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
  return containsPreferredTool(analysisText(analysis));
}

/** Orders eligible digest candidates without mutating their validated analyses. */
export function compareDiscoveryPriority(a: StoredDiscovery, b: StoredDiscovery): number {
  const priorityDifference = getDiscoveryPriorityScore(b.analysis) - getDiscoveryPriorityScore(a.analysis);
  if (priorityDifference !== 0) return priorityDifference;
  const relevanceDifference = b.analysis.relevanceScore - a.analysis.relevanceScore;
  if (relevanceDifference !== 0) return relevanceDifference;
  return Number(hasPreferredTool(b.analysis)) - Number(hasPreferredTool(a.analysis));
}
