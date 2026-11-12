import assert from "node:assert/strict";
import test from "node:test";
import { prepareEmailFeedback } from "../src/services/emailFeedbackPreparation.js";
import { formatDailyDigestEmail } from "../src/services/discoveryEmailFormatter.js";
import { deliveryIdentity, freezeDelivery } from "../src/services/emailDeliveryLedger.js";
import { D1EmailDeliveryLedger } from "../src/services/d1EmailDeliveryLedger.js";
import { handleEmailFeedbackRoute } from "../src/services/emailFeedbackRoutes.js";
import { createEmailDeliveryDatabase } from "./fixtures/emailDeliveryD1.js";
import type { PreparedDailyDigest } from "../src/types/index.js";

const origin="https://feedback.example";
const keyring={active:{id:"active",secret:"a".repeat(32)}};
const identity=deliveryIdentity(new Date("2026-11-12T08:00:00.000Z"));
const digest:PreparedDailyDigest={mode:"degraded",reason:"ai_unavailable",cycleDate:identity.scheduledAt,items:[{kind:"raw",candidate:{candidateId:"r1",source:{title:"Raw <story>",url:"https://example.test/story"},normalizedUrl:"https://example.test/story",aliasKey:"https://example.test/story",aliases:[],provenance:[{kind:"rss",feedId:"github-changelog",itemOrdinal:1}]}}]};

test("actual story cards receive bounded Relevant and Not relevant actions while status mail has none",async()=>{
  const prepared=await prepareEmailFeedback(digest,identity,{origin,keyring});
  const content=formatDailyDigestEmail(digest,prepared.actions);
  assert.match(content.text,/Relevant: https:\/\/feedback\.example\/feedback\?token=/);
  assert.match(content.text,/Not relevant:/);
  assert.match(content.html,/Raw &lt;story&gt;/);
  const status=formatDailyDigestEmail({mode:"status_only",reason:"no_eligible_stories",cycleDate:identity.scheduledAt,items:[]},prepared.actions);
  assert.doesNotMatch(status.text,/feedback\?token=/);
  assert.equal(prepared.bindings[0]?.topics.length,0);
});

test("GET and HEAD are read-only while exact-origin POST records once",async()=>{
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try{
    const prepared=await prepareEmailFeedback(digest,identity,{origin,keyring});
    const content=formatDailyDigestEmail(digest,prepared.actions);
    const frozen=await freezeDelivery(digest,identity,{...content,from:"AI Radar <radar@example.test>"},"owner@example.test");
    const ledger=new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    await ledger.reserveWithBindings(frozen,prepared.bindings.map(value=>({...value,payloadSha256:frozen.payloadSha256})));
    const claim=await ledger.claim(identity.key,"send"); if(claim.kind!=="committed"||!claim.record.claim)throw new Error();
    await ledger.admitDispatch(claim.record.claim); await ledger.recordOutcome(claim.record.claim,frozen.payloadSha256,{kind:"accepted",id:"m1"});
    const token=new URL(prepared.actions[0]!.relevantUrl).searchParams.get("token")!;
    const get=await handleEmailFeedbackRoute(new Request(prepared.actions[0]!.relevantUrl),d1 as unknown as D1Database,{origin,keyring},new Date(identity.scheduledAt));
    assert.equal(get?.status,200); assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_votes").get()?.count,0);
    const html=await get!.text(); const nonce=html.match(/name="nonce" value="([^"]+)"/)?.[1]; assert.ok(nonce);
    const body=new URLSearchParams({token,nonce:nonce!,rating:"relevant",revision:"0"});
    const post=await handleEmailFeedbackRoute(new Request(`${origin}/feedback/confirm`,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body}),d1 as unknown as D1Database,{origin,keyring},new Date(identity.scheduledAt));
    assert.equal(post?.status,200); assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_votes").get()?.count,1);
    const repeated=await handleEmailFeedbackRoute(new Request(`${origin}/feedback/confirm`,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token,nonce:nonce!,rating:"relevant",revision:"0"})}),d1 as unknown as D1Database,{origin,keyring},new Date(identity.scheduledAt));
    assert.equal(repeated?.status,200);assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_events").get()?.count,1);
    const negativeUrl=prepared.actions[0]!.notRelevantUrl,negativeToken=new URL(negativeUrl).searchParams.get("token")!;
    const negativeGet=await handleEmailFeedbackRoute(new Request(negativeUrl),d1 as unknown as D1Database,{origin,keyring},new Date(identity.scheduledAt));
    const negativeHtml=await negativeGet!.text(),negativeNonce=negativeHtml.match(/name="nonce" value="([^"]+)"/)?.[1];assert.ok(negativeNonce);
    const changed=await handleEmailFeedbackRoute(new Request(`${origin}/feedback/confirm`,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:negativeToken,nonce:negativeNonce!,rating:"not_relevant",revision:"1"})}),d1 as unknown as D1Database,{origin,keyring},new Date(identity.scheduledAt));
    assert.equal(changed?.status,200);assert.deepEqual(sqlite.prepare("SELECT rating,revision FROM email_feedback_votes").get(),{rating:"not_relevant",revision:2});
    const stale=await handleEmailFeedbackRoute(new Request(`${origin}/feedback/confirm`,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token,nonce:nonce!,rating:"relevant",revision:"0"})}),d1 as unknown as D1Database,{origin,keyring},new Date(identity.scheduledAt));
    assert.equal(stale?.status,409);
    const head=await handleEmailFeedbackRoute(new Request(prepared.actions[0]!.relevantUrl,{method:"HEAD"}),d1 as unknown as D1Database,{origin,keyring},new Date(identity.scheduledAt));
    assert.equal(head?.status,200); assert.equal(await head!.text(),"");
  }finally{sqlite.close();}
});

test("missing or cross-origin POST and scanner GET never mutate",async()=>{
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try{
    const response=await handleEmailFeedbackRoute(new Request(`${origin}/feedback/confirm`,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:"token=x&nonce=y&rating=relevant&revision=0"}),d1 as unknown as D1Database,{origin,keyring});
    assert.equal(response?.status,400); assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_votes").get()?.count,0);
  }finally{sqlite.close();}
});

test("oversized and stalled POST bodies fail within the bounded reader without mutation",async()=>{
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try{
    const oversized=await handleEmailFeedbackRoute(new Request(`${origin}/feedback/confirm`,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:"x".repeat(4097)}),d1 as unknown as D1Database,{origin,keyring});
    assert.equal(oversized?.status,400);
    const stalled=new ReadableStream<Uint8Array>({start(){},cancel(){return Promise.reject(new Error("ignored cancellation"));}});
    const started=Date.now();
    const bounded=await handleEmailFeedbackRoute(new Request(`${origin}/feedback/confirm`,{method:"POST",headers:{origin,"content-type":"application/x-www-form-urlencoded"},body:stalled,duplex:"half"} as RequestInit),d1 as unknown as D1Database,{origin,keyring});
    assert.equal(bounded?.status,400);assert.ok(Date.now()-started>=4_900&&Date.now()-started<5_800);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_votes").get()?.count,0);
  }finally{sqlite.close();}
});
