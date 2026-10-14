import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { batchAliasKey, isBatchNewsUrl, prepareBatchCandidates } from "../src/services/batchCandidates.js";
import { JsonDiscoveryHistory, type DiscoveryHistory } from "../src/services/discoveryHistory.js";
import { JsonNotificationHistory, type NotificationHistory } from "../src/services/notificationHistory.js";
import type { AgentAnalysis, BatchObservation, SearchResult } from "../src/types/index.js";

const seenAt = new Date("2026-10-12T08:00:00.000Z");
const firstSeenAt = new Date("2026-10-11T08:00:00.000Z");
function observation(url: string, queryOrdinal = 1, resultOrdinal = 1, title = "Original title"): BatchObservation {
  return { queryOrdinal, resultOrdinal, result: { title, url, snippet: "Original snippet" } };
}
function analysis(sourceUrl: string): AgentAnalysis {
  return {
    name: "Stored story", category: "developer_tool", summary: "Stored evidence", relevanceScore: 8,
    whyItMatters: "Useful tool", educationalValue: "Learn a tool", projectOpportunities: ["Build"],
    technologies: ["TypeScript"], sourceTitle: "Stored title", sourceUrl,
  };
}
async function withHistory(callback: (history: JsonDiscoveryHistory, notificationHistory: JsonNotificationHistory) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "radar-batch-candidates-"));
  try {
    await callback(new JsonDiscoveryHistory(join(directory, "discoveries.json")), new JsonNotificationHistory(join(directory, "notifications.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("batch news URLs reject credentials, non-HTTP schemes, oversized bytes and root pages", () => {
  const prefix = "https://example.test/";
  const maximum = prefix + "a".repeat(2048 - prefix.length);
  for (const url of ["bad url", "ftp://example.test/news", "https://user:pass@example.test/news", "http://user@example.test/news", maximum + "a", prefix + "é".repeat(1015)]) {
    assert.equal(isBatchNewsUrl(url), false, url);
  }
  for (const url of [prefix, "https://example.test?news=1", prefix + "#news", prefix + "?news=1#news", prefix + "///?news=1"]) {
    assert.equal(isBatchNewsUrl(url), false, url);
  }
  for (const url of [maximum, "http://example.test/news", prefix + "news?x=1#part", prefix + "releases/"]) {
    assert.equal(isBatchNewsUrl(url), true, url);
  }
  assert.equal(batchAliasKey("https://EXAMPLE.test/news///?x=1#a"), "https://example.test/news?x=1");
  assert.throws(() => batchAliasKey("bad url"));
});

test("candidate preparation counts invalid fields and homepages once without history lookups", async () => {
  await withHistory(async (history, notificationHistory) => {
    const inputs: BatchObservation[] = [
      { queryOrdinal: 1, resultOrdinal: 1, result: null },
      observation("https://example.test/news", 1, 2, "  "),
      observation("https://user@example.test/news", 1, 3),
      observation("https://example.test/?q=1#news", 1, 4),
      observation("https://example.test/news", 1, 5),
      observation("https://example.test/invalid", 0, 1),
    ];
    const pool = await prepareBatchCandidates(inputs, { history, notificationHistory, seenAt });
    assert.deepEqual(pool.counts, { acceptedObservations: 5, invalid: 4, homepages: 1, duplicates: 0, known: 0 });
    assert.deepEqual(pool.candidates.map(({ candidateId, normalizedUrl }) => ({ candidateId, normalizedUrl })), [{ candidateId: "c001", normalizedUrl: "https://example.test/news" }]);
    assert.deepEqual([...pool.observedAliases], [["https://example.test/news", ["https://example.test/news"]]]);
  });
});

test("canonical slash and fragment duplicates retain first original source and all evidence", async () => {
  await withHistory(async (history, notificationHistory) => {
    const first = observation("https://EXAMPLE.test/news///#a", 1, 2, "  First title  ");
    const inputs = [observation("https://example.test/news#b", 2, 1, "Later title"), first, observation("https://example.test/news/#a", 1, 3)];
    const pool = await prepareBatchCandidates(inputs, { history, notificationHistory, seenAt });
    assert.equal(pool.candidates.length, 1);
    assert.deepEqual(pool.counts, { acceptedObservations: 3, invalid: 0, homepages: 0, duplicates: 2, known: 0 });
    assert.deepEqual(pool.candidates[0], {
      candidateId: "c001", source: first.result,
      normalizedUrl: "https://example.test/news#a", aliasKey: "https://example.test/news",
      aliases: ["https://example.test/news#a", "https://example.test/news#b"],
      provenance: [{ queryOrdinal: 1, resultOrdinal: 2 }, { queryOrdinal: 1, resultOrdinal: 3 }, { queryOrdinal: 2, resultOrdinal: 1 }],
    });
    assert.deepEqual([...pool.observedAliases], [["https://example.test/news", ["https://example.test/news#a", "https://example.test/news#b"]]]);
  });
});

test("stable IDs follow ordinal order after history exclusion and do not collapse query parameters", async () => {
  await withHistory(async (history, notificationHistory) => {
    await history.recordDiscovery(analysis("https://example.test/known"), firstSeenAt);
    const inputs = [observation("https://example.test/news?x=2", 2, 1), observation("https://example.test/known", 1, 1), observation("https://example.test/news?x=1", 1, 2)];
    const pool = await prepareBatchCandidates(inputs, { history, notificationHistory, seenAt });
    const reordered = await prepareBatchCandidates([...inputs].reverse(), { history, notificationHistory, seenAt });
    assert.deepEqual(pool, reordered);
    assert.deepEqual(pool.candidates.map(({ candidateId, normalizedUrl }) => ({ candidateId, normalizedUrl })), [
      { candidateId: "c001", normalizedUrl: "https://example.test/news?x=1" },
      { candidateId: "c002", normalizedUrl: "https://example.test/news?x=2" },
    ]);
    assert.equal(pool.counts.known, 1);
    assert.equal(pool.observedAliases.has("https://example.test/known"), true);
  });
});

test("fifty positions are the ceiling and invalid or repeated ordinals never add capacity", async () => {
  await withHistory(async (history, notificationHistory) => {
    const inputs = Array.from({ length: 50 }, (_, index) => observation(`https://example.test/news-${index}`, Math.floor(index / 5) + 1, index % 5 + 1));
    inputs.push(observation("https://example.test/eleventh-query", 11, 1), observation("https://example.test/sixth-result", 1, 6), observation("https://example.test/fraction", 1.5, 1), observation("https://example.test/repeated", 1, 1));
    const pool = await prepareBatchCandidates(inputs, { history, notificationHistory, seenAt });
    assert.equal(pool.candidates.length, 50);
    assert.deepEqual(pool.counts, { acceptedObservations: 50, invalid: 4, homepages: 0, duplicates: 0, known: 0 });
    assert.equal(pool.candidates[0].candidateId, "c001");
    assert.equal(pool.candidates[49].candidateId, "c050");
    assert.equal(pool.candidates.some(({ source }) => source.url.includes("repeated")), false);
  });
});

test("an invalid source consumes its provider position even when repeated with usable fields", async () => {
  await withHistory(async (history, notificationHistory) => {
    const pool = await prepareBatchCandidates([
      { queryOrdinal: 1, resultOrdinal: 1, result: null }, observation("https://example.test/replacement", 1, 1),
    ], { history, notificationHistory, seenAt });
    assert.equal(pool.candidates.length, 0);
    assert.deepEqual(pool.counts, { acceptedObservations: 1, invalid: 2, homepages: 0, duplicates: 0, known: 0 });
  });
});

test("RF2: notification on a later fragment alias excludes the group without fabricated discoveries", async () => {
  await withHistory(async (history, notificationHistory) => {
    await notificationHistory.recordNotificationSent("https://example.test/news#b", "email", "test-message", firstSeenAt);
    let recordDiscoveryCalls = 0;
    const originalRecord = history.recordDiscovery.bind(history);
    history.recordDiscovery = async (...args) => { recordDiscoveryCalls += 1; return originalRecord(...args); };
    const pool = await prepareBatchCandidates([
      observation("https://example.test/news#a", 1, 1), observation("https://example.test/news#b", 1, 2),
    ], { history, notificationHistory, seenAt });
    assert.equal(pool.candidates.length, 0);
    assert.equal(pool.counts.known, 1);
    assert.deepEqual([...pool.observedAliases], [["https://example.test/news", ["https://example.test/news#a", "https://example.test/news#b"]]]);
    assert.equal(recordDiscoveryCalls, 0);
    assert.deepEqual(await history.listDiscoveries(), []);
  });
});

test("every alias gets discovery and email evidence despite an earlier known alias; only existing rows are touched", async () => {
  await withHistory(async (history, notificationHistory) => {
    await history.recordDiscovery(analysis("https://example.test/news#a"), firstSeenAt);
    const events: string[] = [];
    const originalLookup = history.getDiscovery.bind(history);
    history.getDiscovery = async (url) => { events.push(`discovery:${url}`); return originalLookup(url); };
    const originalNotification = notificationHistory.getNotificationRecord.bind(notificationHistory);
    notificationHistory.getNotificationRecord = async (url, channel) => { events.push(`${channel}:${url}`); return originalNotification(url, channel); };
    const originalTouch = history.touchDiscovery.bind(history);
    history.touchDiscovery = async (url, time) => { events.push(`touch:${url}`); return originalTouch(url, time); };
    const pool = await prepareBatchCandidates([
      observation("https://example.test/news#a", 1, 1), observation("https://example.test/news#b", 1, 2),
    ], { history, notificationHistory, seenAt });
    assert.equal(pool.candidates.length, 0);
    assert.equal(pool.counts.known, 1);
    assert.deepEqual(events.filter((event) => !event.startsWith("touch:")), [
      "discovery:https://example.test/news#a", "email:https://example.test/news#a",
      "discovery:https://example.test/news#b", "email:https://example.test/news#b",
    ]);
    assert.deepEqual(events.filter((event) => event.startsWith("touch:")), ["touch:https://example.test/news#a"]);
    const existing = await history.getDiscovery("https://example.test/news#a");
    assert.equal(existing?.firstSeenAt, firstSeenAt.toISOString());
    assert.equal(existing?.lastSeenAt, seenAt.toISOString());
    assert.equal((await history.listDiscoveries()).length, 1);
  });
});

test("unverifiable discovery, notification or touch evidence rejects even after a known alias", async () => {
  await withHistory(async (history, notificationHistory) => {
    await history.recordDiscovery(analysis("https://example.test/news#a"), firstSeenAt);
    const inputs = [observation("https://example.test/news#a", 1, 1), observation("https://example.test/news#b", 1, 2)];
    const originalLookup = history.getDiscovery.bind(history);
    const unavailableHistory: DiscoveryHistory = {
      getDiscovery: async (url) => { if (url.endsWith("#b")) throw new Error("lookup unavailable"); return originalLookup(url); },
      listRecentDiscoveries: history.listRecentDiscoveries.bind(history), recordDiscovery: history.recordDiscovery.bind(history), touchDiscovery: history.touchDiscovery.bind(history),
    };
    await assert.rejects(prepareBatchCandidates(inputs, { history: unavailableHistory, notificationHistory, seenAt }), /lookup unavailable/);
    const unavailableNotifications: NotificationHistory = {
      getNotificationRecord: async (url) => { if (url.endsWith("#b")) throw new Error("notification unavailable"); return undefined; },
      hasNotificationBeenSent: notificationHistory.hasNotificationBeenSent.bind(notificationHistory), recordNotificationSent: notificationHistory.recordNotificationSent.bind(notificationHistory),
    };
    await assert.rejects(prepareBatchCandidates(inputs, { history, notificationHistory: unavailableNotifications, seenAt }), /notification unavailable/);
    await assert.rejects(prepareBatchCandidates(inputs, { history: { ...unavailableHistory, getDiscovery: originalLookup, touchDiscovery: async () => { throw new Error("touch unavailable"); } }, notificationHistory, seenAt }), /touch unavailable/);
  });
});

test("candidate preparation rejects malformed optional source fields without forwarding objects", async () => {
  await withHistory(async (history, notificationHistory) => {
    const pool = await prepareBatchCandidates([
      { queryOrdinal: 1, resultOrdinal: 1, result: { title: "Story", url: "https://example.test/news", snippet: {} } as SearchResult },
      { queryOrdinal: 1, resultOrdinal: 2, result: { title: "Story", url: "https://example.test/other", publishedAt: [] } as unknown as SearchResult },
    ], { history, notificationHistory, seenAt });
    assert.equal(pool.candidates.length, 0);
    assert.deepEqual(pool.counts, { acceptedObservations: 2, invalid: 2, homepages: 0, duplicates: 0, known: 0 });
  });
});
