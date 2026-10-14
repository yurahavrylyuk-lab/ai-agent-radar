import assert from "node:assert/strict";
import test from "node:test";
import * as orchestrator from "../src/services/notificationOrchestrator.js";
import { recordBatchSelection } from "../src/services/discoveryProcessor.js";
import type { BatchSelection, DeliveryCandidate, StoredDiscovery } from "../src/types/index.js";
import type { NotificationHistory } from "../src/services/notificationHistoryCore.js";
import type { DiscoveryHistory } from "../src/services/discoveryHistoryCore.js";
import {
  getNotificationReplayWindow,
  MAX_REPLAY_DISCOVERY_SCAN,
  NOTIFICATION_REPLAY_ACTIVATION_CUTOFF,
  NOTIFICATION_REPLAY_WINDOW_HOURS,
} from "../src/config/notificationReplay.js";

test("replay policy is disabled at and before the immutable activation cutoff", () => {
  assert.equal(getNotificationReplayWindow(new Date("2026-10-06T15:59:59.999Z")), undefined);
  assert.equal(getNotificationReplayWindow(new Date(NOTIFICATION_REPLAY_ACTIVATION_CUTOFF)), undefined);
});

test("replay policy uses the activation cutoff until the full 72-hour window has elapsed", () => {
  assert.equal(NOTIFICATION_REPLAY_WINDOW_HOURS, 72);
  assert.deepEqual(getNotificationReplayWindow(new Date("2026-10-07T08:00:00.000Z")), {
    fromInclusive: NOTIFICATION_REPLAY_ACTIVATION_CUTOFF,
    beforeExclusive: "2026-10-07T08:00:00.000Z",
    limit: MAX_REPLAY_DISCOVERY_SCAN,
  });
});

test("replay policy advances to a rolling 72-hour boundary and remains bounded", () => {
  assert.equal(MAX_REPLAY_DISCOVERY_SCAN, 100);
  assert.deepEqual(getNotificationReplayWindow(new Date("2026-10-10T08:00:00.000Z")), {
    fromInclusive: "2026-10-07T08:00:00.000Z",
    beforeExclusive: "2026-10-10T08:00:00.000Z",
    limit: 100,
  });
});

test("replay policy rejects an invalid cycle timestamp", () => {
  assert.throws(() => getNotificationReplayWindow(new Date("invalid")), /timestamp is invalid/);
});

function replayCandidate(path: string, score = 8, firstSeenAt = "2026-10-12T12:00:00.000Z") {
  const url = `https://example.com/${path}`;
  const discovery: StoredDiscovery = {
    normalizedUrl: url, firstSeenAt, lastSeenAt: "2026-10-14T08:00:00.000Z",
    analysis: { name: path, category: "developer_tool", summary: `Summary ${path}`, relevanceScore: score,
      whyItMatters: "Useful", educationalValue: "Learn", projectOpportunities: ["Build"], technologies: [],
      sourceTitle: path, sourceUrl: url },
  };
  return { discovery, origin: "replay" as DeliveryCandidate["origin"], aliases: [url] };
}

function replayNotificationHistory(): NotificationHistory {
  return {
    async hasNotificationBeenSent() { return false; },
    async getNotificationRecord() { return undefined; },
    async recordNotificationSent(normalizedUrl, channel, providerMessageId) {
      return { normalizedUrl, channel, providerMessageId, sentAt: "2026-10-14T08:00:00.000Z" };
    },
  };
}

test("batch replay sorts score then immutable firstSeenAt then direct lexical URL, with one replay-only send", async () => {
  const candidates = [replayCandidate("a"), replayCandidate("Z"), replayCandidate("old", 8, "2026-10-11T12:00:00.000Z"),
    replayCandidate("score", 10, "2026-10-11T12:00:00.000Z"), replayCandidate("newer", 8, "2026-10-13T12:00:00.000Z")];
  candidates[2].discovery.lastSeenAt = "2026-10-14T09:00:00.000Z";
  let sends = 0;
  const outcome = await orchestrator.notifyBatchDeliveryDigest(candidates, {
    history: replayNotificationHistory(), sendEmail: async email => {
      sends++; assert.ok(email.text.includes("MOST RELEVANT")); return { id: "replay-only" };
    },
  });
  assert.equal(sends, 1);
  assert.deepEqual(outcome.sentCandidates.map(c => c.discovery.analysis.sourceUrl), [
    "https://example.com/score", "https://example.com/newer", "https://example.com/Z", "https://example.com/a",
  ]);
});

test("batch fresh scores8 and7 precede replay10 without a trusted-source bonus", async () => {
  const fresh = [replayCandidate("fresh8", 8), replayCandidate("fresh7", 7)];
  fresh.forEach(c => { c.origin = "fresh"; });
  const trusted = replayCandidate("trusted", 7);
  trusted.discovery.analysis.sourceUrl = trusted.discovery.normalizedUrl = "https://openai.com/news";
  trusted.aliases = [trusted.discovery.normalizedUrl];
  const outcome = await orchestrator.notifyBatchDeliveryDigest([trusted, replayCandidate("replay10", 10), ...fresh], {
    history: replayNotificationHistory(), sendEmail: async () => ({ id: "mixed" }),
  });
  assert.deepEqual(outcome.sentCandidates.map(c => c.discovery.analysis.sourceUrl), [
    "https://example.com/fresh8", "https://example.com/fresh7", "https://example.com/replay10", "https://openai.com/news",
  ]);
});

test("RF5 partial persistence delivers only successful fresh rows and bounded replay without rediscovery", async () => {
  const failed = replayCandidate("failed", 10);
  const persisted = replayCandidate("persisted", 8);
  const history: DiscoveryHistory = {
    async getDiscovery() { return undefined; },
    async touchDiscovery() { throw new Error("unexpected touch"); },
    async recordDiscovery() { throw new Error("unexpected legacy insert"); },
    async recordDiscoveryWithOutcome(analysis) {
      if (analysis.sourceUrl.endsWith("/failed")) throw new Error("insert failed");
      return { discovery: persisted.discovery, created: true };
    },
    async listRecentDiscoveries() { throw new Error("delivery must not expand the replay scan"); },
  };
  const delivery = [];
  const failures: string[] = [];
  for (const item of [failed, persisted]) {
    const selection: BatchSelection = { analysis: item.discovery.analysis, candidate: {
      candidateId: item.discovery.analysis.name, source: { title: item.discovery.analysis.sourceTitle, url: item.discovery.analysis.sourceUrl },
      normalizedUrl: item.discovery.normalizedUrl, aliasKey: item.discovery.normalizedUrl,
      aliases: item.aliases, provenance: [{ queryOrdinal: 1, resultOrdinal: 1 }],
    } };
    try {
      const saved = await recordBatchSelection(selection, { history, seenAt: new Date("2026-10-14T08:00:00Z") });
      if (saved.status === "new") delivery.push({ discovery: saved.discovery, origin: "fresh" as const, aliases: item.aliases });
    } catch (error) { failures.push((error as Error).message); }
  }
  let sends = 0;
  const outcome = await orchestrator.notifyBatchDeliveryDigest([...delivery, replayCandidate("replay", 10)], {
    history: replayNotificationHistory(), sendEmail: async email => {
      sends++; assert.ok(!email.text.includes("https://example.com/failed")); return { id: "partial" };
    },
  });
  assert.deepEqual(failures, ["insert failed"]);
  assert.equal(sends, 1);
  assert.deepEqual(outcome.sentCandidates.map(c => c.discovery.analysis.sourceUrl), [
    "https://example.com/persisted", "https://example.com/replay",
  ]);
});
