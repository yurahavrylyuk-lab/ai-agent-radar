import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { JsonDiscoveryHistory, type DiscoveryHistory } from "../src/services/discoveryHistory.js";
import { processSearchResult } from "../src/services/discoveryProcessor.js";
import type { AgentAnalysis, SearchResult } from "../src/types/index.js";

const firstSeen = new Date("2026-09-19T12:00:00.000Z");
const lastSeen = new Date("2026-09-19T13:00:00.000Z");

function searchResult(url = "https://example.com/discovery"): SearchResult {
  return { title: "Example discovery", url, snippet: "A test discovery." };
}

function analysisFor(result: SearchResult): AgentAnalysis {
  return {
    name: "Example Agent",
    category: "new_agent",
    summary: "A validated analysis.",
    relevanceScore: 8,
    whyItMatters: "It is useful for testing.",
    educationalValue: "It demonstrates processing.",
    projectOpportunities: ["Build a prototype"],
    technologies: ["TypeScript"],
    sourceTitle: result.title,
    sourceUrl: result.url,
  };
}

async function withHistory(callback: (history: JsonDiscoveryHistory) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ai-agent-monitor-processor-"));
  try {
    await callback(new JsonDiscoveryHistory(join(directory, "discovery-history.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("an unseen result calls analysis once, records it, and returns new", async () => {
  await withHistory(async (history) => {
    const result = searchResult();
    let analysisCalls = 0;
    const processed = await processSearchResult(result, {
      history,
      now: () => firstSeen,
      analyze: async (input) => { analysisCalls++; return analysisFor(input); },
    });
    assert.equal(analysisCalls, 1);
    assert.equal(processed.status, "new");
    assert.deepEqual(processed.discovery.analysis, analysisFor(result));
    assert.equal(processed.discovery.analysis.sourceTitle, result.title);
    assert.equal(processed.discovery.analysis.sourceUrl, result.url);
    assert.deepEqual(await history.getDiscovery(result.url), processed.discovery);
  });
});

test("duplicate discovery never calls the Analysis Agent", async () => {
  await withHistory(async (history) => {
    const result = searchResult();
    const original = await history.recordDiscovery(analysisFor(result), firstSeen);
    let analysisCalls = 0;
    const processed = await processSearchResult(result, {
      history,
      now: () => lastSeen,
      analyze: async () => { analysisCalls++; return analysisFor(result); },
    });
    assert.equal(analysisCalls, 0);
    assert.equal(processed.status, "duplicate");
    assert.equal(processed.discovery.firstSeenAt, original.firstSeenAt);
    assert.equal(processed.discovery.lastSeenAt, lastSeen.toISOString());
    assert.deepEqual(processed.discovery.analysis, original.analysis);
  });
});

test("trailing-slash equivalent duplicate never calls analysis", async () => {
  await withHistory(async (history) => {
    const original = searchResult("https://example.com/discovery");
    await history.recordDiscovery(analysisFor(original), firstSeen);
    let analysisCalls = 0;
    const processed = await processSearchResult(searchResult("https://example.com/discovery/"), {
      history,
      now: () => lastSeen,
      analyze: async (input) => { analysisCalls++; return analysisFor(input); },
    });
    assert.equal(processed.status, "duplicate");
    assert.equal(analysisCalls, 0);
  });
});

test("whitespace-equivalent duplicate never calls analysis", async () => {
  await withHistory(async (history) => {
    const original = searchResult();
    await history.recordDiscovery(analysisFor(original), firstSeen);
    let analysisCalls = 0;
    const processed = await processSearchResult(searchResult(" https://example.com/discovery "), {
      history,
      now: () => lastSeen,
      analyze: async (input) => { analysisCalls++; return analysisFor(input); },
    });
    assert.equal(processed.status, "duplicate");
    assert.equal(analysisCalls, 0);
  });
});

test("a failed analysis does not record a discovery", async () => {
  await withHistory(async (history) => {
    await assert.rejects(processSearchResult(searchResult(), {
      history,
      analyze: async () => { throw new Error("analysis failed"); },
    }), /analysis failed/);
    assert.deepEqual(await history.listDiscoveries(), []);
  });
});

test("a failed history check prevents analysis", async () => {
  let analysisCalls = 0;
  const brokenHistory: DiscoveryHistory = {
    async getDiscovery() { throw new Error("history is corrupted"); },
    async recordDiscovery() { throw new Error("unreachable"); },
    async touchDiscovery() { throw new Error("unreachable"); },
  };
  await assert.rejects(processSearchResult(searchResult(), {
    history: brokenHistory,
    analyze: async (input) => { analysisCalls++; return analysisFor(input); },
  }), /history is corrupted/);
  assert.equal(analysisCalls, 0);
});

test("a recording failure is surfaced", async () => {
  const failingHistory: DiscoveryHistory = {
    async getDiscovery() { return undefined; },
    async recordDiscovery() { throw new Error("history write failed"); },
    async touchDiscovery() { throw new Error("unreachable"); },
  };
  const result = searchResult();
  await assert.rejects(processSearchResult(result, {
    history: failingHistory,
    analyze: async (input) => analysisFor(input),
  }), /history write failed/);
});

test("a source-integrity failure is not recorded", async () => {
  await withHistory(async (history) => {
    const result = searchResult();
    await assert.rejects(processSearchResult(result, {
      history,
      analyze: async () => ({ ...analysisFor(result), sourceUrl: "https://attacker.invalid" }),
    }), /source integrity verification failed/);
    assert.deepEqual(await history.listDiscoveries(), []);
  });
});
