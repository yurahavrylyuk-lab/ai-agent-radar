import assert from "node:assert/strict";
import test from "node:test";
import { MAX_NEW_ANALYSES_PER_CYCLE, MAX_SEARCH_FAILURE_ERROR_LENGTH, MONITORING_QUERIES, MONITORING_QUERY, runMonitoringCycle as runProductionMonitoringCycle, type MonitoringCycleDependencies } from "../src/services/monitor.js";
import type { DiscoveryHistory } from "../src/services/discoveryHistory.js";
import type { NotificationHistory } from "../src/services/notificationHistory.js";
import { BraveUsageGuardDeniedError } from "../src/tools/webSearch.js";
import type { AgentAnalysis, DeliveryCandidate, DiscoveryProcessingResult, NotificationRecord, NotificationResult, SearchResult, StoredDiscovery } from "../src/types/index.js";

function emptyHistory(): DiscoveryHistory {
  return {
    getDiscovery: async () => undefined,
    listDiscoveries: async () => [],
    listRecentDiscoveries: async () => ({ discoveries: [], truncated: false }),
    recordDiscovery: async () => { throw new Error("Unexpected discovery write."); },
    touchDiscovery: async () => { throw new Error("Unexpected discovery touch."); },
  };
}

function memoryHistory(discoveries: StoredDiscovery[]): DiscoveryHistory {
  const stored = new Map(discoveries.map((item) => [item.normalizedUrl, structuredClone(item)]));
  return {
    async getDiscovery(url) { return stored.get(url.replace(/\/$/, "")); },
    async listRecentDiscoveries(query) {
      const items = [...stored.values()]
        .filter((item) => item.firstSeenAt >= query.fromInclusive && item.firstSeenAt < query.beforeExclusive)
        .sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt) || a.normalizedUrl.localeCompare(b.normalizedUrl));
      return { discoveries: items.slice(0, query.limit), truncated: items.length > query.limit };
    },
    async recordDiscovery(analysis: AgentAnalysis, seenAt = new Date()) {
      const item = processed({ title: analysis.sourceTitle, url: analysis.sourceUrl }, "new").discovery;
      item.firstSeenAt = seenAt.toISOString();
      item.lastSeenAt = seenAt.toISOString();
      item.analysis = structuredClone(analysis);
      stored.set(item.normalizedUrl, item);
      return structuredClone(item);
    },
    async touchDiscovery(url, seenAt = new Date()) {
      const item = stored.get(url.replace(/\/$/, ""));
      if (!item) return undefined;
      item.lastSeenAt = seenAt.toISOString();
      return structuredClone(item);
    },
  };
}

function memoryNotifications(): { history: NotificationHistory; records: Map<string, NotificationRecord> } {
  const records = new Map<string, NotificationRecord>();
  return {
    records,
    history: {
      async hasNotificationBeenSent(url) { return records.has(url); },
      async getNotificationRecord(url) { return records.get(url); },
      async recordNotificationSent(url, channel, providerMessageId) {
        const record: NotificationRecord = {
          normalizedUrl: url,
          channel,
          sentAt: "2026-10-09T08:01:00.000Z",
          providerMessageId,
        };
        records.set(url, record);
        return record;
      },
    },
  };
}

function runMonitoringCycle(
  query: string | undefined = undefined,
  dependencies: MonitoringCycleDependencies = {},
) {
  return runProductionMonitoringCycle(query, {
    history: emptyHistory(),
    now: () => new Date("2026-10-09T08:00:00.000Z"),
    ...dependencies,
  });
}

function searchResult(id: string): SearchResult {
  return { title: `Result ${id}`, url: `https://example.com/${id}`, snippet: `Snippet ${id}` };
}

function preferredResult(id: string, tool: "Codex" | "Claude Code"): SearchResult {
  return { title: `${tool} release ${id}`, url: `https://example.com/${id}`, snippet: `New ${tool} developer feature.` };
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
  return async (candidates: DeliveryCandidate[]) => {
    const map = new Map<string, NotificationResult>();
    for (const candidate of candidates) map.set(candidate.discovery.analysis.sourceUrl, notification(status));
    return {
      notifications: map,
      eligibleCandidates: status === "not_eligible" ? [] : candidates,
      sentCandidates: status === "sent" ? candidates : [],
    };
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
  assert.deepEqual(outcome.searchFailures, []);
  assert.equal(outcome.failures, 0);
});

test("guard denial before any result preserves the existing clean stop behavior", async () => {
  let searches = 0;
  let processCalls = 0;
  const outcome = await runMonitoringCycle(undefined, {
    search: async () => {
      searches += 1;
      throw new BraveUsageGuardDeniedError();
    },
    process: async (item) => { processCalls += 1; return processed(item, "new"); },
  });
  assert.equal(searches, 1);
  assert.equal(processCalls, 0);
  assert.equal(outcome.searchResultsReceived, 0);
  assert.deepEqual(outcome.searchFailures, []);
  assert.equal(outcome.failures, 0);
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

test("a Codex candidate from a later query enters the four analysis slots", async () => {
  const generics = Array.from({ length: 5 }, (_, index) => searchResult(`generic-${index}`));
  const codex = preferredResult("codex-late", "Codex");
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle(undefined, {
    search: async (query) => {
      if (query === MONITORING_QUERIES[0]) return generics;
      if (query === MONITORING_QUERIES[5]) return [codex];
      return [];
    },
    hasDiscovery: async () => false,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "new"); },
    notify: batchNotify("not_eligible"),
  });
  assert.deepEqual(processedUrls, [...generics.slice(0, 3), codex].map((item) => item.url));
  assert.equal(outcome.analysesAttempted, 4);
  assert.equal(outcome.stoppedByAnalysisCap, true);
});

test("a Claude Code candidate from a later query enters the four analysis slots", async () => {
  const generics = Array.from({ length: 5 }, (_, index) => searchResult(`generic-claude-${index}`));
  const claudeCode = preferredResult("claude-code-late", "Claude Code");
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle(undefined, {
    search: async (query) => {
      if (query === MONITORING_QUERIES[0]) return generics;
      if (query === MONITORING_QUERIES[6]) return [claudeCode];
      return [];
    },
    hasDiscovery: async () => false,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "new"); },
    notify: batchNotify("not_eligible"),
  });
  assert.deepEqual(processedUrls, [...generics.slice(0, 3), claudeCode].map((item) => item.url));
  assert.equal(outcome.analysesAttempted, 4);
});

test("preferred candidates reserve bounded slots while generic candidates fill the remainder", async () => {
  const generics = Array.from({ length: 5 }, (_, index) => searchResult(`generic-mixed-${index}`));
  const codex = preferredResult("codex-mixed", "Codex");
  const claudeCode = preferredResult("claude-code-mixed", "Claude Code");
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle(undefined, {
    search: async (query) => {
      if (query === MONITORING_QUERIES[0]) return generics;
      if (query === MONITORING_QUERIES[5]) return [codex];
      if (query === MONITORING_QUERIES[6]) return [claudeCode];
      return [];
    },
    hasDiscovery: async () => false,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "new"); },
    notify: batchNotify("not_eligible"),
  });
  assert.deepEqual(processedUrls, [...generics.slice(0, 2), codex, claudeCode].map((item) => item.url));
  assert.equal(outcome.analysesAttempted, MAX_NEW_ANALYSES_PER_CYCLE);
  assert.equal(outcome.newDiscoveries, 4);
});

test("only two preferred candidates are selected before available generic candidates", async () => {
  const preferred = [
    preferredResult("codex-bounded-1", "Codex"),
    preferredResult("claude-bounded-1", "Claude Code"),
    preferredResult("codex-bounded-2", "Codex"),
    preferredResult("claude-bounded-2", "Claude Code"),
  ];
  const generics = [searchResult("generic-bounded-1"), searchResult("generic-bounded-2")];
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle("test", {
    search: async () => [...preferred, ...generics],
    hasDiscovery: async () => false,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "new"); },
    notify: batchNotify("not_eligible"),
  });
  assert.deepEqual(processedUrls, [...preferred.slice(0, 2), ...generics].map((item) => item.url));
  assert.equal(outcome.analysesAttempted, 4);
});

test("extra preferred candidates fill slots only when generic candidates are insufficient", async () => {
  const preferred = [
    preferredResult("codex-fallback-1", "Codex"),
    preferredResult("claude-fallback-1", "Claude Code"),
    preferredResult("codex-fallback-2", "Codex"),
    preferredResult("claude-fallback-2", "Claude Code"),
  ];
  const generic = searchResult("generic-fallback-1");
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle("test", {
    search: async () => [...preferred, generic],
    hasDiscovery: async () => false,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "new"); },
    notify: batchNotify("not_eligible"),
  });
  assert.deepEqual(processedUrls, [...preferred.slice(0, 3), generic].map((item) => item.url));
  assert.equal(outcome.analysesAttempted, 4);
});

test("same-cycle duplicate URLs do not consume another analysis slot", async () => {
  const repeated = searchResult("same-cycle");
  const repeatedAgain = { ...repeated };
  const generics = Array.from({ length: 4 }, (_, index) => searchResult(`generic-dedup-${index}`));
  const codex = preferredResult("codex-dedup", "Codex");
  const recorded = new Set<string>();
  const processedUrls: string[] = [];
  const outcome = await runMonitoringCycle("test", {
    search: async () => [repeated, repeatedAgain, ...generics, codex],
    hasDiscovery: async () => false,
    process: async (item) => {
      processedUrls.push(item.url);
      const status = recorded.has(item.url) ? "duplicate" : "new";
      recorded.add(item.url);
      return processed(item, status);
    },
    notify: batchNotify("not_eligible"),
  });
  assert.equal(processedUrls.filter((url) => url === repeated.url).length, 2);
  assert.ok(processedUrls.includes(codex.url));
  assert.equal(outcome.analysesAttempted, 4);
  assert.equal(outcome.newDiscoveries, 4);
  assert.equal(outcome.duplicates, 1);
});

test("a failed default query is recorded while earlier and later results are processed", async () => {
  const attempts: string[] = [];
  const processedUrls: string[] = [];
  const first = searchResult("before-search-failure");
  const later = searchResult("after-search-failure");
  const outcome = await runMonitoringCycle(undefined, {
    search: async (query) => {
      attempts.push(query);
      if (query === MONITORING_QUERIES[0]) return [first];
      if (query === MONITORING_QUERIES[1]) throw new Error("Brave temporarily unavailable");
      if (query === MONITORING_QUERIES[2]) return [later];
      return [];
    },
    hasDiscovery: async () => true,
    process: async (item) => { processedUrls.push(item.url); return processed(item, "duplicate"); },
    notify: batchNotify("not_eligible"),
  });
  assert.deepEqual(attempts, [...MONITORING_QUERIES]);
  assert.deepEqual(processedUrls, [first.url, later.url]);
  assert.deepEqual(outcome.searchFailures, [{ queryOrdinal: 2, error: "Brave temporarily unavailable" }]);
  assert.equal(outcome.searchResultsReceived, 2);
  assert.equal(outcome.resultsProcessed, 2);
  assert.equal(outcome.failures, 1);
});

test("multiple default-query failures complete when at least one usable result exists", async () => {
  const attempts = new Map<string, number>();
  const usable = searchResult("usable-after-multiple-failures");
  const outcome = await runMonitoringCycle(undefined, {
    search: async (query) => {
      attempts.set(query, (attempts.get(query) ?? 0) + 1);
      if (query === MONITORING_QUERIES[1]) throw new Error("First transient failure");
      if (query === MONITORING_QUERIES[7]) throw new Error("Second transient failure");
      if (query === MONITORING_QUERIES[9]) return [usable];
      return [];
    },
    hasDiscovery: async () => true,
    process: async (item) => processed(item, "duplicate"),
    notify: batchNotify("not_eligible"),
  });
  assert.equal(attempts.size, MONITORING_QUERIES.length);
  assert.ok([...attempts.values()].every((count) => count === 1));
  assert.deepEqual(outcome.searchFailures, [
    { queryOrdinal: 2, error: "First transient failure" },
    { queryOrdinal: 8, error: "Second transient failure" },
  ]);
  assert.equal(outcome.searchResultsReceived, 1);
  assert.equal(outcome.resultsProcessed, 1);
  assert.equal(outcome.failures, 2);
});

test("recorded search-failure diagnostics are bounded and redact credential-shaped content", async () => {
  const outcome = await runMonitoringCycle(undefined, {
    search: async (query) => {
      if (query === MONITORING_QUERIES[0]) return [searchResult("usable-for-safe-error")];
      if (query === MONITORING_QUERIES[1]) {
        throw new Error(
          "Request https://example.test/private failed for person@example.test "
          + "Bearer bearer-value api_key=credential-value "
          + "x".repeat(MAX_SEARCH_FAILURE_ERROR_LENGTH + 40),
        );
      }
      return [];
    },
    hasDiscovery: async () => true,
    process: async (item) => processed(item, "duplicate"),
    notify: batchNotify("not_eligible"),
  });
  const diagnostic = outcome.searchFailures[0]?.error ?? "";
  assert.ok(diagnostic.length <= MAX_SEARCH_FAILURE_ERROR_LENGTH);
  for (const forbidden of ["example.test", "person@example.test", "bearer-value", "credential-value"]) {
    assert.equal(diagnostic.includes(forbidden), false);
  }
});

test("default monitoring rejects when non-quota failures leave zero usable results without retrying", async () => {
  const attempts = new Map<string, number>();
  await assert.rejects(
    runMonitoringCycle(undefined, {
      search: async (query) => {
        attempts.set(query, (attempts.get(query) ?? 0) + 1);
        throw new Error(`Failure for ${query}`);
      },
    }),
    /no usable results after 10 non-quota failure\(s\).*First failure at query 1/,
  );
  assert.equal(attempts.size, MONITORING_QUERIES.length);
  assert.ok([...attempts.values()].every((count) => count === 1));
});

test("zero search results return a clean summary without processing or notification", async () => {
  let processCalls = 0;
  let notificationCalls = 0;
  const outcome = await runMonitoringCycle(MONITORING_QUERY, {
    search: async () => [],
    hasDiscovery: async () => { throw new Error("should not inspect history"); },
    process: async () => { processCalls++; throw new Error("unreachable"); },
    notify: async (_results) => {
      notificationCalls++;
      return { notifications: new Map(), eligibleCandidates: [], sentCandidates: [] };
    },
  });
  assert.equal(outcome.searchResultsReceived, 0);
  assert.equal(outcome.resultsProcessed, 0);
  assert.equal(outcome.outcomes.length, 0);
  assert.equal(processCalls, 0);
  assert.equal(notificationCalls, 0);
});

test("all duplicates use zero analysis slots and do not enter the delivery pool", async () => {
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
      return { notifications: map, eligibleCandidates: [], sentCandidates: [] };
    },
  });
  assert.equal(outcome.analysesAttempted, 0);
  assert.equal(outcome.duplicates, 3);
  assert.equal(outcome.resultsProcessed, 3);
  assert.equal(outcome.notificationsNotEligible, 3);
  assert.equal(processCalls, 3);
  assert.equal(notificationBatchCalls, 0);
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

test("a replay-only cycle delivers stored analysis without rediscovery or Gemini analysis", async () => {
  const stored = processed(searchResult("replay-only"), "new").discovery;
  stored.firstSeenAt = "2026-10-08T08:00:00.000Z";
  stored.lastSeenAt = "2026-10-08T08:00:00.000Z";
  const notifications = memoryNotifications();
  let searches = 0;
  let analyses = 0;
  let sends = 0;

  const outcome = await runProductionMonitoringCycle(undefined, {
    now: () => new Date("2026-10-09T08:00:00.000Z"),
    history: memoryHistory([stored]),
    search: async () => { searches += 1; return []; },
    process: async (item) => { analyses += 1; return processed(item, "new"); },
    notification: {
      history: notifications.history,
      formatDigest: () => ({ subject: "Replay", text: "Replay", html: "<p>Replay</p>" }),
      sendEmail: async () => { sends += 1; return { id: "replay_1" }; },
    },
  });

  assert.equal(searches, MONITORING_QUERIES.length);
  assert.equal(analyses, 0);
  assert.equal(sends, 1);
  assert.equal(outcome.replayCandidatesConsidered, 1);
  assert.equal(outcome.replayCandidatesEligible, 1);
  assert.equal(outcome.replayStoriesSent, 1);
  assert.equal(outcome.freshStoriesSent, 0);
  assert.equal(outcome.notificationsSent, 1);
});

test("failed fresh delivery can replay next cycle and successful history prevents another send", async () => {
  const item = searchResult("retry-replay");
  const history = memoryHistory([]);
  const notifications = memoryNotifications();
  let sendCalls = 0;
  const notification = {
    history: notifications.history,
    formatDigest: () => ({ subject: "Digest", text: "Digest", html: "<p>Digest</p>" }),
    sendEmail: async () => {
      sendCalls += 1;
      if (sendCalls === 1) throw new Error("temporary email failure");
      return { id: "replay_success" };
    },
  };

  const first = await runProductionMonitoringCycle("test", {
    now: () => new Date("2026-10-08T08:00:00.000Z"),
    history,
    search: async () => [item],
    hasDiscovery: async () => false,
    process: async () => ({
      status: "new",
      discovery: await history.recordDiscovery(
        processed(item, "new").discovery.analysis,
        new Date("2026-10-08T07:59:00.000Z"),
      ),
    }),
    notification,
  });
  assert.equal(first.failures, 1, "the same fresh/replay URL counts as one failed delivery candidate");
  assert.equal(notifications.records.size, 0);

  const second = await runProductionMonitoringCycle("test", {
    now: () => new Date("2026-10-09T08:00:00.000Z"),
    history,
    search: async () => [],
    process: async () => { throw new Error("replay must not analyze"); },
    notification,
  });
  assert.equal(second.replayStoriesSent, 1);
  assert.equal(notifications.records.size, 1);

  const third = await runProductionMonitoringCycle("test", {
    now: () => new Date("2026-10-09T09:00:00.000Z"),
    history,
    search: async () => [],
    process: async () => { throw new Error("replay must not analyze"); },
    notification,
  });
  assert.equal(sendCalls, 2);
  assert.equal(third.notificationsAlreadySent, 1);
  assert.equal(third.replayStoriesSent, 0);
});

test("replay lookup uncertainty aborts before analysis or notification", async () => {
  let processCalls = 0;
  let notificationCalls = 0;
  const history = emptyHistory();
  history.listRecentDiscoveries = async () => { throw new Error("D1 unavailable"); };
  await assert.rejects(runProductionMonitoringCycle("test", {
    now: () => new Date("2026-10-09T08:00:00.000Z"),
    history,
    search: async () => [searchResult("unreachable")],
    process: async (item) => { processCalls += 1; return processed(item, "new"); },
    notify: async () => {
      notificationCalls += 1;
      return { notifications: new Map(), eligibleCandidates: [], sentCandidates: [] };
    },
  }), /replay discovery history is unavailable: D1 unavailable/);
  assert.equal(processCalls, 0);
  assert.equal(notificationCalls, 0);
});

test("notification-history lookup uncertainty aborts replay without sending", async () => {
  const stored = processed(searchResult("notification-history-failure"), "new").discovery;
  stored.firstSeenAt = "2026-10-08T08:00:00.000Z";
  stored.lastSeenAt = stored.firstSeenAt;
  let sends = 0;
  await assert.rejects(runProductionMonitoringCycle("test", {
    now: () => new Date("2026-10-09T08:00:00.000Z"),
    history: memoryHistory([stored]),
    search: async () => [],
    notification: {
      history: {
        async hasNotificationBeenSent() { throw new Error("notification D1 unavailable"); },
        async getNotificationRecord() { throw new Error("unreachable"); },
        async recordNotificationSent() { throw new Error("unreachable"); },
      },
      sendEmail: async () => { sends += 1; return { id: "unreachable" }; },
    },
  }), /notification history is unavailable: Notification history could not be read safely/);
  assert.equal(sends, 0);
});

test("pre-activation and expired discoveries never enter replay even when lastSeenAt is recent", async () => {
  const beforeActivation = processed(searchResult("before-activation"), "new").discovery;
  beforeActivation.firstSeenAt = "2026-10-06T15:59:59.999Z";
  beforeActivation.lastSeenAt = "2026-10-09T07:59:00.000Z";
  const expired = processed(searchResult("expired"), "new").discovery;
  expired.firstSeenAt = "2026-10-07T07:59:59.999Z";
  expired.lastSeenAt = "2026-10-10T07:59:00.000Z";
  let sends = 0;
  const outcome = await runProductionMonitoringCycle("test", {
    now: () => new Date("2026-10-10T08:00:00.000Z"),
    history: memoryHistory([beforeActivation, expired]),
    search: async () => [],
    notification: {
      history: memoryNotifications().history,
      sendEmail: async () => { sends += 1; return { id: "unreachable" }; },
    },
  });
  assert.equal(outcome.replayCandidatesConsidered, 0);
  assert.equal(outcome.replayStoriesSent, 0);
  assert.equal(sends, 0);
});

test("replay lookup runs once without pagination and reports truncation", async () => {
  let lookups = 0;
  const history = emptyHistory();
  history.listRecentDiscoveries = async (query) => {
    lookups += 1;
    assert.equal(query.limit, 100);
    return { discoveries: [], truncated: true };
  };
  const outcome = await runProductionMonitoringCycle("test", {
    now: () => new Date("2026-10-09T08:00:00.000Z"),
    history,
    search: async () => [],
  });
  assert.equal(lookups, 1);
  assert.equal(outcome.replayLookupTruncated, true);
});
