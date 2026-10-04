import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDiscoveryTopics,
  compareDiscoveryPriority,
  getPreAnalysisCandidatePriority,
  getDiscoveryPriorityScore,
  MAX_DISCOVERY_PRIORITY_SCORE,
  MAX_PREFERRED_PRE_ANALYSIS_CANDIDATES,
  PREFERRED_AI_CODING_TOOL_BONUS,
} from "../src/services/discoveryPriority.js";
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
