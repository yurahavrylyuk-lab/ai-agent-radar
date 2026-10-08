import assert from "node:assert/strict";
import test from "node:test";
import { collectXDiscoveries, xPostIdFromUrl } from "../src/services/xDiscovery.js";
import { APPROVED_X_SOURCES } from "../src/config/xSources.js";
import { XRequestError } from "../src/tools/x/readAccountPosts.js";
import type { XInboxRecord, XReservationResult, XStore, XUsageReservationLimits, XUsageOutcome } from "../src/services/xStore.js";

class MemoryXStore implements XStore {
  poll = new Map<string, { sinceId?: string; disabledReason?: string }>();
  inbox: XInboxRecord[] = [];
  usages: Array<{ id: number; outcome: XUsageOutcome }> = [];
  global?: string;
  async getPollState(id: string) { return this.poll.get(id) ?? {}; }
  async getGlobalDisabledReason() { return this.global; }
  async reserveRequest(_authorId: string, _now: Date, limits: XUsageReservationLimits): Promise<XReservationResult> {
    if (limits.cycleRequestsAlreadyReserved >= limits.requestsPerCycle) return { allowed: false, reason: "budget" };
    const id = this.usages.length + 1; this.usages.push({ id, outcome: "reserved" }); return { allowed: true, reservationId: id };
  }
  async settleRequest(id: number, outcome: Exclude<XUsageOutcome, "reserved">) { this.usages.find((row) => row.id === id)!.outcome = outcome; }
  async commitPage(authorId: string, sinceId: string | undefined, posts: XInboxRecord[]) { for (const post of posts) if (!this.inbox.some((item) => item.postId === post.postId)) this.inbox.push(post); this.poll.set(authorId, { sinceId }); }
  async listPending(_now: Date, limit: number) { return { records: this.inbox.filter((row) => row.state === "pending").slice(0, limit), truncated: false }; }
  async markStoryProcessed(storyUrl: string) { for (const row of this.inbox) if (row.storyUrl === storyUrl) row.state = "processed"; }
  async getStoryByPostId(postId: string) { const row = this.inbox.find((item) => item.postId === postId || item.editIds.includes(postId)); return row ? { storyUrl: row.storyUrl } : undefined; }
  async setDisabledReason(authorId: string | undefined, reason: string) { if (authorId) this.poll.set(authorId, { disabledReason: reason }); else this.global = reason; }
}

const now = new Date("2026-10-08T08:00:00.000Z");
const source = { userId: "1353836358901501952", approvedHandle: "AnthropicAI", label: "Anthropic", category: "ai_lab" as const };
const raw = (overrides: Record<string, unknown> = {}) => ({ id: "9007199254740993123", author_id: source.userId, created_at: "2026-10-07T08:00:00.000Z", text: "A new developer release https://t.co/a", edit_history_tweet_ids: ["9007199254740993000", "9007199254740993123"], entities: { urls: [{ url: "https://t.co/a", expanded_url: "https://example.com/release" }] }, ...overrides });

test("disabled or missing-token X configuration performs zero reads", async () => {
  const store = new MemoryXStore(); let reads = 0;
  const disabled = await collectXDiscoveries({ store, environment: {}, now, sources: [source], read: async () => { reads += 1; return { data: [], truncated: false }; } });
  const missing = await collectXDiscoveries({ store, environment: { X_DISCOVERY_ENABLED: "true" }, now, sources: [source], read: async () => { reads += 1; return { data: [], truncated: false }; } });
  assert.equal(disabled.blockedReason, "disabled"); assert.equal(missing.blockedReason, "config"); assert.equal(reads, 0);
});

test("valid linked post preserves opaque IDs, edit identity and X provenance", async () => {
  const store = new MemoryXStore();
  const result = await collectXDiscoveries({ store, environment: { X_DISCOVERY_ENABLED: "true", X_BEARER_TOKEN: "token" }, now, sources: [source], read: async () => ({ data: [raw()], truncated: false }) });
  assert.equal(result.requestsAttempted, 1); assert.equal(result.postsReceived, 1); assert.equal(result.candidatesAdmitted, 1);
  assert.equal(result.candidates[0].result.url, "https://example.com/release");
  assert.deepEqual(result.candidates[0].provenance, { kind: "x", postId: "9007199254740993000", authorId: source.userId, postUrl: "https://x.com/i/web/status/9007199254740993000", label: "Anthropic" });
  assert.equal(store.poll.get(source.userId)?.sinceId, "9007199254740993123");
  assert.equal(store.usages[0].outcome, "success");
});

test("enabled registry polls exactly five approved IDs in order with no pagination or retry", async () => {
  const store = new MemoryXStore(); const ids: string[] = [];
  const result = await collectXDiscoveries({ store, environment: { X_DISCOVERY_ENABLED: "true", X_BEARER_TOKEN: "token" }, now, read: async (request) => { ids.push(request.userId); return { data: [], truncated: true }; } });
  assert.deepEqual(ids, APPROVED_X_SOURCES.map((item) => item.userId));
  assert.equal(result.requestsAttempted, 5); assert.equal(store.usages.length, 5); assert.equal(result.truncated, true);
});

test("renamed display handle does not change immutable account identity", async () => {
  const store = new MemoryXStore();
  const renamed = { ...source, approvedHandle: "NewDisplayHandle" };
  const result = await collectXDiscoveries({ store, environment: { X_DISCOVERY_ENABLED: "true", X_BEARER_TOKEN: "token" }, now, sources: [renamed], read: async (request) => { assert.equal(request.userId, source.userId); return { data: [raw()], truncated: false }; } });
  assert.equal(result.candidates[0].provenance.authorId, source.userId);
});

test("same outbound URL is admitted once and replies, quotes, multiple links and unresolved short links are filtered", async () => {
  const store = new MemoryXStore();
  const response = [raw(), raw({ id: "9007199254740993124", edit_history_tweet_ids: ["9007199254740993124"] }), raw({ id: "9007199254740993125", edit_history_tweet_ids: ["9007199254740993125"], referenced_tweets: [{ type: "quoted", id: "1" }] }), raw({ id: "9007199254740993126", edit_history_tweet_ids: ["9007199254740993126"], referenced_tweets: [{ type: "replied_to", id: "1" }] }), raw({ id: "9007199254740993127", edit_history_tweet_ids: ["9007199254740993127"], referenced_tweets: [{ type: "retweeted", id: "1" }] }), raw({ id: "9007199254740993128", edit_history_tweet_ids: ["9007199254740993128"], entities: { urls: [{ expanded_url: "https://a.example/x" }, { expanded_url: "https://b.example/x" }] } }), raw({ id: "9007199254740993129", edit_history_tweet_ids: ["9007199254740993129"], entities: { urls: [{ url: "https://t.co/unresolved" }] } })];
  const result = await collectXDiscoveries({ store, environment: { X_DISCOVERY_ENABLED: "true", X_BEARER_TOKEN: "token" }, now, sources: [source], read: async () => ({ data: response, truncated: true }) });
  assert.equal(result.candidates.length, 1); assert.equal(result.duplicates, 1); assert.equal(result.truncated, true);
});

test("an original X-only post uses the stable canonical post identity", async () => {
  const store = new MemoryXStore();
  const result = await collectXDiscoveries({ store, environment: { X_DISCOVERY_ENABLED: "true", X_BEARER_TOKEN: "token" }, now, sources: [source], read: async () => ({ data: [raw({ entities: undefined, text: "Standalone announcement" })], truncated: false }) });
  assert.equal(result.candidates[0].result.url, "https://x.com/i/web/status/9007199254740993000");
});

test("account mismatch rejects the page without advancing cursor and charges reservation", async () => {
  const store = new MemoryXStore(); store.poll.set(source.userId, { sinceId: "100" });
  const result = await collectXDiscoveries({ store, environment: { X_DISCOVERY_ENABLED: "true", X_BEARER_TOKEN: "token" }, now, sources: [source], read: async () => ({ data: [raw({ author_id: "74286565" })], truncated: false }) });
  assert.equal(result.accountsFailed, 1); assert.equal(result.failures[0].reason, "malformed_response"); assert.equal(store.poll.get(source.userId)?.sinceId, "100"); assert.equal(store.usages[0].outcome, "error");
});

test("temporary one-account failure continues while auth and rate-limit failures stop further accounts", async () => {
  const firstTwo = APPROVED_X_SOURCES.slice(0, 2);
  const store = new MemoryXStore(); let calls = 0;
  const partial = await collectXDiscoveries({ store, environment: { X_DISCOVERY_ENABLED: "true", X_BEARER_TOKEN: "token" }, now, sources: firstTwo, read: async () => { calls += 1; if (calls === 1) throw new XRequestError("temporary", "provider_error"); return { data: [], truncated: false }; } });
  assert.equal(calls, 2); assert.equal(partial.accountsFailed, 1); assert.equal(partial.blockedReason, undefined);
  for (const reason of ["auth", "rate_limit"] as const) {
    const stoppingStore = new MemoryXStore(); let stoppingCalls = 0;
    const stopped = await collectXDiscoveries({ store: stoppingStore, environment: { X_DISCOVERY_ENABLED: "true", X_BEARER_TOKEN: "token" }, now, sources: firstTwo, read: async () => { stoppingCalls += 1; throw new XRequestError("blocked", reason); } });
    assert.equal(stoppingCalls, 1); assert.equal(stopped.blockedReason, reason);
  }
});

test("full X outage is isolated as bounded account failures", async () => {
  const store = new MemoryXStore();
  const result = await collectXDiscoveries({ store, environment: { X_DISCOVERY_ENABLED: "true", X_BEARER_TOKEN: "token" }, now, read: async () => { throw new XRequestError("outage", "provider_error"); } });
  assert.equal(result.requestsAttempted, 5); assert.equal(result.accountsFailed, 5); assert.equal(result.failures.length, 5); assert.deepEqual(result.candidates, []);
});

test("X and Twitter status variants canonicalize the same large decimal ID", () => {
  const id = "1353836358901501952";
  assert.equal(xPostIdFromUrl(`https://x.com/OpenAI/status/${id}`), id);
  assert.equal(xPostIdFromUrl(`https://twitter.com/i/web/status/${id}`), id);
  assert.equal(xPostIdFromUrl(`https://example.com/OpenAI/status/${id}`), undefined);
});
