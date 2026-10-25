import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import * as monitor from "../src/services/monitor.js";
import { analyzeBatch, BatchAnalysisError } from "../src/services/analysisAgent.js";
import { normalizeDiscoveryUrl, DiscoveryHistoryError, type DiscoveryHistory } from "../src/services/discoveryHistoryCore.js";
import { NotificationHistoryError, type NotificationHistory } from "../src/services/notificationHistoryCore.js";
import { D1GeminiUsageStore } from "../src/services/d1GeminiUsageStore.js";
import { D1MonitoringTelemetry } from "../src/services/d1MonitoringTelemetry.js";
import { createScheduledCycleSummary, createWorkerMonitoringDependencies, type RadarWorkerEnv } from "../src/worker.js";
import { BraveUsageGuardDeniedError } from "../src/tools/webSearch.js";
import { createGeminiBatchCycleContext, generateBatchWithGemini } from "../src/tools/llm/gemini.js";
import type { AgentAnalysis, BatchAnalysisResult, BraveSearchPage, DiscoveryEmailContent, NotificationRecord, PreparedBatch, RssDiscoveryResult, StoredDiscovery, ThreadsDiscoveryResult } from "../src/types/index.js";

const cycleStart = new Date("2026-10-14T08:00:00.000Z");
const counts = { dailyRequests: 0, weeklyRequests: 0, monthlyRequests: 0, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 0 };
const limits = { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10000, weeklyTokens: 30000, monthlyTokens: 100000 };

function analysis(url: string, score = 8): AgentAnalysis {
  return { sourceTitle: url, sourceUrl: url, name: url.split("/").at(-1)!, category: "developer_tool", summary: "What changed",
    relevanceScore: score, whyItMatters: "Practical implications", educationalValue: "Learning value", technologies: ["TypeScript"], projectOpportunities: ["Build a tool"] };
}

function stored(url: string, score = 8, firstSeenAt = "2026-10-13T08:00:00.000Z"): StoredDiscovery {
  return { normalizedUrl: normalizeDiscoveryUrl(url), firstSeenAt, lastSeenAt: firstSeenAt, analysis: analysis(url, score) };
}

function fixture() {
  const discoveries = new Map<string, StoredDiscovery>();
  const notifications = new Map<string, NotificationRecord>();
  const events: string[] = [];
  const sent: DiscoveryEmailContent[] = [];
  let analyzeCalls = 0;
  let searchCalls = 0;
  const history: DiscoveryHistory = {
    async getDiscovery(url) { return discoveries.get(normalizeDiscoveryUrl(url)); },
    async listRecentDiscoveries(query) {
      events.push("replay");
      assert.deepEqual(query, { fromInclusive: "2026-10-11T08:00:00.000Z", beforeExclusive: "2026-10-14T08:00:00.000Z", limit: 100 });
      return { discoveries: [...discoveries.values()].filter(d => d.firstSeenAt >= query.fromInclusive && d.firstSeenAt < query.beforeExclusive).slice(0, query.limit), truncated: false };
    },
    async recordDiscovery(value, seenAt = cycleStart) {
      const url = normalizeDiscoveryUrl(value.sourceUrl);
      const existing = discoveries.get(url);
      if (existing) return existing;
      const discovery = { normalizedUrl: url, firstSeenAt: seenAt.toISOString(), lastSeenAt: seenAt.toISOString(), analysis: value };
      discoveries.set(url, discovery); return discovery;
    },
    async recordDiscoveryWithOutcome(value, seenAt) {
      const created = !discoveries.has(normalizeDiscoveryUrl(value.sourceUrl));
      events.push(`persist:${value.sourceUrl}`);
      return { discovery: await history.recordDiscovery(value, seenAt), created };
    },
    async touchDiscovery(url, seenAt = cycleStart) {
      const discovery = discoveries.get(normalizeDiscoveryUrl(url));
      if (discovery) discovery.lastSeenAt = seenAt.toISOString();
      return discovery;
    },
  };
  const notificationHistory: NotificationHistory = {
    async getNotificationRecord(url) { return notifications.get(normalizeDiscoveryUrl(url)); },
    async hasNotificationBeenSent(url) { return notifications.has(normalizeDiscoveryUrl(url)); },
    async recordNotificationSent(url, channel, providerMessageId, sentAt = cycleStart) {
      const record = { normalizedUrl: normalizeDiscoveryUrl(url), channel, providerMessageId, sentAt: sentAt.toISOString() };
      notifications.set(record.normalizedUrl, record); return record;
    },
  };
  const dependencies: monitor.BatchMonitoringDependencies = {
    history, notification: { history: notificationHistory, sendEmail: async content => { events.push("send"); sent.push(content); return { id: "offline-message" }; } },
    now: () => cycleStart,
    geminiCycleContext: createGeminiBatchCycleContext(),
    collectRss: async () => { events.push("rss"); return emptyRss(); },
    searchPage: async (_query, options) => {
      searchCalls++; events.push(`search:${searchCalls}`); assert.equal(options?.freshness, "pw");
      return { rawCount: 5, positions: Array.from({ length: 5 }, (_, index) => ({ resultOrdinal: index + 1,
        result: { title: `Query ${searchCalls} result ${index + 1}`, url: `https://example.test/query${searchCalls}/story${index + 1}`, snippet: "Useful evidence" } })) };
    },
    geminiPreflight: async () => { events.push("admission"); return { allowed: true, counts, limits }; },
    analyze: async batch => { analyzeCalls++; events.push("analysis"); return selection(batch, [23, 0, 1, 2]); },
  };
  return { dependencies, discoveries, notifications, events, sent, history, notificationHistory, searchCalls: () => searchCalls, analyzeCalls: () => analyzeCalls };
}

function emptyRss(overrides: Partial<RssDiscoveryResult> = {}): RssDiscoveryResult {
  return {
    observations: [],
    metrics: { status: "collected", configuredFeeds: 4, attemptedFeeds: 4, succeededFeeds: 4, failedFeeds: 0,
      observedPositions: 0, validCandidates: 0, rejectedItems: 0, itemLimitTruncations: 0,
      outcomes: ["openai_news", "github_changelog", "cloudflare_ai", "chrome_developers"].map(feedId => ({ feedId, reason: "ok" as const, elapsedMs: 1 })) },
    ...overrides,
  };
}

function emptyThreads(overrides: Partial<ThreadsDiscoveryResult> = {}): ThreadsDiscoveryResult {
  return {
    observations: [],
    metrics: {
      enabled: true, configured: true, publicApprovalAttested: true,
      health: "healthy", reason: "ok", authentication: "accepted", rotationDue: false,
      attemptedQueries: 3, succeededQueries: 3, failedQueries: 0, skippedQueries: 0,
      observedPositions: 0, validObservations: 0, rejectedPositions: 0,
      outcomes: ["ai_agents", "claude_code", "codex"].map(queryId => ({
        queryId: queryId as "ai_agents" | "claude_code" | "codex", reason: "ok" as const,
        httpStatus: 200, elapsedMs: 1, observedPositions: 0,
        itemTruncated: false, pagingIgnored: false, bodyTruncated: false,
      })),
    },
    ...overrides,
  };
}

function selection(batch: PreparedBatch, indexes: number[]): BatchAnalysisResult {
  return { returnedCount: indexes.length, selections: indexes.map(index => {
    const candidate = batch.candidates[index]!;
    return { candidate, analysis: { ...analysis(candidate.source.url), sourceTitle: candidate.source.title } };
  }) };
}

async function run(dependencies: monitor.BatchMonitoringDependencies) {
  assert.equal(typeof monitor.runBatchMonitoringCycle, "function", "batch cycle entry must exist");
  return monitor.runBatchMonitoringCycle(dependencies);
}

test("all fifty observations reach one bounded analysis subset after all ten searches", async () => {
  const f = fixture();
  const checkpoints: Array<{ phase: string; latency: unknown }> = [];
  f.dependencies.onTelemetryCheckpoint = async (phase, snapshot) => {
    checkpoints.push({ phase, latency: snapshot.latency });
  };
  f.dependencies.analyze = async batch => {
    f.events.push("analysis");
    assert.equal(batch.candidates.length, 24);
    assert.equal(batch.candidates[9]?.source.url, "https://example.test/query10/story1");
    assert.ok(f.events.indexOf("rss") > f.events.lastIndexOf("search:10"));
    assert.ok(f.events.indexOf("admission") > f.events.indexOf("rss"));
    f.dependencies.geminiCycleContext.attemptTimings.push({ ordinal: 1, requestStartedAt: "2026-10-14T08:00:01.000Z", elapsedMs: 1234 });
    return selection(batch, [9, 0, 1, 2]);
  };
  const result = await run(f.dependencies);
  assert.equal(f.searchCalls(), 10);
  assert.equal(result.analysesAttempted, 1);
  assert.equal(f.events.filter(e => e === "analysis").length, 1);
  assert.equal(result.newDiscoveries, 4);
  assert.equal(result.stoppedByAnalysisCap, false);
  assert.equal(f.sent.length, 1);
  assert.equal(f.discoveries.size, 4);
  assert.ok(f.events.indexOf("send") > f.events.lastIndexOf("persist:https://example.test/query1/story3"));
  assert.ok(f.sent[0]!.text.indexOf("Query 10 result 1") < f.sent[0]!.text.indexOf("Query 1 result 1"));
  assert.equal(result.batch?.submittedCandidates, 24);
  assert.deepEqual(result.batch?.latency, {
    version: 1, preFilterInputCount: 50, selectedCount: 24, selectorExcluded: 26,
    byteExcluded: 0, submittedCount: 24, promptBytes: result.batch?.promptBytes ?? null,
    snippetBytesLimit: 192, thinkingMode: "low", executionMode: "synchronous",
    attemptTimings: [{ ordinal: 1, requestStartedAt: "2026-10-14T08:00:01.000Z", elapsedMs: 1234 }],
  });
  assert.deepEqual(checkpoints.map(checkpoint => checkpoint.phase), ["sources_complete", "gemini_complete"]);
  assert.deepEqual((checkpoints[0]?.latency as { attemptTimings: unknown[] }).attemptTimings, []);
  assert.deepEqual((checkpoints[1]?.latency as { attemptTimings: unknown[] }).attemptTimings, [
    { ordinal: 1, requestStartedAt: "2026-10-14T08:00:01.000Z", elapsedMs: 1234 },
  ]);
});

test("excluded_analysis_candidate_remains_in_raw_fallback", async () => {
  const f = fixture();
  let queryOrdinal = 0;
  let analyzedIds: readonly string[] = [];
  f.dependencies.searchPage = async () => {
    queryOrdinal += 1;
    const count = queryOrdinal === 10 ? 2 : 5;
    return { rawCount: count, positions: Array.from({ length: count }, (_, index) => ({
      resultOrdinal: index + 1,
      result: { title: `Query ${queryOrdinal} result ${index + 1}`, url: `https://example.test/query${queryOrdinal}/story${index + 1}`, snippet: "Useful evidence" },
    })) };
  };
  f.dependencies.analyze = async batch => {
    analyzedIds = batch.candidates.map(candidate => candidate.candidateId);
    assert.equal(batch.candidates.length, 24);
    assert.equal(batch.candidates.some(candidate => candidate.source.url === "https://example.test/query1/story4"), false);
    f.dependencies.geminiCycleContext.providerDispatches = 1;
    throw new Error("terminal reviewed provider failure");
  };

  const result = await run(f.dependencies);
  assert.equal(result.batch?.acceptedObservations, 47);
  assert.equal(result.batch?.latency?.preFilterInputCount, 47);
  assert.equal(result.batch?.latency?.selectedCount, 24);
  assert.equal(result.batch?.latency?.selectorExcluded, 23);
  assert.equal(analyzedIds.includes("c004"), false);
  assert.equal(result.delivery?.deliveryMode, "degraded");
  assert.equal(result.delivery?.rawStories, 4);
  assert.equal(result.batch?.emailCount, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /Query 1 result 4/);
  assert.equal(f.discoveries.size, 0, "raw fallback must not fabricate analyzed discoveries");
});

test("source checkpoint failure prevents Gemini but preserves one guarded degraded delivery", async () => {
  const f = fixture();
  const phases: string[] = [];
  const snapshots: Array<{ brave: string | null; rss: string | null; outage: boolean | null }> = [];
  f.dependencies.onTelemetryCheckpoint = async (phase, snapshot) => {
    phases.push(phase);
    snapshots.push({ brave: snapshot.braveHealth, rss: snapshot.rssHealth, outage: snapshot.outage });
    assert.equal(snapshot.candidateCounts.received, 50);
    if (phase === "sources_complete") throw new Error("cycle telemetry unavailable");
  };
  const result = await run(f.dependencies);
  assert.deepEqual(phases, ["sources_complete", "gemini_complete"]);
  assert.deepEqual(snapshots, [
    { brave: "healthy", rss: "healthy", outage: false },
    { brave: "healthy", rss: "healthy", outage: false },
  ]);
  assert.equal(f.analyzeCalls(), 0);
  assert.equal(result.batch?.providerDispatches, 0);
  assert.equal(result.batch?.status, "preparation_failed");
  assert.equal(result.delivery?.deliveryMode, "degraded");
  assert.equal(result.delivery?.emailAttempts, 1);
  assert.equal(f.sent.length, 1);
});

test("an all-low Batch selection still produces one marked digest", async () => {
  const f = fixture();
  f.dependencies.analyze = async batch => {
    f.events.push("analysis");
    const selections = selection(batch, [0, 1, 2]);
    [6, 5, 4].forEach((score, index) => { selections.selections[index]!.analysis.relevanceScore = score; });
    return selections;
  };
  const result = await run(f.dependencies);
  assert.equal(f.events.filter(event => event === "analysis").length, 1);
  assert.equal(result.analysesAttempted, 1);
  assert.equal(result.newDiscoveries, 3);
  assert.equal(result.freshStoriesSent, 3);
  assert.equal(result.batch?.acceptedStories, 3);
  assert.equal(result.batch?.emailCount, 1);
  assert.equal(f.sent.length, 1);
  assert.equal((f.sent[0]!.text.match(/It could be relevant/g) ?? []).length, 3);
  assert.equal((f.sent[0]!.html.match(/It could be relevant/g) ?? []).length, 3);
});

test("an empty current Batch does not revive a legacy low-score replay record", async () => {
  const f = fixture();
  const legacy = stored("https://example.test/legacy-low", 5);
  f.discoveries.set(legacy.normalizedUrl, legacy);
  f.dependencies.analyze = async () => ({ returnedCount: 0, selections: [] });
  const result = await run(f.dependencies);
  assert.equal(result.analysesAttempted, 1);
  assert.equal(result.batch?.acceptedStories, 0);
  assert.equal(result.replayCandidatesConsidered, 1);
  assert.equal(result.replayCandidatesEligible, 0);
  assert.equal(result.replayStoriesSent, 0);
  assert.equal(result.notificationsSent, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /discovery highlights/i);
  assert.doesNotMatch(f.sent[0]!.text, /legacy-low/);
});

test("Brave and RSS candidates share one pool and one Gemini analysis", async () => {
  const f = fixture();
  f.dependencies.searchPage = async (_query, _options) => ({ rawCount: 0, positions: [] });
  f.dependencies.collectRss = async () => {
    f.events.push("rss");
    return emptyRss({
      observations: [{ result: { title: "RSS story", url: "https://openai.com/news/rss-story", publishedAt: "2026-10-14T07:00:00.000Z" }, provenance: { kind: "rss", feedId: "openai_news", itemOrdinal: 1 } }],
      metrics: { ...emptyRss().metrics, observedPositions: 1, validCandidates: 1 },
    });
  };
  f.dependencies.analyze = async batch => {
    assert.equal(batch.candidates.length, 1);
    assert.equal(batch.candidates[0]?.source.title, "RSS story");
    return selection(batch, [0]);
  };
  const result = await run(f.dependencies);
  assert.equal(result.analysesAttempted, 1);
  assert.equal(result.geminiProviderAttempts, 0);
  assert.equal(result.newDiscoveries, 1);
  assert.equal(result.rss?.validCandidates, 1);
});

test("Threads joins Brave and RSS before one shared Batch analysis", async () => {
  const f = fixture();
  let clockReads = 0;
  f.dependencies.now = () => new Date(cycleStart.getTime() + clockReads++ * 1_000);
  f.dependencies.collectThreads = async collectedAt => {
    f.events.push("threads");
    assert.equal(collectedAt.toISOString(), "2026-10-14T08:00:01.000Z");
    return emptyThreads({
      observations: [{
        result: { title: "Threads story", url: "https://www.threads.com/@author/post/abc", snippet: "Public post", publishedAt: "2026-10-14T07:00:00.000Z", source: "Threads" },
        provenance: { kind: "threads", queryId: "ai_agents", postId: "123", resultOrdinal: 1 },
      }],
      metrics: { ...emptyThreads().metrics, observedPositions: 1, validObservations: 1 },
    });
  };
  f.dependencies.analyze = async batch => {
    f.events.push("analysis");
    assert.ok(f.events.indexOf("threads") > f.events.indexOf("rss"));
    assert.ok(batch.candidates.some(candidate => candidate.provenance.some(entry => entry.kind === "threads")));
    return selection(batch, [batch.candidates.findIndex(candidate => candidate.provenance.some(entry => entry.kind === "threads"))]);
  };

  const result = await run(f.dependencies);

  assert.equal(f.events.filter(event => event === "analysis").length, 1);
  assert.equal(result.threads?.succeededQueries, 3);
  assert.equal(result.batch?.submittedBySource.threads, 1);
  assert.deepEqual(result.batch?.discoverySourceHealth.successfulResponses, { brave: 10, rss: 4, threads: 3 });
  assert.equal(result.batch?.discoverySourceHealth.threadsEnabled, true);
});

test("Threads collector failure is isolated from healthy Brave and RSS", async () => {
  const f = fixture();
  f.dependencies.collectThreads = async () => { throw new Error("PRIVATE_THREADS_PROVIDER_TEXT"); };
  const result = await run(f.dependencies);
  assert.equal(result.threads?.health, "unavailable");
  assert.equal(result.threads?.reason, "transport");
  assert.equal(result.batch?.discoverySourceHealth.outage, false);
  assert.equal(result.analysesAttempted, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE_THREADS_PROVIDER_TEXT"), false);
});

test("Threads-only successful empty response prevents a total discovery outage", async () => {
  const f = fixture();
  f.dependencies.searchPage = async () => { throw new Error("Brave unavailable"); };
  f.dependencies.collectRss = async () => { throw new Error("RSS unavailable"); };
  f.dependencies.collectThreads = async () => emptyThreads();
  const result = await run(f.dependencies);
  assert.deepEqual(result.batch?.discoverySourceHealth.successfulResponses, { brave: 0, rss: 0, threads: 3 });
  assert.equal(result.batch?.discoverySourceHealth.outage, false);
  assert.notEqual(result.delivery?.deliveryReason, "discovery_unavailable");
});

test("missing Threads collector stays disabled and preserves the two-source outage predicate", async () => {
  const f = fixture();
  f.dependencies.searchPage = async () => { throw new Error("Brave unavailable"); };
  f.dependencies.collectRss = async () => { throw new Error("RSS unavailable"); };
  const result = await run(f.dependencies);
  assert.equal(result.threads?.enabled, false);
  assert.deepEqual(result.batch?.discoverySourceHealth.successfulResponses, { brave: 0, rss: 0, threads: 0 });
  assert.equal(result.batch?.discoverySourceHealth.threadsEnabled, false);
  assert.equal(result.batch?.discoverySourceHealth.outage, true);
});

test("RSS collector rejection is isolated and Brave still reaches analysis", async () => {
  const f = fixture();
  f.dependencies.collectRss = async () => { throw new Error("private feed failure"); };
  f.dependencies.analyze = async batch => selection(batch, [0]);
  const result = await run(f.dependencies);
  assert.equal(result.rss?.status, "configuration");
  assert.equal(result.rss?.outcomes.length, 0);
  assert.equal(result.failures, 1);
  assert.equal(result.newDiscoveries, 1);
});

test("Brave outage is visible while healthy RSS continues normally", async () => {
  const f = fixture();
  f.dependencies.searchPage = async () => { throw new Error("Brave unavailable"); };
  const result = await run(f.dependencies);
  assert.deepEqual(result.batch?.discoverySourceHealth, {
    brave: "unavailable", rss: "healthy", threads: "disabled",
    successfulResponses: { brave: 0, rss: 4, threads: 0 }, threadsEnabled: false, outage: false,
  });
});

test("RSS outage is visible while healthy Brave continues normally", async () => {
  const f = fixture();
  f.dependencies.collectRss = async () => { throw new Error("RSS unavailable"); };
  const result = await run(f.dependencies);
  assert.deepEqual(result.batch?.discoverySourceHealth, {
    brave: "healthy", rss: "unavailable", threads: "disabled",
    successfulResponses: { brave: 10, rss: 0, threads: 0 }, threadsEnabled: false, outage: false,
  });
});

test("operational failure of both active discovery sources reports an outage", async () => {
  const f = fixture();
  const replay = stored("https://example.test/outage-replay");
  f.discoveries.set(replay.normalizedUrl, replay);
  f.dependencies.searchPage = async () => { throw new Error("Brave unavailable"); };
  f.dependencies.collectRss = async () => { throw new Error("RSS unavailable"); };
  const result = await run(f.dependencies);
  assert.deepEqual(result.batch?.discoverySourceHealth, {
    brave: "unavailable", rss: "unavailable", threads: "disabled",
    successfulResponses: { brave: 0, rss: 0, threads: 0 }, threadsEnabled: false, outage: true,
  });
  assert.equal(result.replayStoriesSent, 1);
  assert.equal(f.sent.length, 1);
});

test("full discovery outage without eligible replay sends one truthful status digest", async () => {
  const f = fixture();
  f.dependencies.searchPage = async () => { throw new Error("Brave unavailable"); };
  f.dependencies.collectRss = async () => { throw new Error("RSS unavailable"); };

  const result = await run(f.dependencies);

  assert.equal(result.batch?.discoverySourceHealth.outage, true);
  assert.equal(result.delivery?.deliveryMode, "status_only");
  assert.equal(result.delivery?.deliveryReason, "discovery_unavailable");
  assert.equal(result.delivery?.emailAttempts, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /Discovery sources were unavailable/);
  assert.doesNotMatch(f.sent[0]!.text, /No new eligible stories/);
});

test("partial RSS feed failure is degraded rather than unavailable", async () => {
  const f = fixture();
  f.dependencies.collectRss = async () => emptyRss({ metrics: {
    ...emptyRss().metrics,
    succeededFeeds: 2,
    failedFeeds: 2,
    outcomes: [
      { feedId: "openai_news", reason: "ok", elapsedMs: 1 },
      { feedId: "github_changelog", reason: "ok", elapsedMs: 1 },
      { feedId: "cloudflare_ai", reason: "http", httpStatus: 503, elapsedMs: 1 },
      { feedId: "chrome_developers", reason: "timeout", elapsedMs: 5000 },
    ],
  } });
  const result = await run(f.dependencies);
  assert.deepEqual(result.batch?.discoverySourceHealth, {
    brave: "healthy", rss: "degraded", threads: "disabled",
    successfulResponses: { brave: 10, rss: 2, threads: 0 }, threadsEnabled: false, outage: false,
  });
  assert.notEqual(result.delivery?.deliveryReason, "discovery_unavailable");
});

test("Brave quota denial stays distinct while zero successful active sources form an outage", async () => {
  const f = fixture();
  f.dependencies.searchPage = async () => { throw new BraveUsageGuardDeniedError(); };
  f.dependencies.collectRss = async () => { throw new Error("RSS unavailable"); };
  const result = await run(f.dependencies);
  assert.deepEqual(result.batch?.discoverySourceHealth, {
    brave: "quota_blocked", rss: "unavailable", threads: "disabled",
    successfulResponses: { brave: 0, rss: 0, threads: 0 }, threadsEnabled: false, outage: true,
  });
  assert.equal(result.searchFailures.length, 0);
  assert.equal(result.delivery?.deliveryReason, "discovery_unavailable");
});

test("healthy discovery sources with zero useful candidates are not an outage", async () => {
  const f = fixture();
  f.dependencies.searchPage = async () => ({ rawCount: 0, positions: [] });
  const result = await run(f.dependencies);
  assert.deepEqual(result.batch?.discoverySourceHealth, {
    brave: "healthy", rss: "healthy", threads: "disabled",
    successfulResponses: { brave: 10, rss: 4, threads: 0 }, threadsEnabled: false, outage: false,
  });
  assert.equal(result.analysesAttempted, 0);
  assert.equal(result.delivery?.deliveryReason, "no_eligible_stories");
});

test("blocked Gemini admission still searches first and delivers bounded stored replay", async () => {
  const f = fixture(); const replay = stored("https://example.test/replay"); f.discoveries.set(replay.normalizedUrl, replay);
  f.dependencies.geminiPreflight = async () => { f.events.push("admission"); return { allowed: false, reason: "usage_unknown" }; };
  const result = await run(f.dependencies);
  assert.equal(f.searchCalls(), 10); assert.equal(f.analyzeCalls(), 0);
  assert.ok(f.events.indexOf("admission") > f.events.lastIndexOf("search:10"));
  assert.equal(result.batch?.status, "blocked"); assert.equal(result.geminiBlockedReason, "usage_unknown");
  assert.equal(result.replayStoriesSent, 0); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /AI analysis unavailable/i);
});

test("accepted email reports its exact fresh/replay inclusion even when notification recording then fails", async () => {
  const f = fixture(); const replay = stored("https://example.test/replay"); f.discoveries.set(replay.normalizedUrl, replay);
  f.dependencies.analyze = async batch => selection(batch, [0, 1]);
  let recordAttempts = 0;
  f.notificationHistory.recordNotificationSent = async () => { recordAttempts++; throw new Error("offline record failure"); };
  const result = await run(f.dependencies);
  assert.equal(f.sent.length, 1); assert.equal(recordAttempts, 3);
  assert.equal(result.notificationsSent, 1); assert.equal(result.batch?.emailCount, 1);
  assert.equal(result.freshStoriesSent, 2); assert.equal(result.batch?.freshDelivered, 2);
  assert.equal(result.replayStoriesSent, 1); assert.equal(result.batch?.replayDelivered, 1);
  assert.equal(result.failures, 1);
});

test("failed sender reports zero accepted emails and delivered stories without retry or recording", async () => {
  const f = fixture(); let sends = 0; let writes = 0;
  f.dependencies.notification.sendEmail = async () => { sends++; throw new Error("send failed"); };
  f.notificationHistory.recordNotificationSent = async () => { writes++; throw new Error("unexpected record"); };
  const result = await run(f.dependencies);
  assert.equal(sends, 1); assert.equal(writes, 0); assert.equal(result.failures, 1);
  assert.equal(result.notificationsSent, 0); assert.equal(result.batch?.emailCount, 0);
  assert.equal(result.batch?.freshDelivered, 0); assert.equal(result.batch?.replayDelivered, 0);
});

test("reservation without dispatch remains distinct from one batch invocation and no accepted selections", async () => {
  const f = fixture();
  f.dependencies.analyze = async () => {
    Object.assign(f.dependencies.geminiCycleContext, { reservationAttempts: 1, reservations: 1, providerDispatches: 0 });
    throw new Error("accounting window changed before dispatch");
  };
  const result = await run(f.dependencies);
  assert.equal(result.analysesAttempted, 1); assert.equal(result.geminiProviderAttempts, 0);
  assert.equal(result.batch?.reservationAttempts, 1); assert.equal(result.batch?.reservations, 1);
  assert.equal(result.batch?.providerDispatches, 0); assert.equal(result.batch?.status, "provider_failed");
  assert.equal(result.batch?.returnedStories, 0); assert.equal(result.batch?.acceptedStories, 0);
  assert.deepEqual(result.batch?.selected, []);
});

test("a reviewed confirmed-zero retry success still finalizes exactly one normal digest", async () => {
  const f = fixture();
  f.dependencies.analyze = async batch => {
    Object.assign(f.dependencies.geminiCycleContext, {
      reservationAttempts: 2, reservations: 2, providerDispatches: 2,
      retryEligible: true, retryAttempted: true, retrySkipReason: "none",
      attempts: [
        { ordinal: 1, providerFailureClass: "unavailable_503", accountingOutcome: "confirmed_zero", elapsedMs: 50 },
        { ordinal: 2, accountingOutcome: "exact", elapsedMs: 1_200 },
      ],
    });
    return selection(batch, [0]);
  };
  const result = await run(f.dependencies);
  assert.equal(f.sent.length, 1);
  assert.equal(result.notificationsSent, 1);
  assert.equal(result.delivery?.deliveryMode, "normal");
  assert.equal(result.batch?.providerDispatches, 2);
  assert.equal(result.batch?.retryAttempted, true);
  assert.deepEqual(result.batch?.attempts?.map(attempt => attempt.accountingOutcome), ["confirmed_zero", "exact"]);
});

test("known groups, prompt exclusions and truncation diagnostics describe the actual prepared subset", async () => {
  const f = fixture(); const old = stored("https://example.test/known", 8, "2026-10-01T00:00:00.000Z"); f.discoveries.set(old.normalizedUrl, old);
  let page = 0;
  f.dependencies.searchPage = async () => ({ rawCount: 5, positions: Array.from({ length: 5 }, (_, i) => {
    const ordinal = page++;
    return { resultOrdinal: i + 1, result: { title: "title ".repeat(100), snippet: "snippet ".repeat(200), url: ordinal === 0 ? old.normalizedUrl : `https://example.test/${ordinal}/${"x".repeat(1800)}` } };
  }) });
  f.dependencies.analyze = async batch => {
    assert.equal(batch.truncationStage, "snippet128"); assert.equal(batch.candidates.length, 24);
    return { returnedCount: 0, selections: [] };
  };
  const result = await run(f.dependencies);
  assert.equal(result.batch?.acceptedObservations, 50); assert.equal(result.batch?.known, 1);
  assert.equal(result.batch?.sizeExcluded! + result.batch?.submittedCandidates!, 24);
  assert.equal(result.batch?.latency?.selectorExcluded, 25);
  assert.equal(result.batch?.truncationStage, "snippet128"); assert.ok(result.batch!.promptBytes <= 12_288);
});

test("quota cutoff stops later queries but analyzes already collected positions once", async () => {
  const f = fixture(); let calls = 0; const search = f.dependencies.searchPage;
  f.dependencies.searchPage = async (...args) => { calls++; if (calls === 3) throw new BraveUsageGuardDeniedError(); return search(...args); };
  f.dependencies.analyze = async batch => selection(batch, [0]);
  const result = await run(f.dependencies);
  assert.equal(calls, 3); assert.equal(result.searchResultsReceived, 10); assert.equal(result.searchFailures.length, 0);
  assert.equal(result.analysesAttempted, 1); assert.equal(result.newDiscoveries, 1);
});

test("non-quota partial failure preserves successes and later search positions", async () => {
  const f = fixture(); let calls = 0; const search = f.dependencies.searchPage;
  f.dependencies.searchPage = async (...args) => { calls++; if (calls === 2) throw new Error("temporary error"); return search(...args); };
  f.dependencies.analyze = async batch => {
    assert.equal(batch.candidates.length, 24);
    const provenance = batch.candidates[1]?.provenance[0];
    assert.equal(provenance?.kind, "brave");
    assert.equal(provenance?.kind === "brave" ? provenance.queryOrdinal : undefined, 3);
    return selection(batch, [23]);
  };
  const result = await run(f.dependencies);
  assert.equal(calls, 10); assert.equal(result.searchFailures[0]?.queryOrdinal, 2); assert.equal(result.failures, 1); assert.equal(result.newDiscoveries, 1);
  assert.equal(result.batch?.discoverySourceHealth.brave, "degraded");
});

test("all search failures remain visible while replay delivers with zero analysis", async () => {
  const f = fixture(); const replay = stored("https://example.test/replay"); f.discoveries.set(replay.normalizedUrl, replay);
  let calls = 0; f.dependencies.searchPage = async () => { calls++; throw new Error("temporary error"); };
  const result = await run(f.dependencies);
  assert.equal(calls, 10); assert.equal(f.analyzeCalls(), 0); assert.equal(result.failures, 10);
  assert.equal(result.searchFailures.length, 10); assert.equal(f.sent.length, 1); assert.equal(result.replayStoriesSent, 1);
});

test("empty and entirely known pools invoke no batch analysis", async () => {
  for (const known of [false, true]) {
    const f = fixture();
    if (known) {
      const old = stored("https://example.test/known", 9, "2026-10-01T00:00:00.000Z"); f.discoveries.set(old.normalizedUrl, old);
    }
    f.dependencies.searchPage = async () => ({ rawCount: known ? 1 : 0, positions: known ? [{ resultOrdinal: 1, result: { title: "Known", url: "https://example.test/known" } }] : [] });
    const result = await run(f.dependencies);
    assert.equal(f.analyzeCalls(), 0); assert.equal(result.analysesAttempted, 0); assert.equal(result.batch?.status, "empty"); assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.text, /status update/i);
    if (known) assert.equal(f.discoveries.get("https://example.test/known")?.firstSeenAt, "2026-10-01T00:00:00.000Z");
  }
});

test("oversupply accepts only first five source positions and homepages cannot reach analysis or replay", async () => {
  const f = fixture(); const root = stored("https://openai.com/?announcement=1", 10); f.discoveries.set(root.normalizedUrl, root);
  f.dependencies.searchPage = async () => ({ rawCount: 10, positions: [
    { resultOrdinal: 1, result: null }, { resultOrdinal: 2, result: { title: "root", url: "https://openai.com/#new" } },
    ...Array.from({ length: 8 }, (_, i) => ({ resultOrdinal: i + 3, result: { title: "article", url: `https://example.test/article${i}` } })),
  ] });
  f.dependencies.analyze = async batch => { assert.equal(batch.candidates.length, 3); assert.equal(batch.candidates[2]?.source.url, "https://example.test/article2"); return { returnedCount: 0, selections: [] }; };
  const result = await run(f.dependencies);
  assert.equal(result.searchResultsReceived, 100); assert.equal(result.batch?.acceptedObservations, 50); assert.equal(result.batch?.homepages, 10); assert.equal(result.batch?.invalid, 10);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /discovery highlights/i);
  assert.doesNotMatch(f.sent[0]!.text, /https:\/\/openai\.com\/?/);
});

test("history uncertainty produces one status-only delivery without analysis", async () => {
  for (const phase of ["replay", "candidate", "notification"]) {
    const f = fixture();
    if (phase === "replay") f.history.listRecentDiscoveries = async () => { throw new DiscoveryHistoryError("unavailable"); };
    if (phase === "candidate") f.history.getDiscovery = async () => { throw new DiscoveryHistoryError("unavailable"); };
    if (phase === "notification") f.notificationHistory.getNotificationRecord = async () => { throw new NotificationHistoryError("unavailable"); };
    const result = await run(f.dependencies);
    assert.equal(f.analyzeCalls(), 0); assert.equal(f.sent.length, 1);
    assert.equal(result.failures, 1);
    assert.match(f.sent[0]!.text, /status update/i);
  }
});

test("provider failures and invalid content are terminal for fresh analysis but replay remains available", async () => {
  for (const error of [new Error("provider timeout text is untrusted"), new BatchAnalysisError()]) {
    const f = fixture(); const replay = stored("https://example.test/replay"); f.discoveries.set(replay.normalizedUrl, replay);
    let attempts = 0; f.dependencies.analyze = async () => { attempts++; throw error; };
    const result = await run(f.dependencies);
    assert.equal(attempts, 1); assert.equal(result.batch?.status, error instanceof BatchAnalysisError ? "invalid_output" : "provider_failed");
    assert.equal(result.newDiscoveries, 0); assert.equal(result.failures, 1); assert.equal(f.sent.length, 1);
  }
  const f = fixture(); f.dependencies.analyze = async () => { f.dependencies.geminiCycleContext.dispatchBlockedByTimeout = true; throw new Error("opaque"); };
  const timeoutResult = await run(f.dependencies);
  assert.equal(timeoutResult.batch?.status, "timeout");
  assert.equal(timeoutResult.delivery?.deliveryMode, "degraded");
  assert.equal(timeoutResult.delivery?.deliveryReason, "ai_unavailable");
  assert.equal(timeoutResult.delivery?.emailAttempts, 1);
});

test("Gemini provider response text cannot enter the scheduled cycle summary", async () => {
  const privateTitle = "UNIQUE_PRIVATE_TITLE_ABC123";
  const privateSnippet = "UNIQUE_PRIVATE_SNIPPET_XYZ789";
  const f = fixture();
  let analysisCalls = 0;
  f.dependencies.analyze = async () => {
    analysisCalls += 1;
    Object.assign(f.dependencies.geminiCycleContext, {
      reservationAttempts: 1,
      reservations: 1,
      providerDispatches: 1,
    });
    throw new Error(`Gemini provider failed. Candidate title: ${privateTitle}. Snippet: ${privateSnippet}.`);
  };

  const result = await run(f.dependencies);
  const summary = createScheduledCycleSummary(result, {
    DB: {} as D1Database,
    BRAVE_SEARCH_API_KEY: "offline-brave",
    BRAVE_DAILY_SEARCH_LIMIT: "10",
    BRAVE_WEEKLY_SEARCH_LIMIT: "100",
    BRAVE_MONTHLY_SEARCH_LIMIT: "350",
    GEMINI_API_KEY: "offline-gemini",
    GEMINI_DAILY_REQUEST_LIMIT: "5",
    GEMINI_WEEKLY_REQUEST_LIMIT: "20",
    GEMINI_MONTHLY_REQUEST_LIMIT: "50",
    GEMINI_DAILY_TOKEN_LIMIT: "10000",
    GEMINI_WEEKLY_TOKEN_LIMIT: "30000",
    GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
    RESEND_API_KEY: "offline-resend",
    NOTIFICATION_EMAIL: "offline@example.test",
  });
  const serialized = JSON.stringify(summary);

  assert.equal(analysisCalls, 1);
  assert.equal(result.failures, 1);
  assert.equal(result.batch?.status, "provider_failed");
  assert.equal(result.batch?.providerDispatches, 1);
  assert.equal(result.geminiProviderAttempts, 1);
  assert.equal(summary.outcomes.length, 1);
  assert.equal(summary.outcomes[0]?.failed, true);
  assert.doesNotMatch(serialized, new RegExp(privateTitle));
  assert.doesNotMatch(serialized, new RegExp(privateSnippet));
});

test("RF5 failed persistence and late-notified lead promote fresh stories and fill from replay", async () => {
  const f = fixture(); const replay = stored("https://example.test/replay", 10); f.discoveries.set(replay.normalizedUrl, replay);
  f.dependencies.analyze = async batch => selection(batch, [0, 1, 2]);
  const insert = f.history.recordDiscoveryWithOutcome!;
  f.history.recordDiscoveryWithOutcome = async (value, at) => {
    if (value.sourceUrl.endsWith("query2/story1")) throw new Error("write failed");
    return insert(value, at);
  };
  let leadReads = 0;
  f.notificationHistory.hasNotificationBeenSent = async url => {
    if (url === "https://example.test/query1/story1" && ++leadReads === 2) {
      await f.notificationHistory.recordNotificationSent(url, "email", "other-process"); return true;
    }
    return f.notifications.has(url);
  };
  const result = await run(f.dependencies);
  assert.equal(result.analysesAttempted, 1); assert.equal(result.newDiscoveries, 2); assert.equal(result.failures, 1);
  assert.equal(f.sent.length, 1); assert.equal(result.freshStoriesSent, 1); assert.equal(result.replayStoriesSent, 1);
  assert.ok(!f.sent[0]!.text.includes("Query 1 result 1")); assert.ok(!f.sent[0]!.text.includes("Query 2 result 1"));
  assert.ok(f.sent[0]!.text.includes("Query 3 result 1")); assert.ok(f.sent[0]!.text.includes("replay"));
});

test("existing-row race outside immutable replay window is not a fresh delivery", async () => {
  const f = fixture(); f.dependencies.analyze = async batch => selection(batch, [0]);
  f.history.recordDiscoveryWithOutcome = async value => ({ created: false, discovery: stored(value.sourceUrl, 10, "2026-10-01T00:00:00.000Z") });
  const result = await run(f.dependencies);
  assert.equal(result.newDiscoveries, 0); assert.equal(result.duplicates, 1); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /discovery highlights/i);
});

test("racing replay joins only the bounded original scan and shares observed alias notification evidence", async () => {
  const f = fixture(); const old = stored("https://example.test/article#a"); f.discoveries.set(old.normalizedUrl, old);
  await f.notificationHistory.recordNotificationSent("https://example.test/article#b", "email", "earlier");
  f.dependencies.searchPage = async () => ({ rawCount: 2, positions: [
    { resultOrdinal: 1, result: { title: "article", url: "https://example.test/article#a" } },
    { resultOrdinal: 2, result: { title: "article", url: "https://example.test/article#b" } },
  ] });
  const result = await run(f.dependencies);
  assert.equal(result.analysesAttempted, 0); assert.equal(f.sent.length, 1); assert.equal(old.firstSeenAt, "2026-10-13T08:00:00.000Z");
  assert.match(f.sent[0]!.text, /status update/i);
});

class D1Statement {
  constructor(private database: Database.Database, private sql: string, private values: unknown[] = []) {}
  bind(...values: unknown[]) { return new D1Statement(this.database, this.sql, values); }
  private compiled() { const values: unknown[] = []; const sql = this.sql.replace(/\?(\d+)/g, (_match, raw: string) => { values.push(this.values[Number(raw) - 1]); return "?"; }); return { statement: this.database.prepare(sql), values }; }
  async first<T>() { const value = this.compiled(); return (value.statement.get(...value.values) as T | undefined) ?? null; }
  async all<T>() { const value = this.compiled(); return { success: true, results: value.statement.all(...value.values) as T[], meta: {} as D1Meta }; }
  async run() { const value = this.compiled(); const r = value.statement.run(...value.values); return { success: true, results: [], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } as D1Meta }; }
  async batchResult() { return /\bRETURNING\b/i.test(this.sql) ? this.all() : this.run(); }
}

async function withD1(action: (database: Database.Database, d1: D1Database) => Promise<void>) {
  const database = new Database(":memory:");
  try {
    for (const file of ["0001_initial.sql", "0003_gemini_usage_model.sql", "0005_gemini_ambiguity_accounting.sql", "0006_gemini_timeout_admission.sql", "0008_monitoring_cycle_observability.sql"]) {
      database.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    const d1 = { prepare: (sql: string) => new D1Statement(database, sql), async batch(statements: D1Statement[]) {
      database.exec("BEGIN"); try { const r = []; for (const statement of statements) r.push(await statement.batchResult()); database.exec("COMMIT"); return r; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    } } as unknown as D1Database;
    await action(database, d1);
  } finally { database.close(); }
}

test("successful exact usage followed by invalid Batch output refines the same durable attempt", async () => {
  await withD1(async (_database, d1) => {
    const cycleId = "6d46738d-d269-4f9a-9f8f-1f615340fea8";
    const telemetry = new D1MonitoringTelemetry(d1);
    await telemetry.createCycle({ cycleId, scheduledAt: "2026-10-22T08:00:00.000Z", startedAt: "2026-10-22T08:00:00.100Z", sourceSha: null, workerVersion: null });
    const env = {
      DB: d1, BRAVE_SEARCH_API_KEY: "offline-brave", BRAVE_DAILY_SEARCH_LIMIT: "10", BRAVE_WEEKLY_SEARCH_LIMIT: "100", BRAVE_MONTHLY_SEARCH_LIMIT: "350",
      GEMINI_API_KEY: "offline-gemini", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50",
      GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
      RESEND_API_KEY: "offline-resend", NOTIFICATION_EMAIL: "offline@example.test",
    } satisfies RadarWorkerEnv;
    const dependencies = createWorkerMonitoringDependencies(env, { attemptTelemetry: { repository: telemetry, cycleId } });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ output_text: "not valid batch JSON", usage: {
        total_input_tokens: 2, total_output_tokens: 3, total_tokens: 5,
      } }));
      const candidate = { candidateId: "c001", source: { title: "Offline", url: "https://example.test/offline" },
        normalizedUrl: "https://example.test/offline", aliasKey: "https://example.test/offline", aliases: ["https://example.test/offline"],
        provenance: [{ kind: "brave" as const, queryOrdinal: 1, resultOrdinal: 1 }] };
      await assert.rejects(dependencies.analyze({ prompt: "offline", candidates: [candidate], promptBytes: 7, sizeExcluded: 0, truncationStage: "initial" }), BatchAnalysisError);
      const recovered = await telemetry.readCycle(cycleId);
      assert.deepEqual(recovered?.attempts.map(attempt => [attempt.ordinal, attempt.failureClass, attempt.accountingStatus]), [[1, "response_invalid", "exact"]]);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test("provider failures reach scheduled telemetry only through bounded reviewed classes", async (t) => {
  const cases = [
    {
      name: "model-specific 429",
      response: () => new Response(JSON.stringify({ error: {
        status: "RESOURCE_EXHAUSTED",
        message: "UNIQUE_PRIVATE_PROVIDER_TEXT_429",
        details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{
          quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
          quotaDimensions: { model: "gemini-3.8-flash" },
        }] }],
      } }), { status: 429, statusText: "Too Many Requests" }),
      providerFailureClass: "resource_exhausted_429",
      accountingStatus: "confirmed_zero",
      privateText: "UNIQUE_PRIVATE_PROVIDER_TEXT_429",
    },
    {
      name: "503 UNAVAILABLE",
      response: () => new Response(JSON.stringify({ error: {
        status: "UNAVAILABLE", message: "UNIQUE_PRIVATE_PROVIDER_TEXT_503",
      } }), { status: 503, statusText: "Service Unavailable" }),
      providerFailureClass: "unavailable_503",
      accountingStatus: "confirmed_zero",
      privateText: "UNIQUE_PRIVATE_PROVIDER_TEXT_503",
    },
    {
      name: "503 without provider status",
      response: () => new Response(JSON.stringify({ error: {
        message: "UNIQUE_PRIVATE_PROVIDER_TEXT_503_NO_STATUS",
      } }), { status: 503, statusText: "Service Unavailable" }),
      providerFailureClass: "unavailable_503",
      accountingStatus: "confirmed_zero",
      privateText: "UNIQUE_PRIVATE_PROVIDER_TEXT_503_NO_STATUS",
    },
    {
      name: "malformed untrusted quota payload",
      response: () => new Response(JSON.stringify({ error: {
        status: "RESOURCE_EXHAUSTED",
        message: "UNIQUE_PRIVATE_MALFORMED_PROVIDER_TEXT",
        details: [{ "@type": "private.example/UntrustedDetail", candidateTitle: "PRIVATE_CANDIDATE_TITLE" }],
      } }), { status: 429, statusText: "Too Many Requests" }),
      providerFailureClass: undefined,
      accountingStatus: "transport_ambiguous",
      privateText: "UNIQUE_PRIVATE_MALFORMED_PROVIDER_TEXT",
    },
  ] as const;

  for (const item of cases) await t.test(item.name, async () => {
    await withD1(async (_database, d1) => {
      const f = fixture();
      const usage = new D1GeminiUsageStore(d1);
      let fetchCalls = 0;
      f.dependencies.analyze = batch => analyzeBatch(batch, { generate: input => generateBatchWithGemini(input, {
        usageTracker: usage,
        cycleContext: f.dependencies.geminiCycleContext,
        environment: { GEMINI_API_KEY: "offline-key", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50", GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000" },
        sleep: async () => {}, random: () => 0,
        fetchImplementation: async () => { fetchCalls++; return item.response(); },
      }) });

      const result = await run(f.dependencies);
      const summary = createScheduledCycleSummary(result, {
        DB: d1, BRAVE_SEARCH_API_KEY: "offline-brave", BRAVE_DAILY_SEARCH_LIMIT: "10", BRAVE_WEEKLY_SEARCH_LIMIT: "100", BRAVE_MONTHLY_SEARCH_LIMIT: "350",
        GEMINI_API_KEY: "offline-key", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50",
        GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
        RESEND_API_KEY: "offline-resend", NOTIFICATION_EMAIL: "offline@example.test",
      });
      const data = await usage.getUsageData();

      const attempts = item.providerFailureClass === "unavailable_503" ? 3 : 1;
      assert.equal(fetchCalls, attempts);
      assert.equal(result.batch?.status, "provider_failed");
      assert.equal(result.batch?.providerFailureClass, item.providerFailureClass);
      assert.equal(summary.batch?.providerFailureClass, item.providerFailureClass);
      assert.equal(result.geminiProviderAttempts, attempts);
      assert.equal(data.records.length, attempts);
      assert.ok(data.records.every(record => record.accountingStatus === item.accountingStatus));
      assert.ok(data.records.every(record => [record.requestCount, record.inputTokens, record.outputTokens, record.totalTokens].join() === "1,0,0,0"));
      const serialized = JSON.stringify(summary);
      assert.equal(serialized.includes(item.privateText), false);
      assert.equal(serialized.includes("PRIVATE_CANDIDATE_TITLE"), false);
    });
  });
});

test("RF3 invalid analysis after exact provider settlement persists zero fresh rows with one dispatch and replay-only delivery", async () => {
  await withD1(async (database, d1) => {
    const f = fixture(); const replay = stored("https://example.test/replay"); f.discoveries.set(replay.normalizedUrl, replay);
    const usage = new D1GeminiUsageStore(d1); let fetchCalls = 0;
    f.dependencies.analyze = batch => analyzeBatch(batch, { generate: input => generateBatchWithGemini(input, {
      usageTracker: usage, cycleContext: f.dependencies.geminiCycleContext,
      environment: { GEMINI_API_KEY: "offline-key", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50", GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000" },
      fetchImplementation: async () => { fetchCalls++; return new Response(JSON.stringify({ output_text: "invalid analysis JSON", usage: { total_input_tokens: 12, total_output_tokens: 6, total_tokens: 18 } })); },
    }) });
    const result = await run(f.dependencies);
    assert.equal(fetchCalls, 1); assert.equal(result.analysesAttempted, 1); assert.equal(result.batch?.status, "invalid_output");
    assert.equal(result.newDiscoveries, 0); assert.equal(f.discoveries.size, 1); assert.equal(f.sent.length, 1); assert.equal(result.replayStoriesSent, 0);
    assert.match(f.sent[0]!.text, /AI analysis unavailable/i);
    assert.equal(result.geminiProviderAttempts, 1); assert.equal(result.batch?.providerDispatches, 1);
    assert.equal(result.batch?.reservations, 1); assert.equal(result.batch?.returnedStories, 0);
    assert.equal(result.batch?.acceptedStories, 0); assert.deepEqual(result.batch?.selected, []);
    const data = await usage.getUsageData(); assert.equal(data.records.length, 1); assert.equal(data.records[0]?.accountingStatus, "exact");
    assert.equal(data.records[0]?.totalTokens, 18); assert.equal(data.usageUnknown, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'x_%'").get()!.n, 0);
  });
});

test("complete Worker D1 batch composition has one provider dispatch for four selected stories and no X migration dependency", async () => {
  await withD1(async (database, d1) => {
    const env: RadarWorkerEnv = {
      DB: d1, BRAVE_SEARCH_API_KEY: "offline-brave", BRAVE_DAILY_SEARCH_LIMIT: "10", BRAVE_WEEKLY_SEARCH_LIMIT: "100", BRAVE_MONTHLY_SEARCH_LIMIT: "350",
      GEMINI_API_KEY: "offline-gemini", GEMINI_DAILY_REQUEST_LIMIT: "5", GEMINI_WEEKLY_REQUEST_LIMIT: "20", GEMINI_MONTHLY_REQUEST_LIMIT: "50",
      GEMINI_DAILY_TOKEN_LIMIT: "10000", GEMINI_WEEKLY_TOKEN_LIMIT: "30000", GEMINI_MONTHLY_TOKEN_LIMIT: "100000",
      RESEND_API_KEY: "offline-resend", NOTIFICATION_EMAIL: "offline@example.test", X_DISCOVERY_ENABLED: "false",
    };
    const requests: string[] = [];
    const observedTimings: unknown[] = [];
    const originalFetch = globalThis.fetch;
    let sourceUrls: string[] = [];
    try {
      globalThis.fetch = async (input, options) => {
        const url = new URL(String(input));
        requests.push(url.hostname);
        if (url.hostname === "api.search.brave.com") {
          const ordinal = requests.length;
          assert.equal(JSON.parse(String(options?.body)).count, 5);
          return new Response(JSON.stringify({ web: { results: Array.from({ length: 5 }, (_, i) => ({
            title: `Original query${ordinal} source${i + 1}`, url: `https://example.test/q${ordinal}/story${i + 1}`, description: "offline evidence",
          })) } }));
        }
        if (url.hostname === "generativelanguage.googleapis.com") {
          assert.equal(requests.length, 11, "all ten Brave requests precede the model request");
          const body = JSON.parse(String(options?.body));
          assert.equal(body.model, "gemini-3.8-flash");
          const data = JSON.parse(body.input.slice(body.input.indexOf('\n\n{"schemaVersion"') + 2));
          assert.equal(data.candidates.length, 24);
          const selected = [data.candidates[23], data.candidates[0], data.candidates[1], data.candidates[2]];
          sourceUrls = selected.map(candidate => {
            const position = Number(candidate.candidateId.slice(1)) - 1;
            return `https://example.test/q${Math.floor(position / 5) + 1}/story${position % 5 + 1}`;
          });
          return new Response(JSON.stringify({ output_text: JSON.stringify({ schemaVersion: 1, stories: selected.map((candidate, index) => ({
            candidateId: candidate.candidateId, relevanceScore: [9, 8, 6, 5][index], category: "developer_tool", name: candidate.title,
            summary: "What changed", whyItMatters: "Practical use", educationalValue: "Learning", technologies: [], projectOpportunities: [],
          })) }), usage: { total_input_tokens: 40, total_output_tokens: 20, total_tokens: 60 } }));
        }
        assert.equal(url.hostname, "api.resend.com");
        const email = JSON.parse(String(options?.body));
        assert.equal(email.subject, "AI Agent Radar — Daily Digest");
        assert.ok(email.text.includes("Original query4 source3"));
        assert.equal((email.text.match(/It could be relevant/g) ?? []).length, 2);
        assert.equal((email.html.match(/It could be relevant/g) ?? []).length, 2);
        return new Response(JSON.stringify({ id: "one-offline-email" }));
      };
      const dependencies = createWorkerMonitoringDependencies(env, {
        collectRss: async () => emptyRss(),
        onAttemptTiming: async timing => { observedTimings.push({ ...timing }); },
      });
      const result = await run(dependencies);
      assert.equal(result.failures, 0, JSON.stringify(result.outcomes.length ? result.outcomes : result.searchFailures));
      assert.deepEqual(requests, [...Array.from({ length: 10 }, () => "api.search.brave.com"), "generativelanguage.googleapis.com", "api.resend.com"]);
      assert.equal(result.analysesAttempted, 1); assert.equal(result.geminiProviderAttempts, 1); assert.equal(result.geminiFallbacks, 0);
      assert.equal(result.newDiscoveries, 4); assert.equal(result.notificationsSent, 1); assert.equal(result.freshStoriesSent, 4);
      assert.equal(result.batch?.reservationAttempts, 1); assert.equal(result.batch?.reservations, 1); assert.equal(result.batch?.providerDispatches, 1);
      assert.equal(result.batch?.returnedStories, 4); assert.equal(result.batch?.acceptedStories, 4);
      assert.equal(observedTimings.length, 1);
      assert.deepEqual(result.batch?.latency?.attemptTimings, observedTimings);
      assert.deepEqual(result.batch?.selected.map(entry => entry.candidateId), ["c018", "c001", "c006", "c011"]);
      assert.deepEqual(result.batch?.selected[0]?.provenance, [{ kind: "brave", queryOrdinal: 4, resultOrdinal: 3 }]);
      assert.equal(result.batch?.freshDelivered, 4); assert.equal(result.batch?.emailCount, 1);
      assert.deepEqual(database.prepare("SELECT normalized_url FROM discoveries ORDER BY normalized_url").all().map(row => row.normalized_url), [...sourceUrls].sort());
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM notifications").get()!.n, 4);
      const data = await new D1GeminiUsageStore(d1).getUsageData();
      assert.equal(data.records.length, 1); assert.equal(data.records[0]?.requestCount, 1); assert.equal(data.records[0]?.accountingStatus, "exact");
      assert.equal(data.records[0]?.totalTokens, 60); assert.equal(data.usageUnknown, false);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'x_%'").get()!.n, 0);
    } finally { globalThis.fetch = originalFetch; }
  });
});
