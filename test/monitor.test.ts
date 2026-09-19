import assert from "node:assert/strict";
import test from "node:test";
import { MAX_NEW_ANALYSES_PER_CYCLE, MONITORING_QUERY, runMonitoringCycle } from "../src/services/monitor.js";
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

test("zero search results return a clean summary without processing or notification", async () => {
  let processCalls = 0;
  let notificationCalls = 0;
  const outcome = await runMonitoringCycle(MONITORING_QUERY, {
    search: async () => [],
    hasDiscovery: async () => { throw new Error("should not inspect history"); },
    process: async () => { processCalls++; throw new Error("unreachable"); },
    notify: async () => { notificationCalls++; return notification("not_eligible"); },
  });
  assert.equal(outcome.searchResultsReceived, 0);
  assert.equal(outcome.resultsProcessed, 0);
  assert.equal(outcome.outcomes.length, 0);
  assert.equal(processCalls, 0);
  assert.equal(notificationCalls, 0);
});

test("all duplicates use zero analysis slots and still reach notification processing", async () => {
  const results = [searchResult("one"), searchResult("two"), searchResult("three")];
  let processCalls = 0;
  let notificationCalls = 0;
  const outcome = await runMonitoringCycle("test", {
    search: async () => results,
    hasDiscovery: async () => true,
    process: async (item) => { processCalls++; return processed(item, "duplicate"); },
    notify: async () => { notificationCalls++; return notification("not_eligible"); },
  });
  assert.equal(outcome.analysesAttempted, 0);
  assert.equal(outcome.duplicates, 3);
  assert.equal(outcome.resultsProcessed, 3);
  assert.equal(outcome.notificationsNotEligible, 3);
  assert.equal(processCalls, 3);
  assert.equal(notificationCalls, 3);
});

test("only the first two unseen results reach analysis processing", async () => {
  const results = [searchResult("one"), searchResult("two"), searchResult("three")];
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle("test", {
    search: async () => results,
    hasDiscovery: async () => false,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "new"); },
    notify: async () => notification("not_eligible"),
  });
  assert.equal(MAX_NEW_ANALYSES_PER_CYCLE, 2);
  assert.equal(outcome.analysesAttempted, 2);
  assert.equal(outcome.newDiscoveries, 2);
  assert.equal(outcome.stoppedByAnalysisCap, true);
  assert.deepEqual(processedUrls, results.slice(0, 2).map((item) => item.url));
});

test("duplicates do not consume the budget before two new discoveries", async () => {
  const results = [searchResult("duplicate-one"), searchResult("new-one"), searchResult("duplicate-two"), searchResult("new-two"), searchResult("new-three")];
  const duplicateUrls = new Set([results[0].url, results[2].url]);
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle("test", {
    search: async () => results,
    hasDiscovery: async (url) => duplicateUrls.has(url),
    process: async (item) => {
      processedUrls.push(item.url);
      return processed(item, duplicateUrls.has(item.url) ? "duplicate" : "new");
    },
    notify: async () => notification("not_eligible"),
  });
  assert.equal(outcome.duplicates, 2);
  assert.equal(outcome.newDiscoveries, 2);
  assert.equal(outcome.analysesAttempted, 2);
  assert.equal(outcome.stoppedByAnalysisCap, true);
  assert.deepEqual(processedUrls, results.slice(0, 4).map((item) => item.url));
  assert.equal(outcome.resultsProcessed, outcome.duplicates + outcome.newDiscoveries);
});

test("a new low-relevance discovery records a not-eligible notification outcome", async () => {
  const item = searchResult("low-relevance");
  const outcome = await runMonitoringCycle("test", {
    search: async () => [item],
    hasDiscovery: async () => false,
    process: async () => processed(item, "new"),
    notify: async () => notification("not_eligible"),
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
    notify: async () => notification("sent"),
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
    notify: async () => notification("already_sent"),
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

test("failed new analysis consumes a slot and later safe results continue without retry", async () => {
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
    notify: async () => notification("not_eligible"),
  });
  assert.equal(processCalls, 2);
  assert.equal(outcome.analysesAttempted, 2);
  assert.equal(outcome.failures, 1);
  assert.equal(outcome.newDiscoveries, 1);
  assert.equal(outcome.stoppedByAnalysisCap, true);
});

test("notification failure is represented without retrying processing or notification", async () => {
  const item = searchResult("notification-failure");
  let notificationCalls = 0;
  const outcome = await runMonitoringCycle("test", {
    search: async () => [item],
    hasDiscovery: async () => false,
    process: async () => processed(item, "new"),
    notify: async () => { notificationCalls++; throw new Error("email delivery failed"); },
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
    notify: async () => notification("not_eligible"),
  });
  assert.deepEqual(input, original);
});
