import assert from "node:assert/strict";
import test from "node:test";
import { readAccountPosts, XRequestError } from "../src/tools/x/readAccountPosts.js";

const request = { userId: "1353836358901501952", sinceId: "9007199254740993123", startTime: "2026-10-01T08:00:00.000Z", endTime: "2026-10-08T08:00:00.000Z", bearerToken: "secret-test-token" };

test("selected-account reader sends the exact bounded non-paginated request once", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const result = await readAccountPosts(request, { fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ data: [], meta: { next_token: "more" } }), { status: 200 });
  }});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/2/users/1353836358901501952/tweets");
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
    max_results: "10", exclude: "replies,retweets", start_time: request.startTime, end_time: request.endTime,
    since_id: request.sinceId, "post.fields": "id,author_id,created_at,text,entities,referenced_tweets,edit_history_tweet_ids",
  });
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal(result.truncated, true);
});

test("reader never retries HTTP errors and does not expose the bearer token", async () => {
  let calls = 0;
  await assert.rejects(readAccountPosts(request, { fetch: async () => { calls += 1; return new Response("denied secret-test-token", { status: 401 }); } }), (error: unknown) => {
    assert.ok(error instanceof XRequestError); assert.equal(error.reason, "auth"); assert.doesNotMatch(error.message, /secret-test-token/); return true;
  });
  assert.equal(calls, 1);
});

test("reader rejects unrequested expansions and over-ten response pages", async () => {
  await assert.rejects(readAccountPosts(request, { fetch: async () => new Response(JSON.stringify({ data: [], includes: {} }), { status: 200 }) }), /unrequested expansions/);
  await assert.rejects(readAccountPosts(request, { fetch: async () => new Response(JSON.stringify({ data: Array.from({ length: 11 }, () => ({})) }), { status: 200 }) }), /resource count/);
});

test("reader abort timeout is surfaced without retry", async () => {
  let calls = 0;
  await assert.rejects(readAccountPosts(request, { timeoutMs: 5, fetch: async (_input, init) => {
    calls += 1;
    await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    throw new Error("unreachable");
  }}), /timed out/);
  assert.equal(calls, 1);
});
