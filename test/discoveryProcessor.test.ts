import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { JsonDiscoveryHistory, type DiscoveryHistory } from "../src/services/discoveryHistory.js";
import { processSearchResult } from "../src/services/discoveryProcessor.js";
import * as discoveryProcessor from "../src/services/discoveryProcessor.js";
import type { AgentAnalysis, BatchSelection, DiscoveryProcessingResult, SearchResult } from "../src/types/index.js";

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
    async listRecentDiscoveries() { return { discoveries: [], truncated: false }; },
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
    async listRecentDiscoveries() { return { discoveries: [], truncated: false }; },
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

function batchSelection(url = "https://example.test/news/release"): BatchSelection {
  const source = searchResult(url);
  return {
    candidate: { candidateId: "c001", source, normalizedUrl: url, aliasKey: url,
      aliases: [url], provenance: [{ queryOrdinal: 1, resultOrdinal: 1 }] },
    analysis: analysisFor(source),
  };
}

test("four batch selections persist their supplied analyses without analyzer or provider calls", async (t) => {
  await withHistory(async (history) => {
    let analyzeCalls = 0;
    let providerCalls = 0;
    t.mock.method(globalThis, "fetch", async () => { providerCalls++; throw new Error("unexpected provider"); });
    const dependencies = { history, seenAt: firstSeen,
      analyze: async () => { analyzeCalls++; throw new Error("unexpected analyzer"); } };
    const selections = [1, 2, 3, 4].map((id) => batchSelection(`https://example.test/news/${id}`));
    const results = [];
    for (const selection of selections) results.push(await discoveryProcessor.recordBatchSelection(selection, dependencies));
    assert.equal(analyzeCalls, 0);
    assert.equal(providerCalls, 0);
    assert.deepEqual(results.map((result) => result.status), ["new", "new", "new", "new"]);
    assert.equal((await history.listDiscoveries()).length, 4);
    assert.deepEqual(results.map((result) => result.discovery.analysis), selections.map((selection) => selection.analysis));
  });
});

test("invalid batch analyses, low scores, mismatched sources and unsafe identities reject before history access", async () => {
  let historyCalls = 0;
  const unreachable = async (): Promise<never> => { historyCalls++; throw new Error("unexpected history access"); };
  const history: DiscoveryHistory = { getDiscovery: unreachable, recordDiscovery: unreachable,
    touchDiscovery: unreachable, listRecentDiscoveries: unreachable };
  const valid = batchSelection();
  const invalidSelections: BatchSelection[] = [
    { ...valid, analysis: { ...valid.analysis, summary: " " } },
    { ...valid, analysis: { ...valid.analysis, relevanceScore: 6 } },
    { ...valid, analysis: { ...valid.analysis, relevanceScore: NaN } },
    { ...valid, analysis: { ...valid.analysis, sourceTitle: "Replaced title" } },
    { ...valid, analysis: { ...valid.analysis, sourceUrl: "https://example.test/news/other" } },
    { ...valid, candidate: { ...valid.candidate, normalizedUrl: "https://example.test/news/other" } },
    ...["https://example.test/", "https://example.test/?news=1#article", "ftp://example.test/news", "https://user:pass@example.test/news",
      `https://example.test/${"a".repeat(2048)}`].map(batchSelection),
  ];
  for (const selection of invalidSelections) {
    await assert.rejects(discoveryProcessor.recordBatchSelection(selection, { history, seenAt: firstSeen }));
  }
  assert.equal(historyCalls, 0);
});

test("batch duplicate touches canonical identity while retaining stored content and firstSeenAt", async () => {
  await withHistory(async (history) => {
    const selection = batchSelection();
    const original = await history.recordDiscovery({ ...selection.analysis, summary: "Original stored interpretation", relevanceScore: 5 }, firstSeen);
    selection.candidate.source.url = " https://example.test/news/release/ ";
    selection.analysis.sourceUrl = selection.candidate.source.url;
    const processed = await discoveryProcessor.recordBatchSelection(selection, { history, seenAt: lastSeen });
    assert.equal(processed.status, "duplicate");
    assert.equal(processed.discovery.normalizedUrl, "https://example.test/news/release");
    assert.equal(processed.discovery.firstSeenAt, firstSeen.toISOString());
    assert.equal(processed.discovery.lastSeenAt, lastSeen.toISOString());
    assert.deepEqual(processed.discovery.analysis, original.analysis);
  });
});

for (const sameAnalysis of [false, true]) {
  test(`JSON batch persistence classifies same-timestamp winner with ${sameAnalysis ? "identical" : "different"} content as duplicate`, async () => {
    await withHistory(async (history) => {
      const selection = batchSelection();
      const originalAnalysis = sameAnalysis ? selection.analysis : { ...selection.analysis, summary: "Existing interpretation" };
      const original = await history.recordDiscovery(originalAnalysis, firstSeen);
      // Model a row appearing after the helper's initial read; the real JSON
      // recording operation still reads the durable row itself.
      history.getDiscovery = async () => undefined;
      const result = await discoveryProcessor.recordBatchSelection(selection, { history, seenAt: firstSeen });
      assert.equal(result.status, "duplicate");
      assert.deepEqual(result.discovery, original);
      assert.deepEqual(await history.listDiscoveries(), [original]);
    });
  });
}

test("batch persistence without insertion evidence fails closed before a new write", async () => {
  let writes = 0;
  const history: DiscoveryHistory = {
    async getDiscovery() { return undefined; },
    async listRecentDiscoveries() { return { discoveries: [], truncated: false }; },
    async touchDiscovery() { return undefined; },
    async recordDiscovery(analysis) {
      writes++;
      return { normalizedUrl: analysis.sourceUrl, analysis, firstSeenAt: firstSeen.toISOString(), lastSeenAt: firstSeen.toISOString() };
    },
  };
  await assert.rejects(discoveryProcessor.recordBatchSelection(batchSelection(), { history, seenAt: firstSeen }), /insert outcome/i);
  assert.equal(writes, 0);
});

test("batch history read and duplicate-touch failures provide no result or replacement write", async () => {
  await withHistory(async (history) => {
    const selection = batchSelection();
    const original = await history.recordDiscovery(selection.analysis, firstSeen);
    let writes = 0;
    const dependencies: DiscoveryHistory = {
      async getDiscovery() { throw new Error("unreadable history"); },
      listRecentDiscoveries: history.listRecentDiscoveries.bind(history),
      async recordDiscovery() { writes++; throw new Error("unexpected replacement"); },
      async touchDiscovery() { return undefined; },
    };
    await assert.rejects(discoveryProcessor.recordBatchSelection(selection, { history: dependencies, seenAt: lastSeen }), /unreadable history/);
    dependencies.getDiscovery = async () => original;
    await assert.rejects(discoveryProcessor.recordBatchSelection(selection, { history: dependencies, seenAt: lastSeen }), /could not be updated safely/);
    dependencies.touchDiscovery = async () => { throw new Error("touch failed"); };
    await assert.rejects(discoveryProcessor.recordBatchSelection(selection, { history: dependencies, seenAt: lastSeen }), /touch failed/);
    assert.equal(writes, 0);
  });
});

test("RF5 second-of-three persistence failure leaves only first and third durable delivery results", async () => {
  await withHistory(async (history) => {
    const selections = [1, 2, 3].map((id) => batchSelection(`https://example.test/news/${id}`));
    const failedUrl = "https://example.test/news/2";
    const failingHistory: DiscoveryHistory = {
      getDiscovery: history.getDiscovery.bind(history),
      listRecentDiscoveries: history.listRecentDiscoveries.bind(history),
      touchDiscovery: history.touchDiscovery.bind(history),
      recordDiscovery: history.recordDiscovery.bind(history),
      async recordDiscoveryWithOutcome(analysis, seenAt) {
        if (analysis.sourceUrl === failedUrl) throw new Error("history write failed");
        return history.recordDiscoveryWithOutcome(analysis, seenAt);
      },
    };
    const successfulResults: DiscoveryProcessingResult[] = [];
    const failures: unknown[] = [];
    for (const selection of selections) {
      try { successfulResults.push(await discoveryProcessor.recordBatchSelection(selection, { history: failingHistory, seenAt: firstSeen })); }
      catch (error) { failures.push(error); }
    }
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /history write failed/);
    const recordedUrls = (await history.listDiscoveries()).map((discovery) => discovery.normalizedUrl);
    const deliveryUrls = successfulResults.map((result) => result.discovery.normalizedUrl);
    assert.deepEqual(recordedUrls, ["https://example.test/news/1", "https://example.test/news/3"]);
    assert.deepEqual(deliveryUrls, recordedUrls);
    assert.ok(!recordedUrls.includes(failedUrl));
    assert.ok(!deliveryUrls.includes(failedUrl));
  });
});
