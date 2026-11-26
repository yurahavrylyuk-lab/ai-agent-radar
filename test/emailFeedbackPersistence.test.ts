import assert from "node:assert/strict";
import test from "node:test";

import { D1EmailFeedbackStore, type FeedbackStoryBinding } from "../src/services/d1EmailFeedbackStore.js";
import { D1EmailDeliveryLedger } from "../src/services/d1EmailDeliveryLedger.js";
import { deliveryIdentity, freezeDelivery } from "../src/services/emailDeliveryLedger.js";
import { createEmailDeliveryDatabase, type SqliteD1 } from "./fixtures/emailDeliveryD1.js";
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

function seedDelivery(sqlite: Awaited<ReturnType<typeof createEmailDeliveryDatabase>>["sqlite"], date: string): string {
  const deliveryKey=`daily-digest/${date}`;
  sqlite.prepare(`INSERT INTO email_deliveries(delivery_key,logical_date,state,payload_sha256,created_at,updated_at,
    provider_message_id,accepted_at,reconciled_at,last_reason) VALUES(?,?,'accepted',?,?,?,?,?,?,'history_reconciled')`)
    .run(deliveryKey,date,"1".repeat(64),`${date}T08:00:00.000Z`,`${date}T08:00:00.000Z`,
      `message-${date}`,`${date}T08:01:00.000Z`,`${date}T08:02:00.000Z`);
  return deliveryKey;
}

function seedBinding(sqlite: Awaited<ReturnType<typeof createEmailDeliveryDatabase>>["sqlite"], deliveryKey: string,
  slot: number, expiresAt: string, withVote=true): void {
  sqlite.prepare(`INSERT INTO email_feedback_stories(delivery_key,slot,payload_sha256,story_sha256,discovery_key,
    display_title,kind,topic_version,topics_json,issued_at,expires_at,key_id,relevant_digest,not_relevant_digest)
    VALUES(?,?,?, ?,?,'Cleanup fixture','analyzed',1,'["ai_ml"]',?,?, 'active',?,?)`)
    .run(deliveryKey,slot,"1".repeat(64),String(slot).repeat(64),`${slot}`.repeat(64),
      "2025-01-01T08:00:00.000Z",expiresAt,"c".repeat(64),"d".repeat(64));
  if (withVote) sqlite.prepare(`INSERT INTO email_feedback_votes(delivery_key,slot,rating,revision,capability_digest,created_at,updated_at)
    VALUES(?,?,'relevant',1,?,'2025-01-02T08:00:00.000Z','2025-01-02T08:00:00.000Z')`)
    .run(deliveryKey,slot,"c".repeat(64));
}

function counts(sqlite: Awaited<ReturnType<typeof createEmailDeliveryDatabase>>["sqlite"], table: string): number {
  return Number((sqlite.prepare(`SELECT count(*) count FROM ${table}`).get() as {count:number}).count);
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

test("feedback cleanup performs one selection and no deletion batch when nothing is eligible", async () => {
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try {
    const deliveryKey=seedDelivery(sqlite,"2026-11-12");seedBinding(sqlite,deliveryKey,1,"2026-12-12T08:00:00.000Z");
    d1.resetCalls();
    assert.equal(await new D1EmailFeedbackStore(d1 as unknown as D1Database).pruneExpired("2026-11-12T00:00:00.000Z"),0);
    assert.deepEqual({all:d1.calls.all,batch:d1.calls.batch,batchStatements:d1.calls.batchStatements},{all:1,batch:0,batchStatements:[]});
  } finally {sqlite.close();}
});

test("feedback cleanup deletes one eligible group in one atomic child-first batch and preserves durable history", async () => {
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try {
    const deliveryKey=seedDelivery(sqlite,"2025-01-01");seedBinding(sqlite,deliveryKey,1,"2025-02-01T08:00:00.000Z");
    sqlite.prepare("INSERT INTO notifications(normalized_url,channel,sent_at,provider_message_id) VALUES(?,?,?,?)")
      .run("https://example.test/story","email","2025-01-01T09:00:00.000Z","notification-1");
    d1.resetCalls();
    assert.equal(await new D1EmailFeedbackStore(d1 as unknown as D1Database).pruneExpired("2026-11-12T00:00:00.000Z"),1);
    assert.deepEqual({all:d1.calls.all,batch:d1.calls.batch,batchStatements:d1.calls.batchStatements},{all:1,batch:1,batchStatements:[3]});
    assert.match(d1.calls.batchSql[0]![0]!,/DELETE FROM email_feedback_events/);
    assert.match(d1.calls.batchSql[0]![1]!,/DELETE FROM email_feedback_votes/);
    assert.match(d1.calls.batchSql[0]![2]!,/DELETE FROM email_feedback_stories/);
    assert.equal(counts(sqlite,"email_feedback_stories"),0);assert.equal(counts(sqlite,"email_feedback_votes"),0);assert.equal(counts(sqlite,"email_feedback_events"),0);
    assert.equal(counts(sqlite,"email_deliveries"),1);assert.equal(counts(sqlite,"notifications"),1);
  } finally {sqlite.close();}
});

test("feedback cleanup bounds twenty groups into one deletion batch and leaves overflow for an idempotent future pass", async () => {
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try {
    for(let day=1;day<=21;day++){const date=`2025-01-${String(day).padStart(2,"0")}`;const deliveryKey=seedDelivery(sqlite,date);seedBinding(sqlite,deliveryKey,1,"2025-02-01T08:00:00.000Z");}
    const store=new D1EmailFeedbackStore(d1 as unknown as D1Database);d1.resetCalls();
    assert.equal(await store.pruneExpired("2026-11-12T00:00:00.000Z"),20);
    assert.deepEqual({all:d1.calls.all,batch:d1.calls.batch,batchStatements:d1.calls.batchStatements},{all:1,batch:1,batchStatements:[60]});
    assert.equal(counts(sqlite,"email_feedback_stories"),1);
    d1.resetCalls();assert.equal(await store.pruneExpired("2026-11-12T00:00:00.000Z"),1);
    assert.deepEqual({all:d1.calls.all,batch:d1.calls.batch,batchStatements:d1.calls.batchStatements},{all:1,batch:1,batchStatements:[3]});
    d1.resetCalls();assert.equal(await store.pruneExpired("2026-11-12T00:00:00.000Z"),0);
    assert.deepEqual({all:d1.calls.all,batch:d1.calls.batch},{all:1,batch:0});
  } finally {sqlite.close();}
});

test("feedback cleanup preserves an entire mixed-expiration delivery group and the exact cutoff boundary", async () => {
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try {
    const mixed=seedDelivery(sqlite,"2025-01-01");seedBinding(sqlite,mixed,1,"2025-02-01T08:00:00.000Z");seedBinding(sqlite,mixed,2,"2026-12-01T08:00:00.000Z");
    const boundary=seedDelivery(sqlite,"2025-01-02");seedBinding(sqlite,boundary,1,"2026-06-15T00:00:00.000Z");
    d1.resetCalls();assert.equal(await new D1EmailFeedbackStore(d1 as unknown as D1Database).pruneExpired("2026-11-12T00:00:00.000Z"),0);
    assert.equal(counts(sqlite,"email_feedback_stories"),3);assert.equal(d1.calls.batch,0);
  } finally {sqlite.close();}
});

test("feedback cleanup rechecks group eligibility inside the deletion batch", async () => {
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try {
    const deliveryKey=seedDelivery(sqlite,"2025-01-01");seedBinding(sqlite,deliveryKey,1,"2025-02-01T08:00:00.000Z");
    const originalBatch=d1.batch.bind(d1);let inserted=false;
    d1.batch=async (statements: Parameters<SqliteD1["batch"]>[0])=>{if(!inserted){inserted=true;seedBinding(sqlite,deliveryKey,2,"2026-12-01T08:00:00.000Z",false);}return originalBatch(statements);};
    d1.resetCalls();
    assert.equal(await new D1EmailFeedbackStore(d1 as unknown as D1Database).pruneExpired("2026-11-12T00:00:00.000Z"),0);
    assert.equal(counts(sqlite,"email_feedback_stories"),2);assert.equal(counts(sqlite,"email_feedback_votes"),1);assert.equal(counts(sqlite,"email_feedback_events"),1);
  } finally {sqlite.close();}
});

test("feedback cleanup rolls back every group when a statement fails mid-batch", async () => {
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try {
    for(const date of["2025-01-01","2025-01-02"]){const deliveryKey=seedDelivery(sqlite,date);seedBinding(sqlite,deliveryKey,1,"2025-02-01T08:00:00.000Z");}
    d1.inject({pattern:/DELETE FROM email_feedback_votes/,phase:"before"});d1.resetCalls();
    await assert.rejects(new D1EmailFeedbackStore(d1 as unknown as D1Database).pruneExpired("2026-11-12T00:00:00.000Z"),/simulated D1 before failure/);
    assert.equal(d1.calls.batch,1);assert.equal(counts(sqlite,"email_feedback_stories"),2);assert.equal(counts(sqlite,"email_feedback_votes"),2);assert.equal(counts(sqlite,"email_feedback_events"),2);
  } finally {sqlite.close();}
});
