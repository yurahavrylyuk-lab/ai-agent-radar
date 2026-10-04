import assert from "node:assert/strict";
import test from "node:test";
import { MAX_NEW_ANALYSES_PER_CYCLE, MONITORING_QUERIES, MONITORING_QUERY, runMonitoringCycle } from "../src/services/monitor.js";
import { BraveUsageGuardDeniedError } from "../src/tools/webSearch.js";
import type { DiscoveryProcessingResult, NotificationResult, SearchResult } from "../src/types/index.js";

function searchResult(id: string): SearchResult {
  return { title: `Result ${id}`, url: `https://example.com/${id}`, snippet: `Snippet ${id}` };
}

function processed(result: SearchResult, status: DiscoveryProcessingResult["status"]): DiscoveryProcessingResult {
  return {
    status,
    discovery: {
      normalizedUrl: result.url,
      firstSeenAt: "2026-09-19T12:00:00.000Z",
      lastSeenAt: "2026-09-19T12:00:00.000Z",
      analysis: {
        name: result.title,
        category: "new_agent",
        summary: result.snippet ?? "",
        relevanceScore: 8,
        whyItMatters: "Useful for testing.",
        educationalValue: "Demonstrates monitoring cycles.",
        projectOpportunities: ["Build a prototype"],
        technologies: ["TypeScript"],
        sourceTitle: result.title,
        sourceUrl: result.url,
      },
    },
  };
}

const notification = (status: NotificationResult["status"]): NotificationResult => {
  if (status === "not_eligible") return { status };
  return { status, record: { normalizedUrl: "https://example.com/record", channel: "email", sentAt: "2026-09-19T14:00:00.000Z", providerMessageId: "email_123" } };
};

/** Creates a batch notify stub that returns the given status for every result. */
function batchNotify(status: NotificationResult["status"]) {
  return async (results: DiscoveryProcessingResult[]): Promise<Map<string, NotificationResult>> => {
    const map = new Map<string, NotificationResult>();
    for (const r of results) map.set(r.discovery.analysis.sourceUrl, notification(status));
    return map;
  };
}

test("default monitoring invokes the exact ten reviewed queries once and in order", async () => {
  const queries: string[] = [];
  await runMonitoringCycle(undefined, {
    search: async (query) => { queries.push(query); return []; },
  });
  assert.deepEqual(queries, [...MONITORING_QUERIES]);
  assert.equal(new Set(queries).size, 10);
  assert.deepEqual(MONITORING_QUERIES, [
    "AI news research product announcements",
    "AI agent framework releases",
    "AI model releases GPT Gemini open-source models capabilities",
    "programming language compiler standard library releases",
    "cloud DevOps Kubernetes networking security advisories",
    "Codex AI coding assistant developer features releases",
    "Claude Code AI coding assistant developer features releases",
    "IDE CLI CI/CD code review developer tools releases",
    "AI assisted software development workflow productivity examples",
    "useful AI IT tools techniques workflow tutorials",
  ]);
});

test("an explicit query preserves single-search behavior", async () => {
  const queries: string[] = [];
  await runMonitoringCycle("some query", {
    search: async (query) => { queries.push(query); return []; },
  });
  assert.deepEqual(queries, ["some query"]);
});

test("guard denial preserves earlier query results and stops later collection", async () => {
  const first = searchResult("first-query");
  const second = searchResult("second-query");
  const searches: string[] = [];
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle(undefined, {
    search: async (query) => {
      searches.push(query);
      if (searches.length === 1) return [first];
      if (searches.length === 2) return [second];
      throw new BraveUsageGuardDeniedError();
    },
    hasDiscovery: async () => true,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "duplicate"); },
    notify: batchNotify("not_eligible"),
  });
  assert.deepEqual(searches, [...MONITORING_QUERIES.slice(0, 3)]);
  assert.deepEqual(processedUrls, [first.url, second.url]);
  assert.equal(outcome.searchResultsReceived, 2);
  assert.equal(outcome.resultsProcessed, 2);
});

test("cross-query results reach the existing processing loop in query and provider order", async () => {
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle(undefined, {
    search: async (query) => {
      const index = MONITORING_QUERIES.indexOf(query as (typeof MONITORING_QUERIES)[number]);
      return [searchResult(String(index) + "-a"), searchResult(String(index) + "-b")];
    },
    hasDiscovery: async () => true,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "duplicate"); },
    notify: batchNotify("not_eligible"),
  });
  assert.equal(outcome.searchResultsReceived, 20);
  assert.deepEqual(processedUrls, Array.from({ length: 10 }, (_, index) => [
    "https://example.com/" + index + "-a",
    "https://example.com/" + index + "-b",
  ]).flat());
});

test("the four-analysis cap applies across the full default query batch", async () => {
  let processCalls = 0;
  const outcome = await runMonitoringCycle(undefined, {
    search: async (query) => [searchResult(String(MONITORING_QUERIES.indexOf(query as (typeof MONITORING_QUERIES)[number])))],
    hasDiscovery: async () => false,
    process: async (item) => { processCalls += 1; return processed(item, "new"); },
    notify: batchNotify("not_eligible"),
  });
  assert.equal(MAX_NEW_ANALYSES_PER_CYCLE, 4);
  assert.equal(processCalls, 4);
  assert.equal(outcome.analysesAttempted, 4);
  assert.equal(outcome.stoppedByAnalysisCap, true);
});

test("a non-guard failure during default collection retains abort behavior", async () => {
  let searches = 0;
  let processCalls = 0;
  await assert.rejects(runMonitoringCycle(undefined, {
    search: async () => {
      searches += 1;
      if (searches === 2) throw new Error("Brave unavailable");
      return [searchResult("collected-before-failure")];
    },
    process: async (item) => { processCalls += 1; return processed(item, "new"); },
  }), /Monitoring cycle search failed: Brave unavailable/);
  assert.equal(searches, 2);
  assert.equal(processCalls, 0);
});

test("zero search results return a clean summary without processing or notification", async () => {
  let processCalls = 0;
  let notificationCalls = 0;
  const outcome = await runMonitoringCycle(MONITORING_QUERY, {
    search: async () => [],
    hasDiscovery: async () => { throw new Error("should not inspect history"); },
    process: async () => { processCalls++; throw new Error("unreachable"); },
    notify: async (_results) => { notificationCalls++; return new Map(); },
  });
  assert.equal(outcome.searchResultsReceived, 0);
  assert.equal(outcome.resultsProcessed, 0);
  assert.equal(outcome.outcomes.length, 0);
  assert.equal(processCalls, 0);
  assert.equal(notificationCalls, 0);
});

test("all duplicates use zero analysis slots and still reach batch notification", async () => {
  const results = [searchResult("one"), searchResult("two"), searchResult("three")];
  let processCalls = 0;
  let notificationBatchCalls = 0;
  const outcome = await runMonitoringCycle("test", {
    search: async () => results,
    hasDiscovery: async () => true,
    process: async (item) => { processCalls++; return processed(item, "duplicate"); },
    notify: async (items) => {
      notificationBatchCalls++;
      const map = new Map<string, NotificationResult>();
      for (const r of items) map.set(r.discovery.analysis.sourceUrl, notification("not_eligible"));
      return map;
    },
  });
  assert.equal(outcome.analysesAttempted, 0);
  assert.equal(outcome.duplicates, 3);
  assert.equal(outcome.resultsProcessed, 3);
  assert.equal(outcome.notificationsNotEligible, 3);
  assert.equal(processCalls, 3);
  assert.equal(notificationBatchCalls, 1); // one batch call for all three items
});

test("with fewer new results than the cap all are analyzed without stopping", async () => {
  const results = [searchResult("one"), searchResult("two"), searchResult("three")];
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle("test", {
    search: async () => results,
    hasDiscovery: async () => false,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "new"); },
    notify: batchNotify("not_eligible"),
  });
  assert.equal(MAX_NEW_ANALYSES_PER_CYCLE, 4);
  assert.equal(outcome.analysesAttempted, 3);
  assert.equal(outcome.newDiscoveries, 3);
  assert.equal(outcome.stoppedByAnalysisCap, false);
  assert.deepEqual(processedUrls, results.map((item) => item.url));
});

test("many duplicates consume zero slots before one unseen result", async () => {
  const results = [searchResult("duplicate-one"), searchResult("duplicate-two"), searchResult("duplicate-three"), searchResult("new-one")];
  const duplicateUrls = new Set(results.slice(0, 3).map((item) => item.url));
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle("test", {
    search: async () => results,
    hasDiscovery: async (url) => duplicateUrls.has(url),
    process: async (item) => {
      processedUrls.push(item.url);
      return processed(item, duplicateUrls.has(item.url) ? "duplicate" : "new");
    },
    notify: batchNotify("not_eligible"),
  });
  assert.equal(outcome.duplicates, 3);
  assert.equal(outcome.newDiscoveries, 1);
  assert.equal(outcome.analysesAttempted, 1);
  assert.equal(outcome.stoppedByAnalysisCap, false);
  assert.deepEqual(processedUrls, results.map((item) => item.url));
});

test("duplicate, new, duplicate, new — all four items processed within the four-analysis cap", async () => {
  const results = [searchResult("duplicate-one"), searchResult("new-one"), searchResult("duplicate-two"), searchResult("new-two")];
  const duplicateUrls = new Set([results[0].url, results[2].url]);
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle("test", {
    search: async () => results,
    hasDiscovery: async (url) => duplicateUrls.has(url),
    process: async (item) => {
      processedUrls.push(item.url);
      return processed(item, duplicateUrls.has(item.url) ? "duplicate" : "new");
    },
    notify: batchNotify("not_eligible"),
  });
  assert.equal(outcome.duplicates, 2);
  assert.equal(outcome.newDiscoveries, 2);
  assert.equal(outcome.analysesAttempted, 2);
  assert.equal(outcome.stoppedByAnalysisCap, false);
  assert.deepEqual(processedUrls, results.map((item) => item.url));
  assert.equal(outcome.resultsProcessed, outcome.duplicates + outcome.newDiscoveries);
});

test("a new low-relevance discovery records a not-eligible notification outcome", async () => {
  const item = searchResult("low-relevance");
  const outcome = await runMonitoringCycle("test", {
    search: async () => [item],
    hasDiscovery: async () => false,
    process: async () => processed(item, "new"),
    notify: batchNotify("not_eligible"),
  });
  assert.equal(outcome.notificationsNotEligible, 1);
  assert.deepEqual(outcome.outcomes[0].notificationStatus, "not_eligible");
});

test("an eligible new discovery increments sent notifications", async () => {
  const item = searchResult("eligible");
  const outcome = await runMonitoringCycle("test", {
    search: async () => [item],
    hasDiscovery: async () => false,
    process: async () => processed(item, "new"),
    notify: batchNotify("sent"),
  });
  assert.equal(outcome.notificationsSent, 1);
  assert.equal(outcome.notificationsAlreadySent, 0);
});

test("an already-sent outcome increments its dedicated summary count", async () => {
  const item = searchResult("already-sent");
  const outcome = await runMonitoringCycle("test", {
    search: async () => [item],
    hasDiscovery: async () => false,
    process: async () => processed(item, "new"),
    notify: batchNotify("already_sent"),
  });
  assert.equal(outcome.notificationsAlreadySent, 1);
  assert.equal(outcome.notificationsSent, 0);
});

test("search failure aborts the cycle before processing starts", async () => {
  let processCalls = 0;
  await assert.rejects(runMonitoringCycle("test", {
    search: async () => { throw new Error("Brave unavailable"); },
    process: async (item) => { processCalls++; return processed(item, "new"); },
  }), /Monitoring cycle search failed: Brave unavailable/);
  assert.equal(processCalls, 0);
});

test("a failed analysis counts against the cap and the cycle continues with remaining capacity", async () => {
  const results = [searchResult("failure"), searchResult("success"), searchResult("skipped")];
  let processCalls = 0;
  const outcome = await runMonitoringCycle("test", {
    search: async () => results,
    hasDiscovery: async () => false,
    process: async (item) => {
      processCalls++;
      if (item.url === results[0].url) throw new Error("Gemini analysis failed");
      return processed(item, "new");
    },
    notify: batchNotify("not_eligible"),
  });
  // cap=4, 3 new results: failure consumes 1 slot, success and skipped consume 1 each
  assert.equal(processCalls, 3);
  assert.equal(outcome.analysesAttempted, 3);
  assert.equal(outcome.failures, 1);
  assert.equal(outcome.newDiscoveries, 2);
  assert.equal(outcome.stoppedByAnalysisCap, false);
});

test("notification failure is represented without retrying processing or notification", async () => {
  const item = searchResult("notification-failure");
  let notificationCalls = 0;
  const outcome = await runMonitoringCycle("test", {
    search: async () => [item],
    hasDiscovery: async () => false,
    process: async () => processed(item, "new"),
    notify: async (_results) => { notificationCalls++; throw new Error("email delivery failed"); },
  });
  assert.equal(notificationCalls, 1);
  assert.equal(outcome.failures, 1);
  assert.match(outcome.outcomes[0].error ?? "", /email delivery failed/);
});

test("discovery-history lookup failure prevents processing", async () => {
  let processCalls = 0;
  await assert.rejects(runMonitoringCycle("test", {
    search: async () => [searchResult("history-failure")],
    hasDiscovery: async () => { throw new Error("history is corrupted"); },
    process: async (item) => { processCalls++; return processed(item, "new"); },
  }), /unable to verify discovery history: history is corrupted/);
  assert.equal(processCalls, 0);
});

test("the cycle does not mutate SearchResult inputs", async () => {
  const input = [searchResult("immutable")];
  const original = structuredClone(input);
  await runMonitoringCycle("test", {
    search: async () => input,
    hasDiscovery: async () => true,
    process: async (item) => processed(item, "duplicate"),
    notify: batchNotify("not_eligible"),
  });
  assert.deepEqual(input, original);
});
