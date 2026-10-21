import assert from "node:assert/strict";
import test from "node:test";

import { createDailyEmailContext, finalizeDailyDigest, prepareDailyDigest } from "../src/services/notificationOrchestrator.js";
import { formatDailyDigestEmail } from "../src/services/discoveryEmailFormatter.js";
import type { BatchCandidate, BatchDeliveryCandidate, PreparedDailyDigest, StoredDiscovery } from "../src/types/index.js";
import type { NotificationHistory } from "../src/services/notificationHistoryCore.js";

const cycleDate = "2026-10-21T08:00:00.000Z";

function raw(id: string, url = `https://example.test/${id}`): BatchCandidate {
  return { candidateId: id, source: { title: `Title ${id}`, url, snippet: `Snippet ${id}` }, normalizedUrl: url,
    aliasKey: url.replace(/#.*$/, ""), aliases: [url], provenance: [{ kind: "brave", queryOrdinal: 1, resultOrdinal: 1 }] };
}

function analyzed(id: string, origin: "fresh" | "replay", score = 8, batch = true): BatchDeliveryCandidate {
  const url = `https://example.test/${id}`;
  const discovery: StoredDiscovery = { normalizedUrl: url, firstSeenAt: "2026-10-20T08:00:00.000Z", lastSeenAt: cycleDate,
    analysis: { name: id, category: "developer_tool", summary: id, relevanceScore: score, whyItMatters: id,
      educationalValue: id, projectOpportunities: [], technologies: [], sourceTitle: id, sourceUrl: url },
    ...(batch ? { batchSelectionProvenance: { kind: "batch" as const } } : {}) };
  return { discovery, origin, aliases: [url] };
}

function history(sent = new Set<string>(), failAt = Number.POSITIVE_INFINITY): NotificationHistory {
  let reads = 0;
  return {
    async hasNotificationBeenSent(url) { if (++reads === failAt) throw new Error("history unavailable"); return sent.has(url); },
    async getNotificationRecord(url, channel) { return sent.has(url) ? { normalizedUrl: url, channel, sentAt: cycleDate } : undefined; },
    async recordNotificationSent() { throw new Error("preparation must not write"); },
  };
}

test("raw_selection_preserves_pool_order, groups aliases, excludes notified groups, and caps four", async () => {
  const duplicateA = raw("c003", "https://example.test/story#old");
  const duplicateB = raw("c099", "https://example.test/story#new");
  duplicateA.aliasKey = duplicateB.aliasKey = "https://example.test/story";
  duplicateA.aliases = [duplicateA.normalizedUrl, duplicateB.normalizedUrl];
  duplicateB.aliases = [duplicateB.normalizedUrl];
  const pool = [duplicateA, duplicateB, raw("c001"), raw("c002"), raw("c004"), raw("c005")];
  const digest = await prepareDailyDigest({ cycleDate, fresh: [], replay: [], rawCandidates: pool,
    observedAliases: new Map([[duplicateA.aliasKey, duplicateA.aliases]]), allowRawFallback: true, reason: "ai_unavailable" },
  history(new Set([duplicateB.normalizedUrl])));
  assert.equal(digest.mode, "degraded");
  assert.deepEqual(digest.items.map(item => item.kind === "raw" ? item.candidate.candidateId : "analyzed"), ["c001", "c002", "c004", "c005"]);
});

test("delivery_precedence keeps normal fresh plus replay, otherwise raw then eligible replay", async () => {
  const normal = await prepareDailyDigest({ cycleDate, fresh: [analyzed("fresh", "fresh")], replay: [analyzed("replay", "replay")],
    rawCandidates: [raw("raw")], observedAliases: new Map(), allowRawFallback: true, reason: "selected" }, history());
  assert.equal(normal.mode, "normal");
  assert.deepEqual(normal.items.map(item => item.kind), ["analyzed", "analyzed"]);

  const legacyLow = analyzed("legacy-low", "replay", 5, false);
  const degraded = await prepareDailyDigest({ cycleDate, fresh: [], replay: [legacyLow, analyzed("batch-low", "replay", 5)],
    rawCandidates: [raw("r1"), raw("r2")], observedAliases: new Map(), allowRawFallback: true, reason: "ai_unavailable" }, history());
  assert.equal(degraded.mode, "degraded");
  assert.deepEqual(degraded.items.map(item => item.kind === "raw" ? item.candidate.candidateId : item.candidate.discovery.analysis.name), ["r1", "r2", "batch-low"]);
});

test("history failure suppresses every story and disabled raw fallback never resurrects candidates", async () => {
  const failed = await prepareDailyDigest({ cycleDate, fresh: [], replay: [analyzed("replay", "replay")], rawCandidates: [raw("raw")],
    observedAliases: new Map(), allowRawFallback: true, reason: "ai_unavailable" }, history(new Set(), 1));
  assert.equal(failed.mode, "status_only");
  assert.equal(failed.reason, "history_unavailable");
  assert.deepEqual(failed.items, []);

  const disabled = await prepareDailyDigest({ cycleDate, fresh: [], replay: [], rawCandidates: [raw("raw")],
    observedAliases: new Map(), allowRawFallback: false, reason: "persistence_unavailable" }, history());
  assert.equal(disabled.mode, "status_only");
  assert.deepEqual(disabled.items, []);
});

test("daily renderer preserves analyzed low-score labels and safely renders degraded and status modes", () => {
  const normal: PreparedDailyDigest = { mode: "normal", reason: "selected", cycleDate,
    items: [{ kind: "analyzed", candidate: analyzed("low", "fresh", 1) }, { kind: "analyzed", candidate: analyzed("high", "fresh", 10) }] };
  const normalEmail = formatDailyDigestEmail(normal);
  assert.match(normalEmail.text, /It could be relevant/);
  assert.match(normalEmail.text, /Relevance: 10\/10/);

  const unsafe = raw("raw", "https://example.test/story");
  unsafe.source.title = `<script>alert("x")</script>`;
  unsafe.source.snippet = "é".repeat(800);
  const degraded = formatDailyDigestEmail({ mode: "degraded", reason: "ai_unavailable", cycleDate, items: [{ kind: "raw", candidate: unsafe }] });
  assert.match(degraded.subject, /Daily digest — AI analysis unavailable/);
  assert.match(degraded.text, /selected directly from today's discovery results/);
  assert.doesNotMatch(degraded.html, /<script>/);
  assert.doesNotMatch(degraded.text, /Relevance:|WHY IT MATTERS/);
  assert.ok(new TextEncoder().encode(degraded.text.match(/é+/)?.[0] ?? "").byteLength <= 768);

  const status = formatDailyDigestEmail({ mode: "status_only", reason: "no_eligible_stories", cycleDate, items: [] });
  assert.match(status.subject, /Daily digest — status update/);
  assert.match(status.text, /2026-10-21/);
});

test("daily finalizer consumes one email attempt and records raw aliases only after acceptance", async () => {
  const candidate = raw("raw", "https://example.test/story#one");
  candidate.aliases = [candidate.normalizedUrl, "https://example.test/story#two"];
  const digest: PreparedDailyDigest = { mode: "degraded", reason: "ai_unavailable", cycleDate, items: [{ kind: "raw", candidate }] };
  const writes: string[] = [];
  const context = createDailyEmailContext();
  let sends = 0;
  const dependencies = { context, history: {
    async hasNotificationBeenSent() { return false; }, async getNotificationRecord() { return undefined; },
    async recordNotificationSent(url: string, channel: "email") { writes.push(url); return { normalizedUrl: url, channel, sentAt: cycleDate }; },
  }, sendEmail: async () => { sends += 1; return { id: "mail-1" }; } };
  const [first, second] = await Promise.all([finalizeDailyDigest(digest, dependencies), finalizeDailyDigest(digest, dependencies)]);
  assert.equal(sends, 1);
  assert.equal(first.emailOutcome === "accepted" || second.emailOutcome === "accepted", true);
  assert.equal(first.emailAttempts + second.emailAttempts, 1);
  assert.deepEqual(writes.sort(), [...candidate.aliases].sort());
});

test("failed daily transport is not retried and status delivery writes no story history", async () => {
  const context = createDailyEmailContext();
  let sends = 0;
  const digest: PreparedDailyDigest = { mode: "status_only", reason: "no_eligible_stories", cycleDate, items: [] };
  const outcome = await finalizeDailyDigest(digest, { context, sendEmail: async () => { sends += 1; throw new Error("provider rejected"); } });
  const repeated = await finalizeDailyDigest(digest, { context, sendEmail: async () => { sends += 1; return { id: "wrong" }; } });
  assert.equal(sends, 1);
  assert.equal(outcome.emailOutcome, "failed");
  assert.equal(repeated.emailAttempts, 0);
});
