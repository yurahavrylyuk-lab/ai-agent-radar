import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { DiscoveryHistoryError, JsonDiscoveryHistory } from "../src/services/discoveryHistory.js";
import type { AgentAnalysis } from "../src/types/index.js";

const firstSeen = new Date("2026-09-19T10:00:00.000Z");
const lastSeen = new Date("2026-09-19T11:00:00.000Z");

const analysis = (sourceUrl = "https://example.com/discovery"): AgentAnalysis => ({
  name: "Example Agent",
  category: "new_agent",
  summary: "A validated test discovery.",
  relevanceScore: 8,
  whyItMatters: "It is useful for testing discovery history.",
  educationalValue: "It demonstrates persistent deduplication.",
  projectOpportunities: ["Build a prototype"],
  technologies: ["TypeScript"],
  sourceTitle: "Example discovery",
  sourceUrl,
});

async function withHistory(callback: (history: JsonDiscoveryHistory, filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ai-agent-monitor-history-"));
  const filePath = join(directory, "discovery-history.json");
  try {
    await callback(new JsonDiscoveryHistory(filePath), filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a missing history file behaves as empty", async () => {
  await withHistory(async (history) => {
    assert.deepEqual(await history.listDiscoveries(), []);
    assert.equal(await history.hasDiscovery("https://example.com/discovery"), false);
  });
});

test("records and retrieves a first discovery", async () => {
  await withHistory(async (history) => {
    const recorded = await history.recordDiscovery(analysis(), firstSeen);
    const retrieved = await history.getDiscovery("https://example.com/discovery");
    assert.equal(recorded.normalizedUrl, "https://example.com/discovery");
    assert.deepEqual(retrieved, recorded);
    assert.equal(recorded.firstSeenAt, firstSeen.toISOString());
    assert.equal(recorded.lastSeenAt, firstSeen.toISOString());
  });
});

test("exact duplicate recording preserves the original discovery and timestamp", async () => {
  await withHistory(async (history) => {
    const original = await history.recordDiscovery(analysis(), firstSeen);
    const duplicate = await history.recordDiscovery(analysis(), lastSeen);
    assert.deepEqual(duplicate, original);
    assert.equal((await history.listDiscoveries()).length, 1);
    assert.equal(duplicate.firstSeenAt, firstSeen.toISOString());
    assert.equal(duplicate.lastSeenAt, firstSeen.toISOString());
  });
});

test("trailing slashes and surrounding whitespace identify the same discovery", async () => {
  await withHistory(async (history) => {
    await history.recordDiscovery(analysis("https://EXAMPLE.com/discovery/"), firstSeen);
    assert.equal(await history.hasDiscovery(" https://example.com/discovery "), true);
    assert.equal((await history.getDiscovery("https://example.com/discovery/"))?.normalizedUrl, "https://example.com/discovery");
  });
});

test("genuinely different URLs remain different discoveries", async () => {
  await withHistory(async (history) => {
    await history.recordDiscovery(analysis("https://example.com/one"), firstSeen);
    await history.recordDiscovery(analysis("https://example.com/two"), firstSeen);
    assert.equal((await history.listDiscoveries()).length, 2);
  });
});

test("touching a known discovery updates only lastSeenAt", async () => {
  await withHistory(async (history) => {
    await history.recordDiscovery(analysis(), firstSeen);
    const touched = await history.touchDiscovery(" https://example.com/discovery/ ", lastSeen);
    assert.equal(touched?.firstSeenAt, firstSeen.toISOString());
    assert.equal(touched?.lastSeenAt, lastSeen.toISOString());
    assert.equal(await history.touchDiscovery("https://example.com/missing", lastSeen), undefined);
  });
});

test("rejects malformed JSON without replacing the history file", async () => {
  await withHistory(async (history, filePath) => {
    await writeFile(filePath, "{not valid JSON", "utf8");
    await assert.rejects(history.listDiscoveries(), DiscoveryHistoryError);
    assert.equal(await readFile(filePath, "utf8"), "{not valid JSON");
  });
});

test("rejects structurally invalid history", async () => {
  await withHistory(async (history, filePath) => {
    await writeFile(filePath, JSON.stringify({ discoveries: {} }), "utf8");
    await assert.rejects(history.listDiscoveries(), /invalid format/);
  });
});

test("rejects stored discoveries with invalid AgentAnalysis", async () => {
  await withHistory(async (history, filePath) => {
    const invalid = { normalizedUrl: "https://example.com/discovery", firstSeenAt: firstSeen.toISOString(), lastSeenAt: firstSeen.toISOString(), analysis: { ...analysis(), relevanceScore: 0 } };
    await writeFile(filePath, JSON.stringify({ discoveries: [invalid] }), "utf8");
    await assert.rejects(history.listDiscoveries(), /invalid format/);
  });
});

test("listing returns stored discoveries", async () => {
  await withHistory(async (history) => {
    await history.recordDiscovery(analysis("https://example.com/one"), firstSeen);
    await history.recordDiscovery(analysis("https://example.com/two"), lastSeen);
    assert.deepEqual((await history.listDiscoveries()).map((item) => item.normalizedUrl), ["https://example.com/one", "https://example.com/two"]);
  });
});
