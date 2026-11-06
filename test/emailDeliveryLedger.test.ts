import assert from "node:assert/strict";
import test from "node:test";

import {
  deliveryIdentity,
  freezeDelivery,
  restoreDeliveryBody,
  validateDeliveryRecord,
  type DeliveryRecord,
} from "../src/services/emailDeliveryLedger.js";
import type { PreparedDailyDigest } from "../src/types/index.js";

const recipient = "owner@example.test";
const digest: PreparedDailyDigest = {
  mode: "degraded",
  reason: "ai_unavailable",
  cycleDate: "2026-11-04T00:00:00.000Z",
  items: [{
    kind: "raw",
    candidate: {
      candidateId: "candidate-1",
      normalizedUrl: "https://example.test/news/item#observed",
      aliasKey: "https://example.test/news/item",
      aliases: ["https://example.test/news/item#observed", "https://example.test/news/item"],
      source: { title: "Bounded story", url: "https://example.test/news/item#observed", snippet: "Summary" },
      provenance: [{ kind: "brave", queryOrdinal: 1, resultOrdinal: 1 }],
    },
  }],
};

test("daily identity is derived only from the scheduled UTC day", () => {
  assert.deepEqual(deliveryIdentity(new Date("2026-11-04T23:59:59.000Z")), {
    key: "daily-digest/2026-11-04",
    logicalDate: "2026-11-04",
    scheduledAt: "2026-11-04T23:59:59.000Z",
  });
  assert.throws(() => deliveryIdentity(new Date(Number.NaN)), /scheduled/i);
});

test("frozen delivery restores byte-identical canonical provider body", async () => {
  const identity = deliveryIdentity(new Date("2026-11-04T23:59:59.000Z"));
  const content = { from: "AI Radar <radar@example.test>", subject: "Daily", text: "Plain", html: "<p>Plain</p>" };
  const first = await freezeDelivery(digest, identity, content, recipient);
  const second = await freezeDelivery(digest, identity, content, recipient);

  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.equal(await restoreDeliveryBody(first, recipient), JSON.stringify({
    from: content.from, to: [recipient], subject: content.subject, text: content.text, html: content.html,
  }));
  assert.deepEqual(first.aliases, ["https://example.test/news/item", "https://example.test/news/item#observed"]);
  assert.equal(JSON.stringify(first).includes(recipient), false);
  assert.equal(JSON.stringify(first).includes("API_KEY"), false);
  await assert.rejects(() => restoreDeliveryBody(first, "changed@example.test"), /payload/i);
  await assert.rejects(() => restoreDeliveryBody({ ...first, payloadVersion: 2 as 1 }, recipient), /version/i);
});

test("freeze rejects bounded content and alias overflows without truncation", async () => {
  const identity = deliveryIdentity(new Date("2026-11-04T00:00:00.000Z"));
  await assert.doesNotReject(() => freezeDelivery(digest, identity, {
    from: "sender@example.test", subject: "s".repeat(1024), text: "t".repeat(64 * 1024), html: "h".repeat(192 * 1024),
  }, recipient));
  await assert.rejects(() => freezeDelivery(digest, identity, {
    from: "sender@example.test", subject: "x".repeat(1025), text: "ok", html: "ok",
  }, recipient), /subject/i);
  await assert.rejects(() => freezeDelivery(digest, identity, {
    from: "sender@example.test", subject: "ok", text: "x".repeat(65 * 1024), html: "ok",
  }, recipient), /text/i);
  await assert.rejects(() => freezeDelivery(digest, identity, {
    from: "sender@example.test", subject: "ok", text: "ok", html: "x".repeat(192 * 1024 + 1),
  }, recipient), /HTML/i);
  const tooMany = { ...digest, items: [...digest.items, ...digest.items, ...digest.items, ...digest.items, ...digest.items] };
  await assert.rejects(() => freezeDelivery(tooMany, identity, {
    from: "sender@example.test", subject: "ok", text: "ok", html: "ok",
  }, recipient), /items/i);
  const aliasOverflow: PreparedDailyDigest = {
    ...digest,
    items: [{ ...digest.items[0]!, candidate: {
      ...digest.items[0]!.candidate,
      normalizedUrl: `https://example.test/${"x".repeat(2040)}`,
      aliases: [`https://example.test/${"x".repeat(2040)}`],
    } }],
  };
  await assert.rejects(() => freezeDelivery(aliasOverflow, identity, {
    from: "sender@example.test", subject: "ok", text: "ok", html: "ok",
  }, recipient), /alias/i);
});

test("delivery record validation enforces frozen and terminal invariants", async () => {
  const identity = deliveryIdentity(new Date("2026-11-04T00:00:00.000Z"));
  const frozen = await freezeDelivery(digest, identity, {
    from: "sender@example.test", subject: "ok", text: "ok", html: "ok",
  }, recipient);
  const record: DeliveryRecord = {
    key: identity.key, logicalDate: identity.logicalDate, payloadSha256: frozen.payloadSha256,
    frozen, state: "prepared", createdAt: identity.scheduledAt, updatedAt: identity.scheduledAt,
    firstProviderAttemptAt: null, lastProviderAttemptAt: null, retryBefore: null,
    claim: null, leaseUntil: null, slots: [], providerMessageId: null, acceptedAt: null,
    reconciledAt: null, lastReason: "prepared",
  };
  assert.doesNotThrow(() => validateDeliveryRecord(record));
  assert.throws(() => validateDeliveryRecord({ ...record, key: "daily-digest/2026-11-05" }), /identity/i);
  assert.throws(() => validateDeliveryRecord({ ...record, state: "accepted" }), /accepted/i);
});
