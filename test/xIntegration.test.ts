import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDiscoveryHistory } from "../src/services/discoveryHistory.js";
import { formatDigestEmail } from "../src/services/discoveryEmailFormatter.js";
import { notifyDeliveryDigest } from "../src/services/notificationOrchestrator.js";
import { processSearchResult } from "../src/services/discoveryProcessor.js";
import { runMonitoringCycle } from "../src/services/monitor.js";
import type { AgentAnalysis, SearchResult, StoredDiscovery, XSourceProvenance } from "../src/types/index.js";

const available = { allowed: true as const, counts: { dailyRequests: 0, weeklyRequests: 0, monthlyRequests: 0, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 0 }, limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 } };
const provenance: XSourceProvenance = { kind: "x", postId: "9007199254740993000", authorId: "1353836358901501952", postUrl: "https://x.com/i/web/status/9007199254740993000", label: "Anthropic" };
const analysis = (result: SearchResult, score = 8): AgentAnalysis => ({ name: result.title, category: "developer_tool", summary: "Summary", relevanceScore: score, whyItMatters: "Why", educationalValue: "Learn", projectOpportunities: ["Build"], technologies: ["TypeScript"], sourceTitle: result.title, sourceUrl: result.url });
const emptyXResult = { candidates: [], postStoryUrls: new Map<string, string>(), requestsAttempted: 0, postsReceived: 0, candidatesAdmitted: 0, duplicates: 0, accountsFailed: 0, truncated: false, failures: [], blockedReason: "disabled" as const };
const memoryHistory = () => ({
  getDiscovery: async () => undefined,
  listRecentDiscoveries: async () => ({ discoveries: [], truncated: false }),
  recordDiscovery: async () => { throw new Error("unused"); },
  touchDiscovery: async () => undefined,
});

async function runDirectXStatusScenario(
  braveResults: SearchResult[],
  resolveXPost: (postId: string) => Promise<{ storyUrl: string; provenance?: XSourceProvenance } | undefined>,
) {
  const processed: Array<{ result: SearchResult; provenance?: XSourceProvenance }> = [];
  let searchCalls = 0;
  const cycle = await runMonitoringCycle(undefined, {
    now: () => new Date("2026-10-08T08:00:00.000Z"),
    geminiPreflight: async () => available,
    history: memoryHistory(),
    search: async () => { searchCalls += 1; return searchCalls === 1 ? braveResults : []; },
    collectX: async () => emptyXResult,
    resolveXPost,
    process: async (result, sourceProvenance) => {
      processed.push({ result, provenance: sourceProvenance });
      return { status: "new", discovery: { normalizedUrl: result.url, firstSeenAt: "2026-10-08T08:00:00.000Z", lastSeenAt: "2026-10-08T08:00:00.000Z", analysis: analysis(result), sourceProvenance } };
    },
    notify: async () => ({ notifications: new Map(), eligibleCandidates: [], sentCandidates: [] }),
  });
  return { cycle, processed };
}

test("X provenance is application-owned, copied, persisted and retained on touch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radar-x-history-"));
  const file = join(directory, "history.json");
  const history = new JsonDiscoveryHistory(file);
  const result = { title: "X announcement — Anthropic", url: "https://example.com/release" };
  const processed = await processSearchResult(result, { history, analyze: async () => ({ ...analysis(result), sourceProvenance: { kind: "x", postId: "bad" } } as AgentAnalysis), sourceProvenance: provenance, now: () => new Date("2026-10-08T08:00:00.000Z") });
  assert.equal(processed.discovery.sourceProvenance?.postId, provenance.postId);
  const touched = await history.touchDiscovery(result.url, new Date("2026-10-08T09:00:00.000Z"));
  assert.deepEqual(touched?.sourceProvenance, provenance);
  assert.doesNotMatch(await readFile(file, "utf8"), /"postId": "bad"/);
});

test("X provenance rejects noncanonical post identity metadata", async () => {
  const history = new JsonDiscoveryHistory(join(await mkdtemp(join(tmpdir(), "radar-x-invalid-")), "history.json"));
  const result = { title: "X announcement", url: "https://example.com/release" };
  await assert.rejects(
    history.recordDiscovery(analysis(result), new Date("2026-10-08T08:00:00.000Z"), {
      ...provenance,
      postUrl: `${provenance.postUrl}?tracking=not-canonical`,
    }),
    /source provenance is invalid/,
  );
});

test("X-derived below-threshold discovery is excluded from P4 fallback but normal relevance remains eligible", async () => {
  const sent: string[] = [];
  const notificationHistory = { hasNotificationBeenSent: async () => false, getNotificationRecord: async () => undefined, recordNotificationSent: async (url: string) => ({ normalizedUrl: url, channel: "email" as const, sentAt: "2026-10-08T08:00:00.000Z", providerMessageId: "id" }) };
  const make = (score: number): StoredDiscovery => ({ normalizedUrl: "https://openai.com/release", firstSeenAt: "2026-10-08T07:00:00.000Z", lastSeenAt: "2026-10-08T07:00:00.000Z", analysis: analysis({ title: "X", url: "https://openai.com/release" }, score), sourceProvenance: provenance });
  const low = await notifyDeliveryDigest([{ discovery: make(6), origin: "fresh" }], { history: notificationHistory, sendEmail: async () => { sent.push("sent"); return { id: "id" }; } });
  assert.equal(low.sentCandidates.length, 0); assert.equal(sent.length, 0);
  const high = await notifyDeliveryDigest([{ discovery: make(7), origin: "replay" }], { history: notificationHistory, sendEmail: async () => { sent.push("sent"); return { id: "id" }; } });
  assert.equal(high.sentCandidates.length, 1); assert.equal(sent.length, 1);
});

test("digest visibly attributes linked X observations without replacing the primary article", () => {
  const story: StoredDiscovery = { normalizedUrl: "https://example.com/release", firstSeenAt: "2026-10-08T07:00:00.000Z", lastSeenAt: "2026-10-08T07:00:00.000Z", analysis: analysis({ title: "X announcement — Anthropic", url: "https://example.com/release" }), sourceProvenance: provenance };
  const email = formatDigestEmail([story]);
  assert.match(email.text, /Reported on X by Anthropic/); assert.match(email.text, /https:\/\/x\.com\/i\/web\/status/); assert.match(email.text, /https:\/\/example\.com\/release/);
  assert.match(email.html, /View X post/);
});

test("unified selector never exceeds four analyses and a full Brave pool can starve appended X", async () => {
  const analyzed: string[] = [];
  const brave = [
    { title: "Codex release", url: "https://example.com/0" },
    { title: "Claude Code release", url: "https://example.com/1" },
    ...Array.from({ length: 3 }, (_, index) => ({ title: `Generic ${index}`, url: `https://example.com/${index + 2}` })),
  ];
  const xResult = { title: "X announcement — OpenAI", url: "https://x.example/release", snippet: "Codex announcement" };
  let searchCalls = 0;
  const result = await runMonitoringCycle(undefined, {
    now: () => new Date("2026-10-08T08:00:00.000Z"), geminiPreflight: async () => available,
    history: { getDiscovery: async () => undefined, listRecentDiscoveries: async () => ({ discoveries: [], truncated: false }), recordDiscovery: async () => { throw new Error("unused"); }, touchDiscovery: async () => undefined },
    search: async () => { searchCalls += 1; return searchCalls === 1 ? brave : []; },
    collectX: async () => ({ candidates: [{ result: xResult, provenance, storyUrl: xResult.url }], postStoryUrls: new Map(), requestsAttempted: 1, postsReceived: 1, candidatesAdmitted: 1, duplicates: 0, accountsFailed: 0, truncated: false, failures: [] }),
    process: async (search, source) => { analyzed.push(search.url); return { status: "new", discovery: { normalizedUrl: search.url, firstSeenAt: "2026-10-08T08:00:00.000Z", lastSeenAt: "2026-10-08T08:00:00.000Z", analysis: analysis(search), sourceProvenance: source } }; },
    notify: async () => ({ notifications: new Map(), eligibleCandidates: [], sentCandidates: [] }), markXStoryProcessed: async () => undefined,
  });
  assert.equal(result.analysesAttempted, 4); assert.equal(new Set(analyzed).size, 4); assert.equal(analyzed.includes(xResult.url), false);
});

test("sparse Brave acquisition admits an X candidate through the existing selector", async () => {
  const processed: Array<{ url: string; provenance?: XSourceProvenance }> = [];
  const xResult = { title: "X announcement — OpenAI", url: "https://x.example/release", snippet: "Codex announcement" };
  let searchCalls = 0;
  const result = await runMonitoringCycle(undefined, {
    now: () => new Date("2026-10-08T08:00:00.000Z"), geminiPreflight: async () => available,
    history: { getDiscovery: async () => undefined, listRecentDiscoveries: async () => ({ discoveries: [], truncated: false }), recordDiscovery: async () => { throw new Error("unused"); }, touchDiscovery: async () => undefined },
    search: async () => { searchCalls += 1; return searchCalls === 1 ? [{ title: "Generic", url: "https://example.com/generic" }] : []; },
    collectX: async () => ({ candidates: [{ result: xResult, provenance, storyUrl: xResult.url }], postStoryUrls: new Map(), requestsAttempted: 1, postsReceived: 1, candidatesAdmitted: 1, duplicates: 0, accountsFailed: 0, truncated: false, failures: [] }),
    process: async (search, source) => { processed.push({ url: search.url, provenance: source }); return { status: "new", discovery: { normalizedUrl: search.url, firstSeenAt: "2026-10-08T08:00:00.000Z", lastSeenAt: "2026-10-08T08:00:00.000Z", analysis: analysis(search), sourceProvenance: source } }; },
    notify: async () => ({ notifications: new Map(), eligibleCandidates: [], sentCandidates: [] }), markXStoryProcessed: async () => undefined,
  });
  assert.equal(result.xRequestsAttempted, 1); assert.equal(processed.some((item) => item.provenance?.kind === "x"), true); assert.equal(result.analysesAttempted, 2);
});

test("Brave-first and X-later coalescing preserves Brave analysis input and persists first X provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radar-x-coalesce-"));
  const history = new JsonDiscoveryHistory(join(directory, "history.json"));
  const url = "https://openai.com/index/shared";
  const braveResult = { title: "Brave article title", url, snippet: "Brave article summary" };
  const xResult = { title: "X announcement text", url, snippet: "Untrusted X post text" };
  const analyzed: SearchResult[] = [];
  const sent: string[] = [];
  const notificationHistory = { hasNotificationBeenSent: async () => false, getNotificationRecord: async () => undefined, recordNotificationSent: async (storyUrl: string) => ({ normalizedUrl: storyUrl, channel: "email" as const, sentAt: "2026-10-08T08:00:00.000Z", providerMessageId: "id" }) };
  let searchCalls = 0; let marked = 0;
  const result = await runMonitoringCycle(undefined, {
    now: () => new Date("2026-10-08T08:00:00.000Z"), geminiPreflight: async () => available,
    history,
    search: async () => { searchCalls += 1; return searchCalls === 1 ? [braveResult] : []; },
    collectX: async () => ({ candidates: [{ result: xResult, provenance, storyUrl: url }], postStoryUrls: new Map(), requestsAttempted: 1, postsReceived: 1, candidatesAdmitted: 1, duplicates: 0, accountsFailed: 0, truncated: false, failures: [] }),
    process: (search, sourceProvenance) => processSearchResult(search, { history, sourceProvenance, now: () => new Date("2026-10-08T08:00:00.000Z"), analyze: async (input) => { analyzed.push({ ...input }); return analysis(input, 6); } }),
    notify: (candidates) => notifyDeliveryDigest(candidates, { history: notificationHistory, sendEmail: async () => { sent.push("sent"); return { id: "id" }; } }),
    markXStoryProcessed: async () => { marked += 1; },
  });
  assert.equal(result.analysesAttempted, 1);
  assert.deepEqual(analyzed, [braveResult]);
  assert.doesNotMatch(JSON.stringify(analyzed), /X announcement text|Untrusted X post text/);
  assert.equal(result.newDiscoveries, 1); assert.equal(result.duplicates, 1); assert.equal(result.xDuplicates, 1); assert.equal(marked, 1);
  const stored = await history.getDiscovery(url);
  assert.deepEqual(stored?.sourceProvenance, provenance);
  assert.equal(stored?.analysis.sourceTitle, braveResult.title);
  assert.equal(sent.length, 0, "below-threshold X-derived fresh discovery must not enter P4 fallback");

  const replayLow = await notifyDeliveryDigest([{ discovery: stored as StoredDiscovery, origin: "replay" }], { history: notificationHistory, sendEmail: async () => { sent.push("sent"); return { id: "id" }; } });
  assert.equal(replayLow.sentCandidates.length, 0);
  assert.deepEqual((replayLow.notifications.get(url)), { status: "not_eligible" });
  const normal = { ...(stored as StoredDiscovery), analysis: { ...(stored as StoredDiscovery).analysis, relevanceScore: 7 } };
  const replayNormal = await notifyDeliveryDigest([{ discovery: normal, origin: "replay" }], { history: notificationHistory, sendEmail: async () => { sent.push("sent"); return { id: "id" }; } });
  assert.equal(replayNormal.sentCandidates.length, 1, "normal relevance remains eligible");
  assert.equal(sent.length, 1);
});

test("known Brave X status coalesces to its frozen story URL and retains validated provenance", async () => {
  const direct = { title: "Brave X result", url: `https://x.com/AnthropicAI/status/${provenance.postId}`, snippet: "Brave snippet" };
  const storyUrl = "https://openai.com/index/frozen-story";
  const { cycle, processed } = await runDirectXStatusScenario([direct], async (postId) => {
    assert.equal(postId, provenance.postId);
    return { storyUrl, provenance };
  });
  assert.equal(cycle.analysesAttempted, 1);
  assert.deepEqual(processed, [{ result: { ...direct, url: storyUrl }, provenance }]);
});

test("known X status mapping without provenance coalesces without inventing provenance", async () => {
  const direct = { title: "Brave X result", url: `https://twitter.com/AnthropicAI/status/${provenance.postId}` };
  const storyUrl = "https://example.com/frozen-story";
  const { processed } = await runDirectXStatusScenario([direct], async () => ({ storyUrl }));
  assert.deepEqual(processed, [{ result: { ...direct, url: storyUrl }, provenance: undefined }]);
});

test("unknown Brave X status is omitted instead of being analyzed as an article", async () => {
  const direct = { title: "Unknown X status", url: `https://www.x.com/user/status/${provenance.postId}` };
  const { cycle, processed } = await runDirectXStatusScenario([direct], async () => undefined);
  assert.equal(cycle.analysesAttempted, 0);
  assert.equal(cycle.searchResultsReceived, 0);
  assert.deepEqual(processed, []);
});

test("unknown X status does not suppress an ordinary Brave article", async () => {
  const ordinary = { title: "Ordinary article", url: "https://example.com/ordinary" };
  const direct = { title: "Unknown X status", url: `https://x.com/user/status/${provenance.postId}` };
  const { cycle, processed } = await runDirectXStatusScenario([direct, ordinary], async () => undefined);
  assert.equal(cycle.analysesAttempted, 1);
  assert.deepEqual(processed.map((item) => item.result), [ordinary]);
});

test("X lookup failure fails closed for the status URL without suppressing ordinary Brave results", async () => {
  const ordinary = { title: "Ordinary article", url: "https://example.com/ordinary" };
  const direct = { title: "Unavailable X status", url: `https://x.com/user/status/${provenance.postId}` };
  const { cycle, processed } = await runDirectXStatusScenario([ordinary, direct], async () => { throw new Error("store unavailable"); });
  assert.equal(cycle.xBlockedReason, "disabled");
  assert.equal(cycle.analysesAttempted, 1);
  assert.deepEqual(processed.map((item) => item.result), [ordinary]);
});

test("mapped X status and existing article observation share one analysis identity", async () => {
  const storyUrl = "https://example.com/shared-story";
  const ordinary = { title: "Original Brave article", url: storyUrl, snippet: "Original article snippet" };
  const direct = { title: "Brave X status", url: `https://www.twitter.com/user/status/${provenance.postId}`, snippet: "Status snippet" };
  const { cycle, processed } = await runDirectXStatusScenario([ordinary, direct], async () => ({ storyUrl, provenance }));
  assert.equal(cycle.analysesAttempted, 1);
  assert.equal(processed.length, 2, "the repeated observation touches the same identity without another analysis slot");
  assert.deepEqual(processed[0], { result: ordinary, provenance });
});

test("multiple X observations retain the first stable provenance for one article", async () => {
  const url = "https://example.com/multi-source-story";
  const secondProvenance: XSourceProvenance = { ...provenance, postId: "9007199254740993001", postUrl: "https://x.com/i/web/status/9007199254740993001", authorId: "4398626122", label: "OpenAI" };
  let searchCalls = 0;
  const observedSources: Array<XSourceProvenance | undefined> = [];
  const cycle = await runMonitoringCycle(undefined, {
    now: () => new Date("2026-10-08T08:00:00.000Z"), geminiPreflight: async () => available,
    history: memoryHistory(),
    search: async () => { searchCalls += 1; return searchCalls === 1 ? [{ title: "Brave article", url }] : []; },
    collectX: async () => ({
      candidates: [
        { result: { title: "First X observation", url }, provenance, storyUrl: url },
        { result: { title: "Second X observation", url }, provenance: secondProvenance, storyUrl: url },
      ],
      postStoryUrls: new Map(), requestsAttempted: 2, postsReceived: 2, candidatesAdmitted: 2, duplicates: 0, accountsFailed: 0, truncated: false, failures: [],
    }),
    process: async (searchResult, sourceProvenance) => {
      observedSources.push(sourceProvenance);
      return { status: observedSources.length === 1 ? "new" : "duplicate", discovery: { normalizedUrl: url, firstSeenAt: "2026-10-08T08:00:00.000Z", lastSeenAt: "2026-10-08T08:00:00.000Z", analysis: analysis(searchResult), sourceProvenance } };
    },
    notify: async () => ({ notifications: new Map(), eligibleCandidates: [], sentCandidates: [] }),
  });
  assert.equal(cycle.analysesAttempted, 1);
  assert.deepEqual(observedSources[0], provenance);
  assert.notDeepEqual(observedSources[0], secondProvenance);
});

test("direct X-status coalescing keeps P4 protection and normal score eligibility", async () => {
  const storyUrl = "https://openai.com/index/direct-story";
  const direct = { title: "Brave X result", url: `https://x.com/user/status/${provenance.postId}` };
  const { processed } = await runDirectXStatusScenario([direct], async () => ({ storyUrl, provenance }));
  const base = processed[0];
  assert.deepEqual(base?.provenance, provenance);
  const notificationHistory = { hasNotificationBeenSent: async () => false, getNotificationRecord: async () => undefined, recordNotificationSent: async (url: string) => ({ normalizedUrl: url, channel: "email" as const, sentAt: "2026-10-08T08:00:00.000Z", providerMessageId: "id" }) };
  const stored = (score: number): StoredDiscovery => ({ normalizedUrl: storyUrl, firstSeenAt: "2026-10-08T08:00:00.000Z", lastSeenAt: "2026-10-08T08:00:00.000Z", analysis: analysis({ ...base!.result, url: storyUrl }, score), sourceProvenance: base!.provenance });
  let sends = 0;
  const low = await notifyDeliveryDigest([{ discovery: stored(6), origin: "fresh" }], { history: notificationHistory, sendEmail: async () => { sends += 1; return { id: "id" }; } });
  assert.equal(low.sentCandidates.length, 0); assert.equal(sends, 0);
  const high = await notifyDeliveryDigest([{ discovery: stored(7), origin: "fresh" }], { history: notificationHistory, sendEmail: async () => { sends += 1; return { id: "id" }; } });
  assert.equal(high.sentCandidates.length, 1); assert.equal(sends, 1);
});

test("Gemini preflight denial performs zero Brave and X acquisition", async () => {
  let brave = 0; let x = 0;
  const result = await runMonitoringCycle(undefined, { now: () => new Date("2026-10-08T08:00:00.000Z"), geminiPreflight: async () => ({ allowed: false, reason: "daily_request_limit" }), history: { getDiscovery: async () => undefined, listRecentDiscoveries: async () => ({ discoveries: [], truncated: false }), recordDiscovery: async () => { throw new Error("unused"); }, touchDiscovery: async () => undefined }, search: async () => { brave += 1; return []; }, collectX: async () => { x += 1; throw new Error("must not run"); } });
  assert.equal(brave, 0); assert.equal(x, 0); assert.equal(result.xRequestsAttempted, 0);
});
