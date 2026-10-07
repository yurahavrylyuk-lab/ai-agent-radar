import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDiscoveryTopics,
  compareDiscoveryPriority,
  getPreAnalysisCandidatePriority,
  getDiscoveryPriorityScore,
  MAX_DISCOVERY_PRIORITY_SCORE,
  MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES,
  MAX_OFFICIAL_PRE_ANALYSIS_CANDIDATES,
  PREFERRED_AI_CODING_TOOL_BONUS,
  hasOfficialPreAnalysisPriority,
  selectPreAnalysisCandidates,
} from "../src/services/discoveryPriority.js";
import { DISCOVERY_QUERY_DESCRIPTORS } from "../src/config/discoveryQueries.js";
import { isNotificationEligible } from "../src/services/notificationEligibility.js";
import type { AgentAnalysis, StoredDiscovery } from "../src/types/index.js";

function analysis(overrides: Partial<AgentAnalysis> = {}): AgentAnalysis {
  return {
    name: "Useful development release",
    category: "developer_tool",
    summary: "A useful release for software projects.",
    relevanceScore: 7,
    whyItMatters: "It has practical value.",
    educationalValue: "The release can be studied and applied.",
    projectOpportunities: ["Build a learning project"],
    technologies: ["TypeScript"],
    sourceTitle: "Useful development release",
    sourceUrl: "https://example.com/release",
    ...overrides,
  };
}

test("a relevant Codex article scores above an equivalent generic developer-tool article", () => {
  const generic = analysis({ name: "Developer CLI release" });
  const codex = analysis({ name: "Codex CLI release" });
  assert.equal(PREFERRED_AI_CODING_TOOL_BONUS, 1);
  assert.equal(getDiscoveryPriorityScore(generic), 7);
  assert.equal(getDiscoveryPriorityScore(codex), 8);
});

test("a relevant Claude Code article scores above an equivalent generic programming article", () => {
  const generic = analysis({ category: "major_update", name: "Programming language update" });
  const claudeCode = analysis({ category: "major_update", name: "Claude Code update" });
  assert.equal(getDiscoveryPriorityScore(generic), 7);
  assert.equal(getDiscoveryPriorityScore(claudeCode), 8);
});

test("generic AI, IT, programming, and developer-workflow topics remain classified", () => {
  assert.deepEqual(classifyDiscoveryTopics(analysis({ summary: "A large language model release for AI agents." })), ["ai_ml"]);
  assert.deepEqual(classifyDiscoveryTopics(analysis({ summary: "A Kubernetes security advisory for cloud platforms." })), ["it_infrastructure"]);
  assert.deepEqual(classifyDiscoveryTopics(analysis({ summary: "A programming language release with compiler updates." })), ["programming"]);
  assert.deepEqual(classifyDiscoveryTopics(analysis({ summary: "An IDE and CI/CD code review tool update." })), ["developer_tools_workflow"]);
});

test("preferred keywords cannot make low-relevance content eligible or raise its score", () => {
  const irrelevantCodexMention = analysis({
    name: "Codex-branded merchandise sale",
    summary: "A retail promotion unrelated to AI or software development.",
    relevanceScore: 2,
  });
  assert.equal(getPreAnalysisCandidatePriority({
    title: irrelevantCodexMention.name,
    snippet: irrelevantCodexMention.summary,
    url: irrelevantCodexMention.sourceUrl,
  }), 1);
  assert.equal(getDiscoveryPriorityScore(irrelevantCodexMention), 2);
  assert.equal(isNotificationEligible({
    status: "new",
    discovery: {
      normalizedUrl: irrelevantCodexMention.sourceUrl,
      firstSeenAt: "2026-10-04T00:00:00.000Z",
      lastSeenAt: "2026-10-04T00:00:00.000Z",
      analysis: irrelevantCodexMention,
    },
  }), false);
});

test("pre-analysis priority requires explicit Codex or Claude Code wording", () => {
  assert.equal(MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES, 2);
  assert.equal(getPreAnalysisCandidatePriority({ title: "Codex release", url: "https://example.com/codex" }), 1);
  assert.equal(getPreAnalysisCandidatePriority({ title: "Claude Code release", url: "https://example.com/claude-code" }), 1);
  assert.equal(getPreAnalysisCandidatePriority({ title: "Claude developer release", url: "https://example.com/claude" }), 0);
  assert.equal(getPreAnalysisCandidatePriority({ title: "Generic CLI release", url: "https://example.com/cli" }), 0);
});

test("priority scores remain capped at ten", () => {
  assert.equal(MAX_DISCOVERY_PRIORITY_SCORE, 10);
  assert.equal(getDiscoveryPriorityScore(analysis({ name: "Codex release", relevanceScore: 10 })), 10);
  assert.equal(getDiscoveryPriorityScore(analysis({ name: "Claude Code release", relevanceScore: 9 })), 10);
});

test("preferred tools win an otherwise equal relevance-10 ordering tie", () => {
  const stored = (item: AgentAnalysis): StoredDiscovery => ({
    normalizedUrl: item.sourceUrl,
    firstSeenAt: "2026-10-04T00:00:00.000Z",
    lastSeenAt: "2026-10-04T00:00:00.000Z",
    analysis: item,
  });
  const generic = stored(analysis({ name: "Developer tool release", relevanceScore: 10 }));
  const codex = stored(analysis({ name: "Codex release", relevanceScore: 10 }));
  assert.ok(compareDiscoveryPriority(codex, generic) < 0);
});

test("official priority requires the matching targeted host and a valid recent provider age", () => {
  const openai = DISCOVERY_QUERY_DESCRIPTORS[0];
  const now = new Date("2026-10-10T08:00:00.000Z");
  assert.equal(hasOfficialPreAnalysisPriority({ title: "Introducing GPT-6.1 Sol", url: "https://openai.com/index/test-gpt-6-1-sol/", publishedAt: "2026-10-08T08:00:00Z" }, openai, now), true);
  assert.equal(hasOfficialPreAnalysisPriority({ title: "Seven-day boundary", url: "https://openai.com/boundary", publishedAt: "2026-10-03T08:00:00Z" }, openai, now), true);
  assert.equal(hasOfficialPreAnalysisPriority({ title: "Off host", url: "https://example.test/openai.com", publishedAt: "2026-10-08T08:00:00Z" }, openai, now), false);
  assert.equal(hasOfficialPreAnalysisPriority({ title: "Credentialed", url: "https://user:pass@openai.com/private", publishedAt: "2026-10-08T08:00:00Z" }, openai, now), false);
  assert.equal(hasOfficialPreAnalysisPriority({ title: "Non-default port", url: "https://openai.com:8080/private", publishedAt: "2026-10-08T08:00:00Z" }, openai, now), false);
  assert.equal(hasOfficialPreAnalysisPriority({ title: "Too old", url: "https://openai.com/old", publishedAt: "2026-10-03T07:59:59Z" }, openai, now), false);
  assert.equal(hasOfficialPreAnalysisPriority({ title: "No date", url: "https://openai.com/no-date" }, openai, now), false);
  assert.equal(hasOfficialPreAnalysisPriority({ title: "Future", url: "https://openai.com/future", publishedAt: "2026-10-10T08:00:01Z" }, openai, now), false);
});

test("official discovery provenance does not change Gemini relevance or notification eligibility", () => {
  const officialLowRelevance = analysis({
    name: "OpenAI release",
    relevanceScore: 2,
    sourceUrl: "https://openai.com/example",
  });
  assert.equal(getDiscoveryPriorityScore(officialLowRelevance), 2);
  assert.equal(isNotificationEligible({
    status: "new",
    discovery: {
      normalizedUrl: officialLowRelevance.sourceUrl,
      firstSeenAt: "2026-10-04T00:00:00.000Z",
      lastSeenAt: "2026-10-04T00:00:00.000Z",
      analysis: officialLowRelevance,
    },
  }), false);
});

test("P5 reserves one recent targeted official opportunity after two P3 slots", () => {
  const selected = selectPreAnalysisCandidates([
    { value: "codex", normalizedUrl: "codex", preferred: true, officialPriority: false },
    { value: "claude", normalizedUrl: "claude", preferred: true, officialPriority: false },
    { value: "official-one", normalizedUrl: "official-one", preferred: false, officialPriority: true },
    { value: "official-two", normalizedUrl: "official-two", preferred: false, officialPriority: true },
    { value: "generic", normalizedUrl: "generic", preferred: false, officialPriority: false },
  ]);
  assert.equal(MAX_OFFICIAL_PRE_ANALYSIS_CANDIDATES, 1);
  assert.deepEqual(selected, ["codex", "claude", "official-one", "official-two"]);
});

test("an empty official lane returns capacity to normal stable ranking", () => {
  const selected = selectPreAnalysisCandidates([
    { value: "generic-one", normalizedUrl: "generic-one", preferred: false, officialPriority: false },
    { value: "generic-two", normalizedUrl: "generic-two", preferred: false, officialPriority: false },
    { value: "generic-three", normalizedUrl: "generic-three", preferred: false, officialPriority: false },
    { value: "generic-four", normalizedUrl: "generic-four", preferred: false, officialPriority: false },
    { value: "generic-five", normalizedUrl: "generic-five", preferred: false, officialPriority: false },
  ]);
  assert.deepEqual(selected, ["generic-one", "generic-two", "generic-three", "generic-four"]);
});
