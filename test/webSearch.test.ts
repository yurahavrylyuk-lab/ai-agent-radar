import assert from "node:assert/strict";
import test from "node:test";

import { MONITORING_FRESHNESS } from "../src/config/discoveryQueries.js";
import { MONITORING_QUERIES, runMonitoringCycle } from "../src/services/monitor.js";
import {
  BRAVE_ERROR_BODY_LIMIT_BYTES,
  BRAVE_REQUEST_TIMEOUT_MS,
  BRAVE_SUCCESS_BODY_LIMIT_BYTES,
  BraveRequestError,
  BraveUsageGuardDeniedError,
  searchWeb,
} from "../src/tools/webSearch.js";
import * as webSearch from "../src/tools/webSearch.js";
import type { UsageRecord, UsageTracker } from "../src/services/usageTracker.js";

const baseEnvironment = {
  BRAVE_SEARCH_API_KEY: "test-key",
  BRAVE_DAILY_SEARCH_LIMIT: "10",
  BRAVE_WEEKLY_SEARCH_LIMIT: "100",
  BRAVE_MONTHLY_SEARCH_LIMIT: "350",
};

class InMemoryUsageTracker implements UsageTracker {
  public readonly records: UsageRecord[];
  public recordCalls = 0;

  constructor(initialCount = 0, private readonly unavailable = false) {
    this.records = initialCount === 0 ? [] : [{
      timestamp: new Date().toISOString(),
      provider: "brave",
      operation: "web-search",
      requestCount: initialCount,
    }];
  }

  async getRecords(): Promise<UsageRecord[]> {
    if (this.unavailable) throw new Error("usage unavailable");
    return this.records;
  }

  async recordRequest(record: UsageRecord): Promise<void> {
    this.recordCalls += 1;
    this.records.push(record);
  }
}

class ManualDeadlineScheduler {
  public nowValue = 0;
  public nowHook: (() => number) | undefined;
  public scheduledDelay: number | undefined;
  public cleared = 0;
  private callback: (() => void) | undefined;

  readonly now = (): number => this.nowHook?.() ?? this.nowValue;
  readonly set = (callback: () => void, delay: number): number => {
    this.callback = callback;
    this.scheduledDelay = delay;
    return 1;
  };
  readonly clear = (): void => {
    this.cleared += 1;
    this.callback = undefined;
  };

  expire(): void {
    this.nowValue = BRAVE_REQUEST_TIMEOUT_MS;
    this.callback?.();
  }
}

function assertBraveFailure(reason: BraveRequestError["reason"]): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof BraveRequestError);
    assert.equal(error.reason, reason);
    return true;
  };
}

async function waitForTestState(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await Promise.resolve();
  assert.equal(predicate(), true, "test fixture did not reach the expected asynchronous state");
}

function braveResponse(): Response {
  return new Response(JSON.stringify({ web: { results: [] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function paddedJson(byteLength: number): string {
  const json = JSON.stringify({ web: { results: [] } });
  assert.ok(json.length <= byteLength);
  return json + " ".repeat(byteLength - json.length);
}

function paddedUtf8Json(byteLength: number): Uint8Array {
  const encoder = new TextEncoder();
  const json = JSON.stringify({ web: { results: [] }, marker: "🙂" });
  const encoded = encoder.encode(json);
  assert.ok(encoded.byteLength <= byteLength);
  const body = new Uint8Array(byteLength);
  body.fill(0x20);
  body.set(encoded);
  return body;
}

function streamingResponse(
  chunks: readonly Uint8Array[],
  options: { status?: number; headers?: HeadersInit; close?: boolean; onCancel?: () => void } = {},
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      if (options.close !== false && index >= chunks.length) controller.close();
    },
    cancel() { options.onCancel?.(); },
  }), { status: options.status ?? 200, headers: options.headers });
}

test("Brave deadline covers unsettled headers without recording usage or dispatching twice", async () => {
  const tracker = new InMemoryUsageTracker();
  const scheduler = new ManualDeadlineScheduler();
  let fetches = 0;
  let resolveFetch!: (response: Response) => void;
  const fetchPromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });

  const request = webSearch.searchWebPage("stalled headers", {
    usageTracker: tracker,
    environment: baseEnvironment,
    deadlineScheduler: scheduler,
    fetchImplementation: async () => {
      fetches += 1;
      return fetchPromise;
    },
  });
  await waitForTestState(() => fetches === 1 && scheduler.scheduledDelay !== undefined);
  scheduler.expire();
  await assert.rejects(request, assertBraveFailure("timeout"));
  resolveFetch(braveResponse());
  await Promise.resolve();

  assert.equal(fetches, 1);
  assert.equal(tracker.recordCalls, 0);
  assert.equal(scheduler.scheduledDelay, BRAVE_REQUEST_TIMEOUT_MS);
  assert.equal(scheduler.cleared, 1);
});

test("Brave deadline covers a stalled body after successful headers and preserves one usage record", async () => {
  const tracker = new InMemoryUsageTracker();
  const scheduler = new ManualDeadlineScheduler();
  let cancelled = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled += 1; },
  }), { status: 200, headers: { "content-type": "application/json" } });

  const request = webSearch.searchWebPage("stalled body", {
    usageTracker: tracker,
    environment: baseEnvironment,
    deadlineScheduler: scheduler,
    fetchImplementation: async () => response,
  });
  await waitForTestState(() => tracker.recordCalls === 1 && scheduler.scheduledDelay !== undefined);
  scheduler.expire();

  await assert.rejects(request, assertBraveFailure("timeout"));
  assert.equal(tracker.recordCalls, 1);
  assert.equal(cancelled, 1);
  assert.equal(scheduler.cleared, 1);
});

test("late fetch rejection after timeout is observed and cannot replace the fixed timeout", async () => {
  const tracker = new InMemoryUsageTracker();
  const scheduler = new ManualDeadlineScheduler();
  let rejectFetch!: (error: Error) => void;
  const fetchPromise = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
  const request = webSearch.searchWebPage("late rejection", {
    usageTracker: tracker,
    environment: baseEnvironment,
    deadlineScheduler: scheduler,
    fetchImplementation: async () => fetchPromise,
  });
  await waitForTestState(() => scheduler.scheduledDelay !== undefined);
  scheduler.expire();
  await assert.rejects(request, assertBraveFailure("timeout"));
  rejectFetch(new Error("PRIVATE_LATE_PROVIDER_TEXT"));
  await Promise.resolve();
  assert.equal(tracker.recordCalls, 0);
});

test("the exact deadline boundary rejects a completed body before candidate admission", async () => {
  const tracker = new InMemoryUsageTracker();
  const scheduler = new ManualDeadlineScheduler();
  let bodyProduced = false;
  scheduler.nowHook = () => tracker.recordCalls === 1 && bodyProduced ? BRAVE_REQUEST_TIMEOUT_MS : 0;
  const bytes = new TextEncoder().encode(JSON.stringify({ web: { results: [] } }));
  await assert.rejects(webSearch.searchWebPage("deadline boundary", {
    usageTracker: tracker,
    environment: baseEnvironment,
    deadlineScheduler: scheduler,
    fetchImplementation: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyProduced = true;
        controller.enqueue(bytes);
        controller.close();
      },
    }), { status: 200 }),
  }), assertBraveFailure("timeout"));
  assert.equal(tracker.recordCalls, 1);
  assert.equal(scheduler.cleared, 1);
});

test("success bodies are accepted through the exact 256 KiB boundary", async () => {
  for (const size of [BRAVE_SUCCESS_BODY_LIMIT_BYTES - 1, BRAVE_SUCCESS_BODY_LIMIT_BYTES]) {
    const tracker = new InMemoryUsageTracker();
    const page = await webSearch.searchWebPage("bounded success", {
      usageTracker: tracker,
      environment: baseEnvironment,
      fetchImplementation: async () => new Response(paddedJson(size), {
        headers: { "content-length": String(size), "content-type": "application/json" },
      }),
    });
    assert.equal(page.rawCount, 0);
    assert.equal(tracker.recordCalls, 1);
  }
});

test("body limits count UTF-8 bytes rather than JavaScript string units", async () => {
  const tracker = new InMemoryUsageTracker();
  const body = paddedUtf8Json(BRAVE_SUCCESS_BODY_LIMIT_BYTES);
  const page = await webSearch.searchWebPage("utf8 bytes", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => streamingResponse([body], {
      headers: { "content-length": String(body.byteLength) },
    }),
  });
  assert.equal(page.rawCount, 0);
  assert.equal(tracker.recordCalls, 1);
});

test("declared success body one byte over the limit is rejected before reading and still accounted once", async () => {
  const tracker = new InMemoryUsageTracker();
  let cancelled = 0;
  await assert.rejects(webSearch.searchWebPage("declared overflow", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => streamingResponse([], {
      close: false,
      headers: { "content-length": String(BRAVE_SUCCESS_BODY_LIMIT_BYTES + 1) },
      onCancel: () => { cancelled += 1; },
    }),
  }), assertBraveFailure("body_limit"));
  assert.equal(tracker.recordCalls, 1);
  assert.equal(cancelled, 1);
});

test("invalid and unsafe Content-Length values fail closed", async () => {
  for (const contentLength of ["", "-1", "+1", "1.5", "abc", "9007199254740992"]) {
    const tracker = new InMemoryUsageTracker();
    await assert.rejects(webSearch.searchWebPage("invalid length", {
      usageTracker: tracker,
      environment: baseEnvironment,
      fetchImplementation: async () => streamingResponse([], {
        close: false,
        headers: { "content-length": contentLength },
      }),
    }), assertBraveFailure("body_limit"));
    assert.equal(tracker.recordCalls, 1);
  }
});

test("streaming and misleading-length overflow is rejected at the first excess byte and cancelled", async () => {
  for (const headers of [undefined, { "content-length": "1" }]) {
    const tracker = new InMemoryUsageTracker();
    let cancelled = 0;
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(pulls === 1 ? BRAVE_SUCCESS_BODY_LIMIT_BYTES : 1));
      },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 }), { headers });
    await assert.rejects(webSearch.searchWebPage("stream overflow", {
      usageTracker: tracker,
      environment: baseEnvironment,
      fetchImplementation: async () => response,
    }), assertBraveFailure("body_limit"));
    assert.equal(pulls, 2);
    assert.equal(cancelled, 1);
    assert.equal(tracker.recordCalls, 1);
  }
});

test("the 16 KiB error-body cap is independent and provider content is discarded", async () => {
  const atLimit = new InMemoryUsageTracker();
  await assert.rejects(webSearch.searchWebPage("bounded error", {
    usageTracker: atLimit,
    environment: baseEnvironment,
    fetchImplementation: async () => new Response("PRIVATE_PROVIDER_ERROR".padEnd(BRAVE_ERROR_BODY_LIMIT_BYTES, "x"), {
      status: 500,
      headers: { "content-length": String(BRAVE_ERROR_BODY_LIMIT_BYTES) },
    }),
  }), (error) => {
    assertBraveFailure("http")(error);
    assert.equal((error as BraveRequestError).httpStatus, 500);
    assert.doesNotMatch((error as Error).message, /PRIVATE_PROVIDER_ERROR/);
    return true;
  });
  assert.equal(atLimit.recordCalls, 0);

  const overLimit = new InMemoryUsageTracker();
  await assert.rejects(webSearch.searchWebPage("oversized error", {
    usageTracker: overLimit,
    environment: baseEnvironment,
    fetchImplementation: async () => new Response("x", {
      status: 503,
      headers: { "content-length": String(BRAVE_ERROR_BODY_LIMIT_BYTES + 1) },
    }),
  }), assertBraveFailure("body_limit"));
  assert.equal(overLimit.recordCalls, 0);
});

test("strict UTF-8, complete JSON and response-shape validation retain one successful-header record", async () => {
  const cases: Array<{ body: Uint8Array; reason: BraveRequestError["reason"] }> = [
    { body: Uint8Array.from([0xc3, 0x28]), reason: "invalid_utf8" },
    { body: new TextEncoder().encode("{"), reason: "invalid_json" },
    { body: new TextEncoder().encode(JSON.stringify({ web: { results: {} } })), reason: "invalid_response" },
  ];
  for (const fixture of cases) {
    const tracker = new InMemoryUsageTracker();
    await assert.rejects(webSearch.searchWebPage("malformed success", {
      usageTracker: tracker,
      environment: baseEnvironment,
      fetchImplementation: async () => streamingResponse([fixture.body]),
    }), assertBraveFailure(fixture.reason));
    assert.equal(tracker.recordCalls, 1);
  }
});

test("a null error body remains a fixed HTTP failure", async () => {
  const tracker = new InMemoryUsageTracker();
  await assert.rejects(webSearch.searchWebPage("empty error", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => new Response(null, { status: 500 }),
  }), assertBraveFailure("http"));
  assert.equal(tracker.recordCalls, 0);
});

test("manual redirects are never followed, recorded or allowed to expose Location", async () => {
  for (const status of [301, 302, 307, 308]) {
    const tracker = new InMemoryUsageTracker();
    let fetches = 0;
    await assert.rejects(webSearch.searchWebPage("redirect canary query", {
      usageTracker: tracker,
      environment: baseEnvironment,
      fetchImplementation: async (_input, init) => {
        fetches += 1;
        assert.equal(init?.redirect, "manual");
        return new Response(null, {
          status,
          headers: { location: "https://PRIVATE_REDIRECT_TARGET.test/secret" },
        });
      },
    }), (error) => {
      assertBraveFailure("redirect")(error);
      assert.doesNotMatch((error as Error).message, /PRIVATE_REDIRECT_TARGET|canary query/);
      return true;
    });
    assert.equal(fetches, 1);
    assert.equal(tracker.recordCalls, 0);
  }
});

test("cancellation rejection cannot replace a bounded overflow failure or become unhandled", async () => {
  const tracker = new InMemoryUsageTracker();
  let unhandled: unknown;
  const listener = (reason: unknown): void => { unhandled = reason; };
  process.once("unhandledRejection", listener);
  try {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(BRAVE_SUCCESS_BODY_LIMIT_BYTES + 1)); },
      cancel() { return Promise.reject(new Error("PRIVATE_CANCEL_REJECTION")); },
    }, { highWaterMark: 0 }));
    await assert.rejects(webSearch.searchWebPage("cancel rejection", {
      usageTracker: tracker,
      environment: baseEnvironment,
      fetchImplementation: async () => response,
    }), assertBraveFailure("body_limit"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, undefined);
    assert.equal(tracker.recordCalls, 1);
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
});

test("accounting rejection wins over a concurrent body failure and suppresses candidates", async () => {
  let recordCalls = 0;
  const tracker: UsageTracker = {
    getRecords: async () => [],
    recordRequest: async () => {
      recordCalls += 1;
      throw new Error("PRIVATE_ACCOUNTING_FAILURE");
    },
  };
  await assert.rejects(webSearch.searchWebPage("accounting race", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => streamingResponse([new TextEncoder().encode("{")]),
  }), (error) => {
    assertBraveFailure("accounting")(error);
    assert.doesNotMatch((error as Error).message, /PRIVATE_ACCOUNTING_FAILURE/);
    return true;
  });
  assert.equal(recordCalls, 1);
});

test("candidate admission awaits the single delayed usage write", async () => {
  let resolveRecord!: () => void;
  const recordPromise = new Promise<void>(resolve => { resolveRecord = resolve; });
  let recordCalls = 0;
  const tracker: UsageTracker = {
    getRecords: async () => [],
    recordRequest: async () => { recordCalls += 1; await recordPromise; },
  };
  let settled = false;
  const request = webSearch.searchWebPage("delayed accounting", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => new Response(JSON.stringify({ web: { results: [
      { title: "Bounded result", url: "https://example.test/story" },
    ] } })),
  }).then(value => { settled = true; return value; });
  await waitForTestState(() => recordCalls === 1);
  await Promise.resolve();
  assert.equal(settled, false);
  resolveRecord();
  const page = await request;
  assert.equal(page.positions.length, 1);
  assert.equal(recordCalls, 1);
});

test("network rejection and response-stream failure use fixed transport errors with correct accounting", async () => {
  const rejectedFetchTracker = new InMemoryUsageTracker();
  await assert.rejects(webSearch.searchWebPage("PRIVATE_QUERY_CANARY", {
    usageTracker: rejectedFetchTracker,
    environment: baseEnvironment,
    fetchImplementation: async () => { throw new Error("PRIVATE_NETWORK_CANARY"); },
  }), (error) => {
    assertBraveFailure("transport")(error);
    assert.doesNotMatch((error as Error).message, /PRIVATE_/);
    return true;
  });
  assert.equal(rejectedFetchTracker.recordCalls, 0);

  const streamTracker = new InMemoryUsageTracker();
  await assert.rejects(webSearch.searchWebPage("stream error", {
    usageTracker: streamTracker,
    environment: baseEnvironment,
    fetchImplementation: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("PRIVATE_STREAM_CANARY")); },
    })),
  }), assertBraveFailure("transport"));
  assert.equal(streamTracker.recordCalls, 1);
});

test("missing credentials and invalid queries fail before dispatch", async () => {
  for (const fixture of [
    { query: "valid", environment: { ...baseEnvironment, BRAVE_SEARCH_API_KEY: "" }, message: /BRAVE_SEARCH_API_KEY/ },
    { query: "   ", environment: baseEnvironment, message: /non-empty search query/ },
  ]) {
    let fetches = 0;
    await assert.rejects(webSearch.searchWebPage(fixture.query, {
      usageTracker: new InMemoryUsageTracker(),
      environment: fixture.environment,
      fetchImplementation: async () => { fetches += 1; return braveResponse(); },
    }), fixture.message);
    assert.equal(fetches, 0);
  }
});

test("successful completion clears its deadline timer", async () => {
  const scheduler = new ManualDeadlineScheduler();
  const page = await webSearch.searchWebPage("timer cleanup", {
    usageTracker: new InMemoryUsageTracker(),
    environment: baseEnvironment,
    deadlineScheduler: scheduler,
    fetchImplementation: async () => braveResponse(),
  });
  assert.equal(page.rawCount, 0);
  assert.equal(scheduler.cleared, 1);
});

async function runDefaultSearches(
  tracker: InMemoryUsageTracker,
  environment: Record<string, string | undefined> = baseEnvironment,
): Promise<{ fetches: number; bodies: unknown[] }> {
  let fetches = 0;
  const bodies: unknown[] = [];
  await runMonitoringCycle(undefined, {
    history: {
      getDiscovery: async () => undefined,
      listRecentDiscoveries: async () => ({ discoveries: [], truncated: false }),
      recordDiscovery: async () => { throw new Error("not used"); },
      touchDiscovery: async () => undefined,
    },
    search: (query, options) => searchWeb(query, {
      usageTracker: tracker,
      environment,
      freshness: options?.freshness,
      fetchImplementation: async (_url, init) => {
        fetches += 1;
        bodies.push(JSON.parse(String(init?.body)));
        return braveResponse();
      },
    }),
    geminiPreflight: async () => ({
      allowed: true,
      counts: { dailyRequests: 0, weeklyRequests: 0, monthlyRequests: 0, dailyTokens: 0, weeklyTokens: 0, monthlyTokens: 0 },
      limits: { dailyRequests: 5, weeklyRequests: 20, monthlyRequests: 50, dailyTokens: 10_000, weeklyTokens: 30_000, monthlyTokens: 100_000 },
    }),
  });
  return { fetches, bodies };
}

test("daily usage 0 permits ten sequential guarded fetches with count 5", async () => {
  const tracker = new InMemoryUsageTracker(0);
  const result = await runDefaultSearches(tracker);
  assert.equal(result.fetches, 10);
  assert.equal(tracker.recordCalls, 10);
  assert.deepEqual(result.bodies, MONITORING_QUERIES.map((q) => ({ q, count: 5, freshness: MONITORING_FRESHNESS })));
});

test("a direct search without monitoring options preserves the existing payload shape", async () => {
  const tracker = new InMemoryUsageTracker();
  let body: unknown;
  await searchWeb("direct query", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return braveResponse();
    },
  });
  assert.deepEqual(body, { q: "direct query", count: 5 });
});

test("a Brave failure receives exactly one freshness-constrained request without an unfiltered fallback", async () => {
  const tracker = new InMemoryUsageTracker();
  const bodies: unknown[] = [];
  await assert.rejects(searchWeb("fresh query", {
    usageTracker: tracker,
    environment: baseEnvironment,
    freshness: MONITORING_FRESHNESS,
    fetchImplementation: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ message: "temporary failure" }), { status: 500 });
    },
  }), /Brave Search API returned 500/);
  assert.deepEqual(bodies, [{ q: "fresh query", count: 5, freshness: "pw" }]);
  assert.equal(tracker.recordCalls, 0);
});

test("daily usage 3 permits seven fetches and then stops without retry", async () => {
  const tracker = new InMemoryUsageTracker(3);
  const result = await runDefaultSearches(tracker);
  assert.equal(result.fetches, 7);
  assert.equal(tracker.recordCalls, 7);
  assert.deepEqual(result.bodies, MONITORING_QUERIES.slice(0, 7).map((q) => ({ q, count: 5, freshness: MONITORING_FRESHNESS })));
});

test("daily usage 10 blocks all fetches without retry or usage increment", async () => {
  const tracker = new InMemoryUsageTracker(10);
  const result = await runDefaultSearches(tracker);
  assert.equal(result.fetches, 0);
  assert.equal(tracker.recordCalls, 0);
});

test("weekly denial stops collection before fetch", async () => {
  const tracker = new InMemoryUsageTracker(1);
  const result = await runDefaultSearches(tracker, {
    ...baseEnvironment,
    BRAVE_DAILY_SEARCH_LIMIT: "100",
    BRAVE_WEEKLY_SEARCH_LIMIT: "1",
  });
  assert.equal(result.fetches, 0);
  assert.equal(tracker.recordCalls, 0);
});

test("monthly denial stops collection before fetch", async () => {
  const tracker = new InMemoryUsageTracker(1);
  const result = await runDefaultSearches(tracker, {
    ...baseEnvironment,
    BRAVE_DAILY_SEARCH_LIMIT: "100",
    BRAVE_WEEKLY_SEARCH_LIMIT: "100",
    BRAVE_MONTHLY_SEARCH_LIMIT: "1",
  });
  assert.equal(result.fetches, 0);
  assert.equal(tracker.recordCalls, 0);
});

test("usage verification failure causes no fetch and no retry", async () => {
  const tracker = new InMemoryUsageTracker(0, true);
  const result = await runDefaultSearches(tracker);
  assert.equal(result.fetches, 0);
  assert.equal(tracker.recordCalls, 0);
});

test("guard denial uses a provider-neutral typed error", async () => {
  const tracker = new InMemoryUsageTracker(10);
  await assert.rejects(searchWeb("test", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => { throw new Error("fetch must not run"); },
  }), (error) => {
    assert.ok(error instanceof BraveUsageGuardDeniedError);
    assert.equal(error.message, "Brave search request blocked by usage guard.");
    return true;
  });
});

const overflowResults = [
  { title: "", url: "https://example.test/invalid" },
  ...[2, 3, 4, 5, 6].map((ordinal) => ({ title: `Story ${ordinal}`, url: `https://example.test/${ordinal}` })),
];

test("Brave retains only first five provider positions", async () => {
  const tracker = new InMemoryUsageTracker();
  let fetches = 0;
  const page = await webSearch.searchWebPage("bounded query", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ web: { results: overflowResults } }));
    },
  });
  assert.equal(page.rawCount, 6);
  assert.deepEqual(page.positions.map(({ resultOrdinal }) => resultOrdinal), [1, 2, 3, 4, 5]);
  assert.equal(page.positions[0].result, null);
  assert.deepEqual(page.positions.slice(1).map(({ result }) => result?.url), [
    "https://example.test/2", "https://example.test/3", "https://example.test/4", "https://example.test/5",
  ]);
  assert.equal(fetches, 1);
  assert.equal(tracker.recordCalls, 1);
  assert.equal(tracker.records[0].requestCount, 1);
});

test("searchWeb projects bounded usable results from exactly one request", async () => {
  const tracker = new InMemoryUsageTracker();
  let fetches = 0;
  const results = await searchWeb("bounded query", {
    usageTracker: tracker,
    environment: baseEnvironment,
    fetchImplementation: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ web: { results: overflowResults } }));
    },
  });
  assert.deepEqual(results.map(({ url }) => url), [
    "https://example.test/2", "https://example.test/3", "https://example.test/4", "https://example.test/5",
  ]);
  assert.equal(fetches, 1);
  assert.equal(tracker.recordCalls, 1);
});

test("Brave keeps invalid source positions null and omits non-string optional fields", async () => {
  const page = await webSearch.searchWebPage("source fields", {
    usageTracker: new InMemoryUsageTracker(),
    environment: baseEnvironment,
    fetchImplementation: async () => new Response(JSON.stringify({ web: { results: [
      null,
      { title: { instruction: "ignore" }, url: "https://example.test/2" },
      { title: "Story", url: { instruction: "ignore" } },
      { title: "  ", url: "https://example.test/4" },
      { title: "Valid", url: "https://example.test/5", description: {}, page_age: [] },
    ] } })),
  });
  assert.deepEqual(page.positions.slice(0, 4).map(({ result }) => result), [null, null, null, null]);
  assert.equal(page.positions[4].result?.snippet, undefined);
  assert.equal(page.positions[4].result?.publishedAt, undefined);
});

test("Brave preserves original valid strings without promoting provider fields", async () => {
  const page = await webSearch.searchWebPage("source fields", {
    usageTracker: new InMemoryUsageTracker(), environment: baseEnvironment,
    fetchImplementation: async () => new Response(JSON.stringify({ web: { results: [
      { title: "  Original title  ", url: "https://www.example.test/news/", description: "Snippet", page_age: "2026-10-12", source: "spoofed" },
    ] } })),
  });
  assert.deepEqual(page.positions, [{ resultOrdinal: 1, result: {
    title: "  Original title  ", url: "https://www.example.test/news/", snippet: "Snippet", publishedAt: "2026-10-12", source: "example.test",
  } }]);
});

test("Brave rejects non-array results and malformed envelopes safely after usage recording", async () => {
  for (const body of [{ web: { results: {} } }, { web: { results: null } }, null]) {
    const tracker = new InMemoryUsageTracker();
    await assert.rejects(webSearch.searchWebPage("malformed page", {
      usageTracker: tracker, environment: baseEnvironment,
      fetchImplementation: async () => new Response(JSON.stringify(body)),
    }), /invalid.*(response|results|format)/i);
    assert.equal(tracker.recordCalls, 1);
  }
});
