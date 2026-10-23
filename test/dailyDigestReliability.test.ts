import assert from "node:assert/strict";
import test from "node:test";

import { createDailyEmailContext, finalizeDailyDigest, prepareDailyDigest } from "../src/services/notificationOrchestrator.js";
import { formatDailyDigestEmail } from "../src/services/discoveryEmailFormatter.js";
import { createGeminiBatchCycleContext, generateBatchWithGemini } from "../src/tools/llm/gemini.js";
import type { ApprovedGeminiModel } from "../src/config/geminiModels.js";
import type { GeminiAmbiguityReason, GeminiUsageAdmission, GeminiUsageData, GeminiUsageRecord, GeminiUsageReservation, GeminiUsageSettlement, GeminiUsageStore } from "../src/services/geminiUsageTracker.js";
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

test("ineligible notified legacy replay alias blocks its eligible Batch-marked group", async () => {
  const legacy = analyzed("legacy", "replay", 5, false);
  const selected = analyzed("selected", "replay", 5, true);
  const legacyUrl = "https://example.test/same-story#old";
  const selectedUrl = "https://example.test/same-story#new";
  legacy.discovery.normalizedUrl = legacy.discovery.analysis.sourceUrl = legacyUrl;
  legacy.aliases = [legacyUrl];
  selected.discovery.normalizedUrl = selected.discovery.analysis.sourceUrl = selectedUrl;
  selected.aliases = [selectedUrl];

  const digest = await prepareDailyDigest({ cycleDate, fresh: [], replay: [legacy, selected], rawCandidates: [],
    observedAliases: new Map(), allowRawFallback: false, reason: "selected" }, history(new Set([legacyUrl])));

  assert.equal(digest.mode, "status_only");
  assert.equal(digest.reason, "no_eligible_stories");
  assert.deepEqual(digest.items, []);
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

test("mixed degraded digest preserves analyzed replay truth while raw cards stay unscored", () => {
  const replay = analyzed("replay-low", "replay", 5);
  const digest: PreparedDailyDigest = {
    mode: "degraded",
    reason: "ai_unavailable",
    cycleDate,
    items: [{ kind: "raw", candidate: raw("raw-first") }, { kind: "analyzed", candidate: replay }],
  };

  const content = formatDailyDigestEmail(digest);
  assert.match(content.text, /STORY 1[\s\S]*Title raw-first/);
  assert.match(content.text, /STORY 2 — PREVIOUSLY ANALYZED[\s\S]*Relevance: 5\/10[\s\S]*It could be relevant/);
  assert.match(content.html, /Previously analyzed/);
  assert.match(content.html, /Relevance: 5\/10/);
  assert.match(content.html, /It could be relevant/);
  const rawSection = content.html.slice(content.html.indexOf("Raw raw-first"), content.html.indexOf("Previously analyzed"));
  assert.doesNotMatch(rawSection, /Relevance:|It could be relevant|AI summary/i);
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

test("email telemetry checkpoint failure cannot suppress or duplicate the guarded send", async () => {
  const context = createDailyEmailContext();
  let checkpoints = 0;
  let sends = 0;
  const digest: PreparedDailyDigest = { mode: "status_only", reason: "no_eligible_stories", cycleDate, items: [] };
  const dependencies = {
    context,
    beforeEmailAttempt: async () => { checkpoints += 1; throw new Error("telemetry unavailable"); },
    sendEmail: async () => { sends += 1; return { id: "accepted-once" }; },
  };
  const first = await finalizeDailyDigest(digest, dependencies);
  const second = await finalizeDailyDigest(digest, dependencies);
  assert.equal(checkpoints, 1);
  assert.equal(sends, 1);
  assert.equal(first.emailOutcome, "accepted");
  assert.equal(second.emailAttempts, 0);
});

class ReliabilityUsageStore implements GeminiUsageStore {
  data: GeminiUsageData = { records: [], usageUnknown: false };
  async getUsageData() { return structuredClone(this.data); }
  async recordRequest() {}
  async markUsageUnknown() { this.data.usageUnknown = true; }
  async reserveRequest(record: GeminiUsageRecord & { model: ApprovedGeminiModel }, _admission: GeminiUsageAdmission) {
    const stored = { ...record, id: this.data.records.length + 1, accountingStatus: "reserved" as const, accountingThrough: record.timestamp };
    this.data.records.push(stored);
    return { id: `memory:${stored.id}`, record: stored };
  }
  private index(reservation: GeminiUsageReservation) { return Number(reservation.id.split(":")[1]) - 1; }
  async settleRequest(reservation: GeminiUsageReservation, usage: GeminiUsageSettlement) {
    const index = this.index(reservation);
    this.data.records[index] = { ...this.data.records[index]!, ...usage, accountingStatus: "exact", settledAt: reservation.record.timestamp, accountingThrough: reservation.record.timestamp };
  }
  async confirmZeroRequest(reservation: GeminiUsageReservation) {
    const index = this.index(reservation);
    this.data.records[index] = { ...this.data.records[index]!, accountingStatus: "confirmed_zero", settledAt: reservation.record.timestamp, accountingThrough: reservation.record.timestamp };
  }
  async markRequestAmbiguous(reservation: GeminiUsageReservation, reason: GeminiAmbiguityReason) {
    const index = this.index(reservation);
    this.data.records[index] = { ...this.data.records[index]!, accountingStatus: "transport_ambiguous", ambiguityReason: reason };
  }
  async reconcileAbandonedReservation() { return "reconciled" as const; }
  async retireAmbiguousRequest() { return "retired" as const; }
}

const reliabilityEnvironment = {
  GEMINI_API_KEY: "offline",
  GEMINI_DAILY_REQUEST_LIMIT: "100",
  GEMINI_WEEKLY_REQUEST_LIMIT: "100",
  GEMINI_MONTHLY_REQUEST_LIMIT: "100",
  GEMINI_DAILY_TOKEN_LIMIT: "100000",
  GEMINI_WEEKLY_TOKEN_LIMIT: "100000",
  GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
};

async function providerFailureThenDegradedDelivery(response: () => Response) {
  const usage = new ReliabilityUsageStore();
  const gemini = createGeminiBatchCycleContext();
  let dispatches = 0;
  await assert.rejects(generateBatchWithGemini("bounded batch", {
    usageTracker: usage,
    environment: reliabilityEnvironment,
    cycleContext: gemini,
    sleep: async () => {},
    random: () => 0,
    fetchImplementation: (async () => { dispatches += 1; return response(); }) as typeof fetch,
  }));
  const digest = await prepareDailyDigest({ cycleDate, fresh: [], replay: [], rawCandidates: [raw("fallback")],
    observedAliases: new Map(), allowRawFallback: true, reason: "ai_unavailable" }, history());
  const context = createDailyEmailContext();
  let emailAttempts = 0;
  const delivery = await finalizeDailyDigest(digest, { context, sendEmail: async () => { emailAttempts += 1; return { id: "accepted" }; } });
  return { usage, gemini, dispatches, emailAttempts, digest, delivery };
}

test("503_503_503_persists_three_then_one_degraded_email", async () => {
  const result = await providerFailureThenDegradedDelivery(() => new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 }));
  assert.equal(result.dispatches, 3);
  assert.equal(result.emailAttempts, 1);
  assert.equal(result.digest.mode, "degraded");
  assert.equal(result.delivery.emailOutcome, "accepted");
  assert.deepEqual(result.usage.data.records.map(record => [record.id, record.requestCount, record.accountingStatus]), [
    [1, 1, "confirmed_zero"], [2, 1, "confirmed_zero"], [3, 1, "confirmed_zero"],
  ]);
  assert.deepEqual(result.gemini.attempts.map(attempt => [attempt.ordinal, attempt.failureClass]), [
    [1, "unavailable_503"], [2, "unavailable_503"], [3, "unavailable_503"],
  ]);
});

test("429_persists_one_then_degraded", async () => {
  const result = await providerFailureThenDegradedDelivery(() => new Response(JSON.stringify({ error: {
    status: "RESOURCE_EXHAUSTED",
    details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{
      quotaMetric: "requests", quotaDimensions: { model: "gemini-3.8-flash" },
    }] }],
  } }), { status: 429 }));
  assert.equal(result.dispatches, 1);
  assert.equal(result.emailAttempts, 1);
  assert.deepEqual(result.usage.data.records.map(record => [record.id, record.requestCount, record.accountingStatus]), [[1, 1, "confirmed_zero"]]);
  assert.deepEqual(result.gemini.attempts.map(attempt => [attempt.ordinal, attempt.failureClass]), [[1, "resource_exhausted_429"]]);
});

test("no_payload_status_only reaches one final email attempt", async () => {
  const digest = await prepareDailyDigest({ cycleDate, fresh: [], replay: [], rawCandidates: [], observedAliases: new Map(),
    allowRawFallback: true, reason: "ai_unavailable" }, history());
  let sends = 0;
  const result = await finalizeDailyDigest(digest, { context: createDailyEmailContext(), sendEmail: async () => { sends += 1; return { id: "status" }; } });
  assert.equal(digest.mode, "status_only");
  assert.equal(sends, 1);
  assert.equal(result.emailOutcome, "accepted");
});
