import assert from "node:assert/strict";
import test from "node:test";

import { THREADS_ENDPOINT, THREADS_LIMITS, THREADS_QUERIES } from "../src/config/threadsSources.js";
import { collectThreads } from "../src/services/threadsDiscovery.js";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const EXPIRY = "2026-11-20T00:00:00.000Z";

function post(id: string, query = "AI agents", timestamp = "2026-10-25T11:00:00+0000") {
  return { id, text: `${query} announcement`, permalink: `https://www.threads.net/@official/post/${id}`, timestamp };
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function enabled(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return { enabled: true, publicSearchApproved: true, accessToken: "test-token", tokenExpiresAt: EXPIRY, now: NOW, fetchImpl, ...extra } as Parameters<typeof collectThreads>[0];
}

test("disabled_and_missing_config_make_zero_requests", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return json({ data: [] }); }) as typeof fetch;
  const disabled = await collectThreads({ ...enabled(fetchImpl), enabled: false });
  const missing = await collectThreads({ ...enabled(fetchImpl), accessToken: " " });
  assert.equal(calls, 0);
  assert.equal(disabled.metrics.health, "disabled");
  assert.equal(missing.metrics.reason, "configuration");
  assert.equal(missing.metrics.skippedQueries, 3);
});

test("restricted_success_does_not_prove_public_access", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return json({ data: [post("1")] }); }) as typeof fetch;
  const blocked = await collectThreads({ ...enabled(fetchImpl), publicSearchApproved: false });
  assert.equal(calls, 0);
  assert.equal(blocked.metrics.publicApprovalAttested, false);
  assert.equal(blocked.metrics.reason, "public_permission_unapproved");
  assert.equal("publicAccessVerified" in blocked.metrics, false);
});

test("three_recent_queries_fifteen_positions", async () => {
  const urls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual");
    urls.push(new URL(String(input)));
    const queryIndex = urls.length;
    return json({ data: Array.from({ length: 6 }, (_, i) => post(`${queryIndex}${i + 1}`)), paging: { next: "https://evil.example/next" } });
  }) as typeof fetch;
  const result = await collectThreads(enabled(fetchImpl));
  assert.equal(urls.length, 3);
  assert.deepEqual(urls.map(url => url.origin + url.pathname), Array(3).fill(THREADS_ENDPOINT));
  assert.deepEqual(urls.map(url => url.searchParams.get("q")), THREADS_QUERIES.map(item => item.query));
  for (const url of urls) {
    assert.equal(url.searchParams.get("search_type"), "RECENT");
    assert.equal(url.searchParams.get("search_mode"), "KEYWORD");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(url.searchParams.get("fields"), "id,text,permalink,timestamp");
  }
  assert.equal(result.observations.length, 15);
  assert.equal(result.metrics.observedPositions, 15);
  assert.equal(result.metrics.outcomes.every(outcome => outcome.pagingIgnored), true);
});

test("invalid_positions_are_not_refilled", async () => {
  const payload = { data: [{ ...post("1"), text: "" }, post("2"), post("3"), post("4"), post("5"), post("6")] };
  const result = await collectThreads(enabled((async () => json(payload)) as typeof fetch));
  assert.equal(result.observations.length, 15);
  assert.equal(result.observations[0]?.result, null);
  assert.equal(result.observations.some(item => item.result?.url.endsWith("/6")), false);
});

test("freshness_uses_one_collection_window", async () => {
  const urls: URL[] = [];
  await collectThreads(enabled((async (input: RequestInfo | URL) => { urls.push(new URL(String(input))); return json({ data: [] }); }) as typeof fetch));
  assert.deepEqual(new Set(urls.map(url => url.searchParams.get("until"))), new Set([String(Math.floor(NOW.getTime() / 1000))]));
  assert.deepEqual(new Set(urls.map(url => url.searchParams.get("since"))), new Set([String(Math.floor(NOW.getTime() / 1000) - 259200)]));
});

test("calendar timestamps validate before Date normalization", async () => {
  const cases = [
    ["2026-03-01T12:00:00.000Z", "2026-03-01T13:00:00.000Z", true],
    ["2026-03-01T12:00:00+0000", "2026-03-01T13:00:00.000Z", true],
    ["2024-02-29T12:00:00.000Z", "2024-02-29T13:00:00.000Z", true],
    ["2026-02-30T12:00:00.000Z", "2026-03-02T13:00:00.000Z", false],
    ["2025-02-29T12:00:00.000Z", "2025-03-01T13:00:00.000Z", false],
    ["2026-04-31T12:00:00.000Z", "2026-05-01T13:00:00.000Z", false],
    ["2026-13-01T12:00:00.000Z", "2026-12-01T13:00:00.000Z", false],
    ["2026-03-01T24:00:00.000Z", "2026-03-02T01:00:00.000Z", false],
    ["2026-03-01T12:60:00.000Z", "2026-03-01T13:00:00.000Z", false],
    ["2026-03-01T12:00:60.000Z", "2026-03-01T13:00:00.000Z", false],
  ] as const;

  for (const [timestamp, now, accepted] of cases) {
    const result = await collectThreads(enabled(
      (async () => json({ data: [post("1", "AI agents", timestamp)] })) as typeof fetch,
      { now: new Date(now), tokenExpiresAt: "2027-01-01T00:00:00.000Z" },
    ));
    assert.equal(result.metrics.observedPositions, 3, timestamp);
    assert.equal(result.metrics.validObservations, accepted ? 3 : 0, timestamp);
    assert.equal(result.observations.every(item => item.result !== null), accepted, timestamp);
  }
});

test("bounded_stream_and_deadlines", async () => {
  const oversized = "x".repeat(THREADS_LIMITS.successBodyBytes + 1);
  const response = new Response(oversized, { headers: { "content-type": "application/json" } });
  const result = await collectThreads(enabled((async () => response.clone()) as typeof fetch));
  assert.equal(result.metrics.outcomes[0]?.reason, "body_limit");
  assert.ok(result.metrics.attemptedQueries <= 3);
});

test("terminal_errors_stop_later_queries", async () => {
  let calls = 0;
  const result = await collectThreads(enabled((async () => {
    calls += 1;
    return json({ error: { code: 190, message: "token test-token must never escape" } }, { status: 401 });
  }) as typeof fetch));
  assert.equal(calls, 1);
  assert.equal(result.metrics.reason, "auth");
  assert.equal(result.metrics.skippedQueries, 2);
  assert.equal(JSON.stringify(result).includes("test-token"), false);
});

test("partial_failure_keeps_prior_observations", async () => {
  let calls = 0;
  const result = await collectThreads(enabled((async () => {
    calls += 1;
    if (calls === 2) return new Response("bad", { status: 500 });
    return json({ data: [post(String(calls))] });
  }) as typeof fetch));
  assert.equal(calls, 3);
  assert.equal(result.metrics.health, "degraded");
  assert.equal(result.metrics.succeededQueries, 2);
  assert.equal(result.metrics.failedQueries, 1);
  assert.equal(result.observations.filter(item => item.result).length, 2);
});
