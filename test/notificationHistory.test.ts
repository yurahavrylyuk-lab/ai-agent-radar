import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonNotificationHistory, NotificationHistoryError } from "../src/services/notificationHistory.js";
import type { NotificationChannel } from "../src/types/index.js";

const sentAt = new Date("2026-09-19T14:00:00.000Z");
const laterSentAt = new Date("2026-09-19T15:00:00.000Z");

async function withHistory(callback: (history: JsonNotificationHistory, filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ai-agent-monitor-notifications-"));
  const filePath = join(directory, "notification-history.json");
  try {
    await callback(new JsonNotificationHistory(filePath), filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a missing notification history file behaves as empty", async () => {
  await withHistory(async (history) => {
    assert.deepEqual(await history.listNotificationRecords(), []);
    assert.equal(await history.hasNotificationBeenSent("https://example.com/discovery", "email"), false);
  });
});

test("records, retrieves, and recognizes a successful email notification", async () => {
  await withHistory(async (history) => {
    const record = await history.recordNotificationSent("https://example.com/discovery", "email", "email_123", sentAt);
    assert.deepEqual(await history.getNotificationRecord("https://example.com/discovery", "email"), record);
    assert.equal(await history.hasNotificationBeenSent("https://example.com/discovery", "email"), true);
    assert.equal(record.providerMessageId, "email_123");
    assert.equal(record.sentAt, sentAt.toISOString());
  });
});

test("duplicate notification recording preserves original sentAt and provider message ID", async () => {
  await withHistory(async (history) => {
    const original = await history.recordNotificationSent("https://example.com/discovery", "email", "email_original", sentAt);
    const duplicate = await history.recordNotificationSent("https://example.com/discovery", "email", "email_later", laterSentAt);
    assert.deepEqual(duplicate, original);
    assert.equal((await history.listNotificationRecords()).length, 1);
    assert.equal(duplicate.sentAt, sentAt.toISOString());
    assert.equal(duplicate.providerMessageId, "email_original");
  });
});

test("trailing-slash and whitespace URL equivalents use the same notification identity", async () => {
  await withHistory(async (history) => {
    await history.recordNotificationSent("https://EXAMPLE.com/discovery/", "email", undefined, sentAt);
    assert.equal(await history.hasNotificationBeenSent("https://example.com/discovery/", "email"), true);
    assert.equal(await history.hasNotificationBeenSent(" https://example.com/discovery ", "email"), true);
  });
});

test("genuinely different URLs produce separate notification records", async () => {
  await withHistory(async (history) => {
    await history.recordNotificationSent("https://example.com/one", "email", undefined, sentAt);
    await history.recordNotificationSent("https://example.com/two", "email", undefined, sentAt);
    assert.equal((await history.listNotificationRecords()).length, 2);
  });
});

test("persisted notification records contain no recipient, API key, or email body fields", async () => {
  await withHistory(async (history, filePath) => {
    await history.recordNotificationSent("https://example.com/discovery", "email", "email_123", sentAt);
    const saved = JSON.parse(await readFile(filePath, "utf8")) as { records: Array<Record<string, unknown>> };
    assert.deepEqual(Object.keys(saved.records[0]).sort(), ["channel", "normalizedUrl", "providerMessageId", "sentAt"]);
  });
});

test("malformed JSON is rejected without replacing the history file", async () => {
  await withHistory(async (history, filePath) => {
    await writeFile(filePath, "{not valid JSON", "utf8");
    await assert.rejects(history.listNotificationRecords(), NotificationHistoryError);
    assert.equal(await readFile(filePath, "utf8"), "{not valid JSON");
  });
});

test("structurally invalid history and invalid records are rejected", async () => {
  await withHistory(async (history, filePath) => {
    await writeFile(filePath, JSON.stringify({ records: {} }), "utf8");
    await assert.rejects(history.listNotificationRecords(), /invalid format/);
    await writeFile(filePath, JSON.stringify({ records: [{ normalizedUrl: "https://example.com", channel: "email", sentAt: "not-a-date" }] }), "utf8");
    await assert.rejects(history.listNotificationRecords(), /invalid format/);
  });
});

test("invalid notification channels are rejected", async () => {
  await withHistory(async (history) => {
    const invalidChannel = "telegram" as NotificationChannel;
    await assert.rejects(history.recordNotificationSent("https://example.com/discovery", invalidChannel, undefined, sentAt), /channel is not supported/);
  });
});

test("listing returns all records", async () => {
  await withHistory(async (history) => {
    await history.recordNotificationSent("https://example.com/one", "email", undefined, sentAt);
    await history.recordNotificationSent("https://example.com/two", "email", "email_2", laterSentAt);
    assert.deepEqual((await history.listNotificationRecords()).map((record) => record.normalizedUrl), ["https://example.com/one", "https://example.com/two"]);
  });
});
