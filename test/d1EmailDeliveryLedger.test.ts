import assert from "node:assert/strict";
import test from "node:test";

import { D1EmailDeliveryLedger } from "../src/services/d1EmailDeliveryLedger.js";
import { deliveryIdentity, freezeDelivery } from "../src/services/emailDeliveryLedger.js";
import { createEmailDeliveryDatabase } from "./fixtures/emailDeliveryD1.js";
import type { PreparedDailyDigest } from "../src/types/index.js";

const digest: PreparedDailyDigest = { mode: "status_only", reason: "no_eligible_stories", cycleDate: "2026-11-04T00:00:00.000Z", items: [] };
async function frozen(subject = "Daily") {
  return freezeDelivery(digest, deliveryIdentity(new Date("2026-11-04T08:00:00.000Z")), {
    from: "AI Radar <radar@example.test>", subject, text: "Status", html: "<p>Status</p>",
  }, "owner@example.test");
}

test("same-day concurrent reservations preserve one authoritative payload", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    const [left, right] = await Promise.all([ledger.reserve(await frozen("Winner")), ledger.reserve(await frozen("Conflict"))]);
    const record = await ledger.read("daily-digest/2026-11-04");
    assert.equal(record?.payloadSha256, left.kind === "committed" ? (await frozen("Winner")).payloadSha256 : (await frozen("Conflict")).payloadSha256);
    assert.equal([left, right].filter(result => result.kind === "committed").length, 1);
    assert.equal([left, right].filter(result => result.kind === "superseded").length, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM email_deliveries").get()?.count, 1);
  } finally { sqlite.close(); }
});

test("claim is fenced and does not start the provider clock or consume a slot", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    await ledger.reserve(await frozen());
    const first = await ledger.claim("daily-digest/2026-11-04", "token-a");
    const second = await ledger.claim("daily-digest/2026-11-04", "token-b");
    assert.equal(first.kind, "committed");
    assert.equal(second.kind, "blocked");
    const record = await ledger.read("daily-digest/2026-11-04");
    assert.equal(record?.claim?.token, "token-a");
    assert.equal(record?.firstProviderAttemptAt, null);
    assert.deepEqual(record?.slots, []);
  } finally { sqlite.close(); }
});

test("lost reservation response is reconciled by authoritative primary read", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    d1.inject({ pattern: /^INSERT INTO email_deliveries/, phase: "after" });
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    const value = await frozen();
    const result = await ledger.reserve(value);
    assert.equal(result.kind, "committed");
    assert.equal((await ledger.read(value.identity.key))?.payloadSha256, value.payloadSha256);
  } finally { sqlite.close(); }
});

test("lost claim response preserves the exact durable claimant without starting dispatch", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    await ledger.reserve(await frozen());
    d1.inject({ pattern: /^UPDATE email_deliveries SET\s+state='attempting'/, phase: "after" });
    const result = await ledger.claim("daily-digest/2026-11-04", "lost-response-token");
    assert.equal(result.kind, "committed");
    const record = await ledger.read("daily-digest/2026-11-04");
    assert.equal(record?.claim?.token, "lost-response-token");
    assert.equal(record?.claim?.generation, 1);
    assert.equal(record?.firstProviderAttemptAt, null);
    assert.equal(record?.slots.length, 0);
  } finally { sqlite.close(); }
});

test("an expired no-dispatch claim can be reclaimed but a live claim cannot", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    await ledger.reserve(await frozen());
    assert.equal((await ledger.claim("daily-digest/2026-11-04", "owner-a")).kind, "committed");
    assert.equal((await ledger.claim("daily-digest/2026-11-04", "owner-b")).kind, "blocked");
    sqlite.prepare("UPDATE email_deliveries SET lease_until='2020-01-01T00:00:00.000Z' WHERE delivery_key=?")
      .run("daily-digest/2026-11-04");
    const reclaimed = await ledger.claim("daily-digest/2026-11-04", "owner-b");
    assert.equal(reclaimed.kind, "committed");
    if (reclaimed.kind === "committed") assert.equal(reclaimed.record.claim?.generation, 2);
  } finally { sqlite.close(); }
});

test("unresolved mutation plus unreadable authoritative state fails closed", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    d1.inject({ pattern: /^INSERT INTO email_deliveries/, phase: "before", remaining: 2 });
    d1.inject({ pattern: /^SELECT .* FROM email_deliveries/s, phase: "read", remaining: 2 });
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    await assert.rejects(ledger.reserve(await frozen()), /unavailable/i);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM email_deliveries").get()?.count, 0);
  } finally { sqlite.close(); }
});

test("dispatch admission starts the immutable 23-hour clock and is idempotent per token", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    await ledger.reserve(await frozen());
    const claimed = await ledger.claim("daily-digest/2026-11-04", "dispatch-1");
    assert.equal(claimed.kind, "committed");
    if (claimed.kind !== "committed" || !claimed.record.claim) return;
    const admitted = await ledger.admitDispatch(claimed.record.claim);
    assert.equal(admitted.kind, "committed");
    const repeated = await ledger.admitDispatch(claimed.record.claim);
    assert.equal(repeated.kind, "committed");
    const record = await ledger.read("daily-digest/2026-11-04");
    assert.equal(record?.slots.length, 1);
    assert.equal(record?.slots[0]?.token, "dispatch-1");
    assert.equal(record?.slots[0]?.evidence, "uncertain");
    assert.equal(new Date(record!.retryBefore!).getTime() - new Date(record!.firstProviderAttemptAt!).getTime(), 23 * 60 * 60 * 1000);
    assert.notEqual(record?.firstProviderAttemptAt, record?.frozen?.identity.scheduledAt);
    const verified = await ledger.verifyDispatch(claimed.record.claim);
    assert.equal(verified.record.slots.length, 1);
    assert.ok(new Date(verified.databaseNow).getTime() >= new Date(record!.firstProviderAttemptAt!).getTime());
  } finally { sqlite.close(); }
});

test("proven pre-fetch cancellation refunds only the live owner's sole slot and clock", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    await ledger.reserve(await frozen());
    const claimed = await ledger.claim("daily-digest/2026-11-04", "cancel-1");
    if (claimed.kind !== "committed" || !claimed.record.claim) return;
    await ledger.admitDispatch(claimed.record.claim);
    const cancelled = await ledger.cancelUndispatched(claimed.record.claim);
    assert.equal(cancelled.kind, "committed");
    const record = await ledger.read("daily-digest/2026-11-04");
    assert.equal(record?.state, "prepared");
    assert.equal(record?.claim, null);
    assert.deepEqual(record?.slots, []);
    assert.equal(record?.firstProviderAttemptAt, null);
    assert.equal(record?.retryBefore, null);
    assert.equal((await ledger.cancelUndispatched(claimed.record.claim)).kind, "blocked");
  } finally { sqlite.close(); }
});

test("lost dispatch-admission response retains one uncertain capacity slot", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    await ledger.reserve(await frozen());
    const claimed = await ledger.claim("daily-digest/2026-11-04", "lost-intent");
    if (claimed.kind !== "committed" || !claimed.record.claim) return;
    d1.inject({ pattern: /^UPDATE email_deliveries SET\s+dispatch_evidence_json/, phase: "after" });
    const admitted = await ledger.admitDispatch(claimed.record.claim);
    assert.equal(admitted.kind, "committed");
    assert.equal((await ledger.read("daily-digest/2026-11-04"))?.slots.length, 1);
  } finally { sqlite.close(); }
});
