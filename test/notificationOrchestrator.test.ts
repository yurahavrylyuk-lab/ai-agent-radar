import assert from "node:assert/strict";
import test from "node:test";
import { notifyDiscovery } from "../src/services/notificationOrchestrator.js";
import type { DiscoveryEmailContent, DiscoveryProcessingResult, NotificationRecord } from "../src/types/index.js";
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
