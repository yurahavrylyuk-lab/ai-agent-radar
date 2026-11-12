import assert from "node:assert/strict";
import test from "node:test";

import { D1EmailFeedbackStore, type FeedbackStoryBinding } from "../src/services/d1EmailFeedbackStore.js";
import { D1EmailDeliveryLedger } from "../src/services/d1EmailDeliveryLedger.js";
import { deliveryIdentity, freezeDelivery } from "../src/services/emailDeliveryLedger.js";
import { createEmailDeliveryDatabase } from "./fixtures/emailDeliveryD1.js";
import type { PreparedDailyDigest } from "../src/types/index.js";

const key = "daily-digest/2026-11-12" as const;
const binding: FeedbackStoryBinding = {
  deliveryKey: key, slot: 1, payloadSha256: "", storySha256: "a".repeat(64), discoveryKey: "b".repeat(64),
  displayTitle: "A bounded story", kind: "analyzed", topics: ["ai_ml"],
  issuedAt: "2026-11-12T08:00:00.000Z", expiresAt: "2026-12-12T08:00:00.000Z", keyId: "active",
  relevantDigest: "c".repeat(64), notRelevantDigest: "d".repeat(64),
};

async function setup() {
  const fixture = await createEmailDeliveryDatabase(true);
  const ledger = new D1EmailDeliveryLedger(fixture.d1 as unknown as D1Database);
  const digest: PreparedDailyDigest = { mode: "normal", reason: "selected", cycleDate: "2026-11-12T00:00:00.000Z", items: [] };
  const frozen = await freezeDelivery(digest, deliveryIdentity(new Date("2026-11-12T08:00:00.000Z")),
    { from: "AI Radar <radar@example.test>", subject: "Daily", text: "Story", html: "<p>Story</p>" }, "owner@example.test");
  const story = { ...binding, payloadSha256: frozen.payloadSha256 };
  return { ...fixture, ledger, frozen, story, store: new D1EmailFeedbackStore(fixture.d1 as unknown as D1Database) };
}

test("ledger and exact feedback binding set reserve atomically", async () => {
  const { sqlite, ledger, frozen, story, store } = await setup();
  try {
    assert.equal((await ledger.reserveWithBindings(frozen, [story])).kind, "committed");
    assert.deepEqual(await store.readBinding(key, 1), story);
    await assert.rejects(ledger.reserveWithBindings(frozen, [{ ...story, storySha256: "e".repeat(64) }]));
    assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_stories").get()?.count, 1);
  } finally { sqlite.close(); }
});

test("accepted exact binding supports idempotent vote and revision CAS with inseparable audit", async () => {
  const { sqlite, ledger, frozen, story, store } = await setup();
  try {
    await ledger.reserveWithBindings(frozen, [story]);
    const claimed=await ledger.claim(key,"vote-fixture");
    assert.equal(claimed.kind,"committed");
    if (claimed.kind!=="committed" || !claimed.record.claim) throw new Error("claim missing");
    await ledger.admitDispatch(claimed.record.claim);
    await ledger.recordOutcome(claimed.record.claim,frozen.payloadSha256,{kind:"accepted",id:"m1"});
    const first = await store.recordVote({ deliveryKey: key, slot: 1, payloadSha256: frozen.payloadSha256,
      storySha256: story.storySha256, rating: "relevant", capabilityDigest: story.relevantDigest, expectedRevision: 0,
      now: "2026-11-12T09:00:00.000Z" });
    assert.equal(first.kind, "recorded");
    assert.equal((await store.recordVote({ deliveryKey: key, slot: 1, payloadSha256: frozen.payloadSha256,
      storySha256: story.storySha256, rating: "relevant", capabilityDigest: story.relevantDigest, expectedRevision: 0,
      now: "2026-11-12T09:01:00.000Z" })).kind, "already_recorded");
    assert.equal((await store.recordVote({ deliveryKey: key, slot: 1, payloadSha256: frozen.payloadSha256,
      storySha256: story.storySha256, rating: "not_relevant", capabilityDigest: story.notRelevantDigest, expectedRevision: 0,
      now: "2026-11-12T09:02:00.000Z" })).kind, "conflict");
    assert.equal((await store.recordVote({ deliveryKey: key, slot: 1, payloadSha256: frozen.payloadSha256,
      storySha256: story.storySha256, rating: "not_relevant", capabilityDigest: story.notRelevantDigest, expectedRevision: 1,
      now: "2026-11-12T09:03:00.000Z" })).kind, "recorded");
    assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_events").get()?.count, 2);
    assert.deepEqual(sqlite.prepare("SELECT rating,revision FROM email_feedback_votes").get(), { rating: "not_relevant", revision: 2 });
    let rating:"relevant"|"not_relevant"="not_relevant";
    for(let revision=2;revision<10;revision++){
      rating=rating==="relevant"?"not_relevant":"relevant";
      assert.equal((await store.recordVote({deliveryKey:key,slot:1,payloadSha256:frozen.payloadSha256,storySha256:story.storySha256,
        rating,capabilityDigest:rating==="relevant"?story.relevantDigest:story.notRelevantDigest,expectedRevision:revision,now:`2026-11-12T09:${String(revision+2).padStart(2,"0")}:00.000Z`})).kind,"recorded");
    }
    const blockedRating=rating==="relevant"?"not_relevant":"relevant";
    assert.equal((await store.recordVote({deliveryKey:key,slot:1,payloadSha256:frozen.payloadSha256,storySha256:story.storySha256,
      rating:blockedRating,capabilityDigest:blockedRating==="relevant"?story.relevantDigest:story.notRelevantDigest,expectedRevision:10,now:"2026-11-12T09:20:00.000Z"})).kind,"conflict");
    assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_events").get()?.count,10);
  } finally { sqlite.close(); }
});

test("pending delivery, mismatched identity, and more than four bindings fail closed", async () => {
  const { sqlite, ledger, frozen, story, store } = await setup();
  try {
    await assert.rejects(ledger.reserveWithBindings(frozen, [1,2,3,4,5].map((slot) => ({ ...story, slot: slot as 1 }))));
    await ledger.reserveWithBindings(frozen, [story]);
    assert.equal((await store.recordVote({ deliveryKey: key, slot: 1, payloadSha256: "f".repeat(64),
      storySha256: story.storySha256, rating: "relevant", capabilityDigest: story.relevantDigest, expectedRevision: 0,
      now: "2026-11-12T09:00:00.000Z" })).kind, "blocked");
  } finally { sqlite.close(); }
});

test("bounded retention removes feedback children only and preserves ledger", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase(true);
  try {
    const ledger=new D1EmailDeliveryLedger(d1 as unknown as D1Database),store=new D1EmailFeedbackStore(d1 as unknown as D1Database);
    const oldIdentity=deliveryIdentity(new Date("2025-11-01T08:00:00.000Z"));
    const oldDigest:PreparedDailyDigest={mode:"status_only",reason:"no_eligible_stories",cycleDate:oldIdentity.scheduledAt,items:[]};
    const oldFrozen=await freezeDelivery(oldDigest,oldIdentity,{from:"x",subject:"s",text:"t",html:"<p>h</p>"},"owner@example.test");
    const oldStory={...binding,deliveryKey:oldIdentity.key,payloadSha256:oldFrozen.payloadSha256,issuedAt:oldIdentity.scheduledAt,expiresAt:"2025-12-01T08:00:00.000Z"};
    await ledger.reserveWithBindings(oldFrozen,[oldStory]);const claim=await ledger.claim(oldIdentity.key,"old");if(claim.kind!=="committed"||!claim.record.claim)throw new Error();
    await ledger.admitDispatch(claim.record.claim);await ledger.recordOutcome(claim.record.claim,oldFrozen.payloadSha256,{kind:"accepted",id:"old-email"});
    assert.equal((await store.recordVote({deliveryKey:oldIdentity.key,slot:1,payloadSha256:oldFrozen.payloadSha256,storySha256:oldStory.storySha256,rating:"relevant",capabilityDigest:oldStory.relevantDigest,expectedRevision:0,now:"2025-11-01T09:00:00.000Z"})).kind,"recorded");
    assert.equal(await store.pruneExpired("2026-11-12T00:00:00.000Z"), 1);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_stories").get()?.count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_events").get()?.count, 0);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM email_deliveries").get()?.count, 1);
  } finally { sqlite.close(); }
});
