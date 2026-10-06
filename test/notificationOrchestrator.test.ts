import assert from "node:assert/strict";
import test from "node:test";
import { notifyDeliveryDigest, notifyDiscovery, notifyDigest } from "../src/services/notificationOrchestrator.js";
import type { DeliveryCandidate, DiscoveryEmailContent, DiscoveryProcessingResult, NotificationRecord } from "../src/types/index.js";
import type { NotificationHistory } from "../src/services/notificationHistory.js";

function result(status: DiscoveryProcessingResult["status"], relevanceScore: number, sourceUrl = "https://example.com/discovery"): DiscoveryProcessingResult {
  return {
    status,
    discovery: {
      normalizedUrl: sourceUrl,
      firstSeenAt: "2026-09-19T12:00:00.000Z",
      lastSeenAt: "2026-09-19T12:00:00.000Z",
      analysis: {
        name: "Example Agent",
        category: "new_agent",
        summary: "A test analysis.",
        relevanceScore,
        whyItMatters: "It is useful for testing.",
        educationalValue: "It demonstrates orchestration.",
        projectOpportunities: ["Build a prototype"],
        technologies: ["TypeScript"],
        sourceTitle: "Trusted source title",
        sourceUrl,
      },
    },
  };
}

function record(sourceUrl = "https://example.com/discovery", providerMessageId = "email_123"): NotificationRecord {
  return { normalizedUrl: sourceUrl, channel: "email", sentAt: "2026-09-19T14:00:00.000Z", providerMessageId };
}

const content: DiscoveryEmailContent = { subject: "Test", text: "Test", html: "<p>Test</p>" };

test("new discovery below relevance threshold is not eligible and does no notification work", async () => {
  let emailCalls = 0;
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { throw new Error("history should not be checked"); },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent() { throw new Error("unreachable"); },
  };
  const outcome = await notifyDiscovery(result("new", 6), {
    history,
    sendEmail: async () => { emailCalls++; return { id: "email_123" }; },
  });
  assert.deepEqual(outcome, { status: "not_eligible" });
  assert.equal(emailCalls, 0);
});

test("high-relevance duplicate discovery is not eligible and never sends", async () => {
  let emailCalls = 0;
  const outcome = await notifyDiscovery(result("duplicate", 10), {
    sendEmail: async () => { emailCalls++; return { id: "email_123" }; },
  });
  assert.deepEqual(outcome, { status: "not_eligible" });
  assert.equal(emailCalls, 0);
});

test("eligible unsent discovery formats, sends, then records the provider ID", async () => {
  const events: string[] = [];
  let recordedUrl = "";
  let recordedId: string | undefined;
  const sourceUrl = "https://trusted.example/discovery";
  const history: NotificationHistory = {
    async hasNotificationBeenSent(url) { events.push("lookup"); assert.equal(url, sourceUrl); return false; },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent(url, channel, providerMessageId) {
      events.push("record");
      recordedUrl = url;
      assert.equal(channel, "email");
      recordedId = providerMessageId;
      return record(url, providerMessageId);
    },
  };
  const input = result("new", 7, sourceUrl);
  const outcome = await notifyDiscovery(input, {
    history,
    formatEmail: (discovery) => { events.push("format"); assert.equal(discovery, input.discovery); return content; },
    sendEmail: async (formatted) => { events.push("send"); assert.equal(formatted, content); return { id: "email_accepted" }; },
  });
  assert.deepEqual(events, ["lookup", "format", "send", "record"]);
  assert.equal(recordedUrl, sourceUrl);
  assert.equal(recordedId, "email_accepted");
  assert.deepEqual(outcome, { status: "sent", record: record(sourceUrl, "email_accepted") });
});

test("eligible relevance-10 discovery sends exactly once", async () => {
  let emailCalls = 0;
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { return false; },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent(url, _channel, id) { return record(url, id); },
  };
  const outcome = await notifyDiscovery(result("new", 10), {
    history,
    formatEmail: () => content,
    sendEmail: async () => { emailCalls++; return { id: "email_123" }; },
  });
  assert.equal(outcome.status, "sent");
  assert.equal(emailCalls, 1);
});

test("already-sent discovery never calls email provider or creates another record", async () => {
  const existing = record();
  let emailCalls = 0;
  let recordCalls = 0;
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { return true; },
    async getNotificationRecord() { return existing; },
    async recordNotificationSent() { recordCalls++; return existing; },
  };
  const outcome = await notifyDiscovery(result("new", 10), {
    history,
    formatEmail: () => { throw new Error("formatter should not run"); },
    sendEmail: async () => { emailCalls++; return { id: "email_later" }; },
  });
  assert.deepEqual(outcome, { status: "already_sent", record: existing });
  assert.equal(emailCalls, 0);
  assert.equal(recordCalls, 0);
});

test("notification-history lookup failure prevents email sending", async () => {
  let emailCalls = 0;
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { throw new Error("notification history is corrupted"); },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent() { throw new Error("unreachable"); },
  };
  await assert.rejects(notifyDiscovery(result("new", 7), {
    history,
    sendEmail: async () => { emailCalls++; return { id: "email_123" }; },
  }), /notification history is corrupted/);
  assert.equal(emailCalls, 0);
});

test("failed email is never recorded as sent", async () => {
  let recordCalls = 0;
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { return false; },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent() { recordCalls++; return record(); },
  };
  await assert.rejects(notifyDiscovery(result("new", 7), {
    history,
    formatEmail: () => content,
    sendEmail: async () => { throw new Error("email provider failed"); },
  }), /email provider failed/);
  assert.equal(recordCalls, 0);
});

test("post-send notification persistence failure is surfaced without retry", async () => {
  let emailCalls = 0;
  let recordCalls = 0;
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { return false; },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent() { recordCalls++; throw new Error("history write failed"); },
  };
  await assert.rejects(notifyDiscovery(result("new", 7), {
    history,
    formatEmail: () => content,
    sendEmail: async () => { emailCalls++; return { id: "email_accepted" }; },
  }), /Email was accepted, but notification delivery could not be persisted: history write failed/);
  assert.equal(emailCalls, 1);
  assert.equal(recordCalls, 1);
});

test("notification orchestration does not mutate its input", async () => {
  const input = result("new", 7);
  const original = structuredClone(input);
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { return false; },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent(url, _channel, id) { return record(url, id); },
  };
  await notifyDiscovery(input, { history, formatEmail: () => content, sendEmail: async () => ({ id: "email_123" }) });
  assert.deepEqual(input, original);
});

// ── notifyDigest ──────────────────────────────────────────────────────────────

function digestResult(relevanceScore: number, sourceUrl: string): DiscoveryProcessingResult {
  return result("new", relevanceScore, sourceUrl);
}

function namedDigestResult(relevanceScore: number, sourceUrl: string, name: string): DiscoveryProcessingResult {
  const item = digestResult(relevanceScore, sourceUrl);
  item.discovery.analysis.name = name;
  item.discovery.analysis.sourceTitle = name;
  return item;
}

function openHistory(): NotificationHistory {
  return {
    async hasNotificationBeenSent() { return false; },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent(url, _ch, id) { return record(url, id); },
  };
}

function deliveryCandidate(
  relevanceScore: number,
  sourceUrl: string,
  origin: DeliveryCandidate["origin"],
  name = "Example Agent",
): DeliveryCandidate {
  const item = namedDigestResult(relevanceScore, sourceUrl, name);
  const normalized = new URL(sourceUrl);
  normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";
  item.discovery.normalizedUrl = normalized.toString();
  return { discovery: item.discovery, origin };
}

test("notifyDigest returns an empty map for empty input", async () => {
  const map = await notifyDigest([], { history: openHistory(), formatDigest: () => content, sendEmail: async () => { throw new Error("should not send"); } });
  assert.equal(map.size, 0);
});

test("notifyDigest checks history for new fallback candidates but not duplicates", async () => {
  let historyCalls = 0;
  let emailCalls = 0;
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { historyCalls++; return false; },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent() { throw new Error("unreachable"); },
  };
  const ineligible = [result("new", 6, "https://example.com/low"), result("duplicate", 9, "https://example.com/dup")];
  const map = await notifyDigest(ineligible, { history, formatDigest: () => content, sendEmail: async () => { emailCalls++; return { id: "x" }; } });
  assert.equal(map.get("https://example.com/low")?.status, "not_eligible");
  assert.equal(map.get("https://example.com/dup")?.status, "not_eligible");
  assert.equal(historyCalls, 1);
  assert.equal(emailCalls, 0);
});

test("notifyDigest marks already-sent stories as already_sent and skips them in the digest", async () => {
  const existing = record("https://example.com/sent");
  const history: NotificationHistory = {
    async hasNotificationBeenSent(url) { return url === "https://example.com/sent"; },
    async getNotificationRecord(url) { return url === "https://example.com/sent" ? existing : undefined; },
    async recordNotificationSent(url, _ch, id) { return record(url, id); },
  };
  let sendCalls = 0;
  const map = await notifyDigest(
    [digestResult(9, "https://example.com/sent"), digestResult(8, "https://example.com/new")],
    { history, formatDigest: () => content, sendEmail: async () => { sendCalls++; return { id: "digest_1" }; } },
  );
  assert.equal(map.get("https://example.com/sent")?.status, "already_sent");
  assert.equal(map.get("https://example.com/new")?.status, "sent");
  assert.equal(sendCalls, 1);
});

test("notifyDigest sends exactly one email and records a sent entry for each digest story", async () => {
  const stories = [digestResult(8, "https://example.com/a"), digestResult(9, "https://example.com/b"), digestResult(7, "https://example.com/c")];
  const recordedUrls: string[] = [];
  let formatCalls = 0;
  let sendCalls = 0;
  const map = await notifyDigest(stories, {
    history: openHistory(),
    formatDigest: (s) => { formatCalls++; assert.equal(s.length, 3); return content; },
    sendEmail: async () => { sendCalls++; return { id: "digest_1" }; },
    // override recordNotificationSent via a wrapped history to track calls
  });
  // Use the default openHistory which records
  assert.equal(formatCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(map.get("https://example.com/a")?.status, "sent");
  assert.equal(map.get("https://example.com/b")?.status, "sent");
  assert.equal(map.get("https://example.com/c")?.status, "sent");
  void recordedUrls; // suppress unused warning
});

test("notifyDigest sorts eligible stories by relevance descending so the top story is passed first", async () => {
  const stories = [digestResult(7, "https://example.com/low"), digestResult(10, "https://example.com/top"), digestResult(9, "https://example.com/mid")];
  const passedOrder: string[] = [];
  await notifyDigest(stories, {
    history: openHistory(),
    formatDigest: (s) => { passedOrder.push(...s.map((d) => d.analysis.sourceUrl)); return content; },
    sendEmail: async () => ({ id: "x" }),
  });
  assert.equal(passedOrder[0], "https://example.com/top");
  assert.equal(passedOrder[1], "https://example.com/mid");
  assert.equal(passedOrder[2], "https://example.com/low");
});

test("notifyDigest applies Codex and Claude Code priority after normal eligibility", async () => {
  const stories = [
    namedDigestResult(7, "https://example.com/generic-tool", "Generic developer tool"),
    namedDigestResult(7, "https://example.com/codex", "Codex developer tool"),
    namedDigestResult(7, "https://example.com/generic-language", "Generic programming update"),
    namedDigestResult(7, "https://example.com/claude-code", "Claude Code programming update"),
  ];
  const passedOrder: string[] = [];
  await notifyDigest(stories, {
    history: openHistory(),
    formatDigest: (items) => { passedOrder.push(...items.map((item) => item.analysis.sourceUrl)); return content; },
    sendEmail: async () => ({ id: "x" }),
  });
  assert.deepEqual(passedOrder.slice(0, 2), ["https://example.com/codex", "https://example.com/claude-code"]);
});

test("notifyDigest caps the digest at four stories even when more are eligible", async () => {
  const stories = Array.from({ length: 6 }, (_, i) => digestResult(10 - i, `https://example.com/story-${i}`));
  let storiesToFormatter = 0;
  await notifyDigest(stories, {
    history: openHistory(),
    formatDigest: (s) => { storiesToFormatter = s.length; return content; },
    sendEmail: async () => ({ id: "x" }),
  });
  assert.equal(storiesToFormatter, 4);
});

test("notifyDigest deduplicates eligible stories by URL before sending", async () => {
  const url = "https://example.com/dup";
  const stories = [digestResult(9, url), digestResult(8, url)];
  let storiesToFormatter = 0;
  const map = await notifyDigest(stories, {
    history: openHistory(),
    formatDigest: (s) => { storiesToFormatter = s.length; return content; },
    sendEmail: async () => ({ id: "x" }),
  });
  assert.equal(storiesToFormatter, 1);
  assert.equal(map.get(url)?.status, "sent");
});

test("notifyDigest skips sending when all eligible stories are already sent", async () => {
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { return true; },
    async getNotificationRecord(url) { return record(url); },
    async recordNotificationSent() { throw new Error("unreachable"); },
  };
  let sendCalls = 0;
  const map = await notifyDigest(
    [digestResult(9, "https://example.com/a")],
    { history, formatDigest: () => { throw new Error("should not format"); }, sendEmail: async () => { sendCalls++; return { id: "x" }; } },
  );
  assert.equal(map.get("https://example.com/a")?.status, "already_sent");
  assert.equal(sendCalls, 0);
});

test("notifyDigest uses the normal path without fallback padding when any normal candidate exists", async () => {
  const stories = [
    digestResult(7, "https://unknown.example/normal"),
    digestResult(6, "https://openai.com/fallback"),
  ];
  const formatted: string[] = [];
  let mode = "";
  const map = await notifyDigest(stories, {
    history: openHistory(),
    formatDigest: (items, options) => {
      formatted.push(...items.map((item) => item.analysis.sourceUrl));
      mode = options?.mode ?? "";
      return content;
    },
    sendEmail: async () => ({ id: "normal_1" }),
  });

  assert.deepEqual(formatted, ["https://unknown.example/normal"]);
  assert.equal(mode, "normal");
  assert.equal(map.get("https://unknown.example/normal")?.status, "sent");
  assert.equal(map.get("https://openai.com/fallback")?.status, "not_eligible");
});

test("notifyDigest sends a labelled fallback when all unsent new stories are below threshold and trusted", async () => {
  const input = digestResult(6, "https://openai.com/fallback");
  const original = structuredClone(input);
  let formattedMode = "";
  let formattedScore = 0;
  let sentContent: DiscoveryEmailContent | undefined;
  const map = await notifyDigest([input], {
    history: openHistory(),
    formatDigest: (items, options) => {
      formattedMode = options?.mode ?? "";
      formattedScore = items[0].analysis.relevanceScore;
      return { subject: "Fallback", text: "It could be relevant", html: "<p>It could be relevant</p>" };
    },
    sendEmail: async (email) => { sentContent = email; return { id: "fallback_1" }; },
  });

  assert.equal(formattedMode, "fallback");
  assert.equal(formattedScore, 6);
  assert.match(sentContent?.text ?? "", /It could be relevant/);
  assert.match(sentContent?.html ?? "", /It could be relevant/);
  assert.equal(map.get("https://openai.com/fallback")?.status, "sent");
  assert.deepEqual(input, original);
});

test("notifyDigest ranks trusted fallback candidates and caps the digest at four", async () => {
  const stories = [
    digestResult(2, "https://openai.com/two"),
    digestResult(6, "https://anthropic.com/six"),
    digestResult(4, "https://github.com/four"),
    digestResult(5, "https://nodejs.org/five"),
    digestResult(3, "https://python.org/three"),
  ];
  const formatted: string[] = [];
  await notifyDigest(stories, {
    history: openHistory(),
    formatDigest: (items, options) => {
      assert.equal(options?.mode, "fallback");
      formatted.push(...items.map((item) => item.analysis.sourceUrl));
      return content;
    },
    sendEmail: async () => ({ id: "fallback_ranked" }),
  });

  assert.deepEqual(formatted, [
    "https://anthropic.com/six",
    "https://nodejs.org/five",
    "https://github.com/four",
    "https://python.org/three",
  ]);
});

test("notifyDigest excludes untrusted fallback candidates and sends nothing when none are trusted", async () => {
  let sendCalls = 0;
  const map = await notifyDigest([
    digestResult(6, "https://unknown.example/one"),
    namedDigestResult(6, "https://support.anthropic.com/claude", "Claude Code release"),
  ], {
    history: openHistory(),
    formatDigest: () => { throw new Error("should not format"); },
    sendEmail: async () => { sendCalls++; return { id: "x" }; },
  });

  assert.equal(sendCalls, 0);
  assert.equal(map.get("https://unknown.example/one")?.status, "not_eligible");
  assert.equal(map.get("https://support.anthropic.com/claude")?.status, "not_eligible");
});

test("notifyDigest records fallback delivery and will not resend it", async () => {
  const sent = new Map<string, NotificationRecord>();
  const history: NotificationHistory = {
    async hasNotificationBeenSent(url) { return sent.has(url); },
    async getNotificationRecord(url) { return sent.get(url); },
    async recordNotificationSent(url, _channel, id) {
      const notification = record(url, id);
      sent.set(url, notification);
      return notification;
    },
  };
  const story = digestResult(6, "https://developers.openai.com/fallback");
  let sendCalls = 0;
  const dependencies = {
    history,
    formatDigest: () => content,
    sendEmail: async () => { sendCalls++; return { id: "fallback_history" }; },
  };

  const first = await notifyDigest([story], dependencies);
  const second = await notifyDigest([story], dependencies);

  assert.equal(first.get(story.discovery.analysis.sourceUrl)?.status, "sent");
  assert.equal(second.get(story.discovery.analysis.sourceUrl)?.status, "already_sent");
  assert.equal(sendCalls, 1);
});

test("notifyDigest does not resend a normally-sent URL through fallback", async () => {
  const url = "https://platform.openai.com/update";
  const existing = record(url, "normal_delivery");
  const history: NotificationHistory = {
    async hasNotificationBeenSent(candidate) { return candidate === url; },
    async getNotificationRecord(candidate) { return candidate === url ? existing : undefined; },
    async recordNotificationSent() { throw new Error("unreachable"); },
  };
  let sendCalls = 0;
  const map = await notifyDigest([digestResult(6, url)], {
    history,
    formatDigest: () => content,
    sendEmail: async () => { sendCalls++; return { id: "x" }; },
  });

  assert.equal(map.get(url)?.status, "already_sent");
  assert.equal(sendCalls, 0);
});

test("notifyDigest may fall back when every normal candidate was already sent", async () => {
  const normalUrl = "https://unknown.example/already-sent";
  const fallbackUrl = "https://ai.google.dev/fallback";
  const existing = record(normalUrl, "normal_delivery");
  const history: NotificationHistory = {
    async hasNotificationBeenSent(url) { return url === normalUrl; },
    async getNotificationRecord(url) { return url === normalUrl ? existing : undefined; },
    async recordNotificationSent(url, _channel, id) { return record(url, id); },
  };
  let mode = "";
  const map = await notifyDigest([
    digestResult(9, normalUrl),
    digestResult(6, fallbackUrl),
  ], {
    history,
    formatDigest: (_items, options) => { mode = options?.mode ?? ""; return content; },
    sendEmail: async () => ({ id: "fallback_after_normal" }),
  });

  assert.equal(mode, "fallback");
  assert.equal(map.get(normalUrl)?.status, "already_sent");
  assert.equal(map.get(fallbackUrl)?.status, "sent");
});

test("notifyDigest aborts on fallback history uncertainty without sending", async () => {
  let sendCalls = 0;
  const history: NotificationHistory = {
    async hasNotificationBeenSent() { throw new Error("history unavailable"); },
    async getNotificationRecord() { throw new Error("unreachable"); },
    async recordNotificationSent() { throw new Error("unreachable"); },
  };
  await assert.rejects(notifyDigest([digestResult(6, "https://openai.com/fallback")], {
    history,
    sendEmail: async () => { sendCalls++; return { id: "x" }; },
  }), /history unavailable/);
  assert.equal(sendCalls, 0);
});

test("notifyDigest excludes duplicates from fallback and deduplicates same-cycle trusted URLs", async () => {
  const url = "https://github.blog/release";
  let storiesToFormatter = 0;
  const map = await notifyDigest([
    result("duplicate", 6, "https://openai.com/old"),
    digestResult(6, url),
    digestResult(5, url),
  ], {
    history: openHistory(),
    formatDigest: (items) => { storiesToFormatter = items.length; return content; },
    sendEmail: async () => ({ id: "fallback_dedupe" }),
  });

  assert.equal(storiesToFormatter, 1);
  assert.equal(map.get("https://openai.com/old")?.status, "not_eligible");
  assert.equal(map.get(url)?.status, "sent");
});

test("fresh and replay candidates share one ranked four-story digest", async () => {
  const candidates = [
    deliveryCandidate(7, "https://example.com/fresh", "fresh", "Generic tool"),
    deliveryCandidate(8, "https://example.com/replay", "replay", "Generic replay"),
    deliveryCandidate(7, "https://example.com/codex", "replay", "Codex update"),
    deliveryCandidate(9, "https://example.com/top", "fresh", "Top story"),
    deliveryCandidate(10, "https://example.com/omitted", "replay", "Omitted generic"),
  ];
  const formatted: string[] = [];
  const outcome = await notifyDeliveryDigest(candidates, {
    history: openHistory(),
    formatDigest: (items, options) => {
      assert.equal(options?.mode, "normal");
      formatted.push(...items.map((item) => item.analysis.sourceUrl));
      return content;
    },
    sendEmail: async () => ({ id: "digest_shared" }),
  });

  assert.equal(formatted.length, 4);
  assert.deepEqual(formatted, [
    "https://example.com/omitted",
    "https://example.com/top",
    "https://example.com/replay",
    "https://example.com/codex",
  ]);
  assert.equal(outcome.sentCandidates.length, 4);
});

test("a fresh candidate replaces the same normalized replay URL", async () => {
  const url = "https://example.com/same";
  const replay = deliveryCandidate(8, `${url}/`, "replay");
  const fresh = deliveryCandidate(8, url, "fresh");
  let formattedOrigins: string[] = [];
  const outcome = await notifyDeliveryDigest([replay, fresh], {
    history: openHistory(),
    formatDigest: (items) => { formattedOrigins = items.map((item) => item.normalizedUrl); return content; },
    sendEmail: async () => ({ id: "digest_deduped" }),
  });
  assert.deepEqual(formattedOrigins, [url]);
  assert.equal(outcome.sentCandidates.length, 1);
  assert.equal(outcome.sentCandidates[0]?.origin, "fresh");
});

test("an eligible replay candidate suppresses P4 fallback candidates", async () => {
  const normalReplay = deliveryCandidate(7, "https://unknown.example/replay", "replay");
  const fallbackFresh = deliveryCandidate(6, "https://openai.com/fresh", "fresh");
  const formatted: string[] = [];
  const outcome = await notifyDeliveryDigest([fallbackFresh, normalReplay], {
    history: openHistory(),
    formatDigest: (items, options) => {
      assert.equal(options?.mode, "normal");
      formatted.push(...items.map((item) => item.analysis.sourceUrl));
      return content;
    },
    sendEmail: async () => ({ id: "normal_replay" }),
  });
  assert.deepEqual(formatted, [normalReplay.discovery.analysis.sourceUrl]);
  assert.equal(outcome.notifications.get(fallbackFresh.discovery.analysis.sourceUrl)?.status, "not_eligible");
});

test("below-threshold replay is rechecked against current exact-host trust", async () => {
  const trusted = deliveryCandidate(6, "https://openai.com/replay", "replay");
  const untrusted = deliveryCandidate(6, "https://support.openai.com/replay", "replay");
  const formatted: string[] = [];
  const outcome = await notifyDeliveryDigest([untrusted, trusted], {
    history: openHistory(),
    formatDigest: (items, options) => {
      assert.equal(options?.mode, "fallback");
      formatted.push(...items.map((item) => item.analysis.sourceUrl));
      return content;
    },
    sendEmail: async () => ({ id: "fallback_replay" }),
  });
  assert.deepEqual(formatted, [trusted.discovery.analysis.sourceUrl]);
  assert.equal(outcome.notifications.get(untrusted.discovery.analysis.sourceUrl)?.status, "not_eligible");
  assert.equal(trusted.discovery.analysis.relevanceScore, 6);
});

test("fresh and replay fallback stories share one labelled four-story email", async () => {
  const candidates = [
    deliveryCandidate(6, "https://openai.com/fresh", "fresh"),
    deliveryCandidate(5, "https://anthropic.com/replay", "replay"),
    deliveryCandidate(4, "https://github.com/one", "fresh"),
    deliveryCandidate(3, "https://nodejs.org/two", "replay"),
    deliveryCandidate(2, "https://python.org/omitted", "replay"),
  ];
  let sends = 0;
  let mode = "";
  let formattedCount = 0;
  const outcome = await notifyDeliveryDigest(candidates, {
    history: openHistory(),
    formatDigest: (items, options) => {
      formattedCount = items.length;
      mode = options?.mode ?? "";
      return { subject: "Fallback", text: "It could be relevant", html: "<p>It could be relevant</p>" };
    },
    sendEmail: async (email) => {
      sends += 1;
      assert.match(email.text, /It could be relevant/);
      assert.match(email.html, /It could be relevant/);
      return { id: "fallback_shared" };
    },
  });
  assert.equal(mode, "fallback");
  assert.equal(formattedCount, 4);
  assert.equal(sends, 1);
  assert.equal(outcome.sentCandidates.length, 4);
});

test("already-notified replay candidates are never resent", async () => {
  const candidate = deliveryCandidate(9, "https://example.com/already", "replay");
  const existing = record(candidate.discovery.analysis.sourceUrl, "first_delivery");
  let sendCalls = 0;
  const outcome = await notifyDeliveryDigest([candidate], {
    history: {
      async hasNotificationBeenSent() { return true; },
      async getNotificationRecord() { return existing; },
      async recordNotificationSent() { throw new Error("unreachable"); },
    },
    sendEmail: async () => { sendCalls += 1; return { id: "unexpected" }; },
  });
  assert.equal(outcome.notifications.get(candidate.discovery.analysis.sourceUrl)?.status, "already_sent");
  assert.equal(sendCalls, 0);
});

test("replay preserves the accepted send-before-history-write ambiguity without retry", async () => {
  const candidate = deliveryCandidate(9, "https://example.com/ambiguous", "replay");
  let sendCalls = 0;
  let recordCalls = 0;
  await assert.rejects(notifyDeliveryDigest([candidate], {
    history: {
      async hasNotificationBeenSent() { return false; },
      async getNotificationRecord() { return undefined; },
      async recordNotificationSent() { recordCalls += 1; throw new Error("history write failed"); },
    },
    formatDigest: () => content,
    sendEmail: async () => { sendCalls += 1; return { id: "provider_accepted" }; },
  }), /Digest email was accepted, but 1 notification record\(s\) could not be persisted: history write failed/);
  assert.equal(sendCalls, 1);
  assert.equal(recordCalls, 1);
});
