import assert from "node:assert/strict";
import test from "node:test";
import { prepareEmailFeedback } from "../src/services/emailFeedbackPreparation.js";
import { formatDailyDigestEmail } from "../src/services/discoveryEmailFormatter.js";
import { deliveryIdentity, freezeDelivery } from "../src/services/emailDeliveryLedger.js";
import { D1EmailDeliveryLedger } from "../src/services/d1EmailDeliveryLedger.js";
import { handleEmailFeedbackRoute } from "../src/services/emailFeedbackRoutes.js";
import { createDailyEmailContext, finalizeDailyDigest } from "../src/services/notificationOrchestrator.js";
import { createEmailDeliveryDatabase } from "./fixtures/emailDeliveryD1.js";
import { D1EmailFeedbackStore } from "../src/services/d1EmailFeedbackStore.js";
import { D1DiscoveryHistory } from "../src/services/d1DiscoveryHistory.js";
import { D1NotificationHistory } from "../src/services/d1NotificationHistory.js";
import { calculateFeedbackPreferenceProfile } from "../src/services/feedbackPreferences.js";
import { runBatchMonitoringCycle } from "../src/services/monitor.js";
import { analyzeBatch } from "../src/services/analysisAgent.js";
import { createGeminiBatchCycleContext } from "../src/tools/llm/gemini.js";
import type { AgentAnalysis, PreparedDailyDigest } from "../src/types/index.js";

const origin="https://feedback.example";
const keyring={active:{id:"active",secret:"a".repeat(32)}};
const identity=deliveryIdentity(new Date("2026-11-12T08:00:00.000Z"));
const digest:PreparedDailyDigest={mode:"degraded",reason:"ai_unavailable",cycleDate:identity.scheduledAt,items:[{kind:"raw",candidate:{candidateId:"r1",source:{title:"Raw <story>",url:"https://example.test/story"},normalizedUrl:"https://example.test/story",aliasKey:"https://example.test/story",aliases:[],provenance:[{kind:"rss",feedId:"github-changelog",itemOrdinal:1}]}}]};

test("actual story cards receive bounded Relevant and Not Relevant actions while status mail has none",async()=>{
  const prepared=await prepareEmailFeedback(digest,identity,{origin,keyring});
  const content=formatDailyDigestEmail(digest,prepared.actions);
  assert.match(content.text,/Relevant: https:\/\/feedback\.example\/feedback\?token=/);
  assert.match(content.text,/Not Relevant:/);
  assert.match(content.html,/Raw &lt;story&gt;/);
  const status=formatDailyDigestEmail({mode:"status_only",reason:"no_eligible_stories",cycleDate:identity.scheduledAt,items:[]},prepared.actions);
  assert.doesNotMatch(status.text,/feedback\?token=/);
  assert.equal(prepared.bindings[0]?.topics.length,0);
});

test("complete feedback delivery configuration freezes signed actions and recovery reuses the accepted payload",async()=>{
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  try{
    const ledger=new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    let sends=0;
    let sentBody="";
    const first=await finalizeDailyDigest(digest,{
      context:createDailyEmailContext(),identity,ledger,recipient:"owner@example.test",sender:"AI Radar <radar@example.test>",
      feedback:{origin,keyring},
      sendFrozen:async body=>{sends+=1;sentBody=body;return{kind:"accepted",id:"feedback-config-fixture"};},
    });
    assert.equal(first.emailOutcome,"accepted");
    assert.match(sentBody,/https:\/\/feedback\.example\/feedback\?token=/);
    assert.equal(sqlite.prepare("SELECT count(*) count FROM email_feedback_stories").get()?.count,1);

    const recovered=await finalizeDailyDigest(digest,{
      context:createDailyEmailContext(),identity,ledger,recipient:"owner@example.test",sender:"AI Radar <radar@example.test>",
      feedback:{origin,keyring:{active:{id:"new",secret:"n".repeat(32)},retiring:keyring.active}},
      sendFrozen:async()=>{sends+=1;return{kind:"accepted",id:"unexpected"};},
    });
    assert.equal(recovered.emailAttempts,0);
    assert.equal(recovered.emailOutcome,"accepted");
    assert.equal(sends,1);
  }finally{sqlite.close();}
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
    body.set("token", `x${token}`);
    const invalidPost = (at: Date) => handleEmailFeedbackRoute(new Request(`${origin}/feedback/confirm`, {
      method:"POST", headers:{origin}, body,
    }),d1 as unknown as D1Database,{origin,keyring},at);
    assert.equal((await invalidPost(new Date(identity.scheduledAt)))?.status,400);
    body.set("token", token);
    assert.equal((await invalidPost(new Date("2026-12-13T08:00:00.000Z")))?.status,410);
    assert.deepEqual(sqlite.prepare("SELECT rating,revision FROM email_feedback_votes").all(),[{rating:"not_relevant",revision:2}]);
    const head=await handleEmailFeedbackRoute(new Request(prepared.actions[0]!.relevantUrl,{method:"HEAD"}),d1 as unknown as D1Database,{origin,keyring},new Date(identity.scheduledAt));
    assert.equal(head?.status,200); assert.equal(await head!.text(),"");
  }finally{sqlite.close();}
});

test("feedback on delivered articles reaches the next synthetic Gemini batch once",async()=>{
  const {sqlite,d1}=await createEmailDeliveryDatabase(true);
  const db=d1 as unknown as D1Database;
  const ledger=new D1EmailDeliveryLedger(db);
  const feedback={origin,keyring};
  const store=new D1EmailFeedbackStore(db);
  const article=(index:number):AgentAnalysis=>({
    name:`Gemini model ${index}`,category:"major_update",sourceTitle:`Gemini model ${index}`,
    sourceUrl:`https://example.test/models/${index}`,relevanceScore:8,summary:"Model release",
    whyItMatters:"New model",educationalValue:"Learn ML",technologies:[],projectOpportunities:[],
  });
  try{
    for(const day of [0,1]){
      const previous=deliveryIdentity(new Date(`2026-11-${12+day}T08:00:00.000Z`));
      const items=Array.from({length:day===0?4:2},(_,index)=>{
        const analysis=article(day*4+index);
        return {kind:"analyzed" as const,candidate:{origin:"fresh" as const,aliases:[],discovery:{
          normalizedUrl:analysis.sourceUrl,firstSeenAt:previous.scheduledAt,lastSeenAt:previous.scheduledAt,analysis,
        }}};
      });
      let text="";
      const result=await finalizeDailyDigest({
        mode:"normal",reason:"selected",cycleDate:previous.scheduledAt,items,
      },{
        context:createDailyEmailContext(),identity:previous,ledger,recipient:"owner@example.test",sender:"radar@example.test",feedback,
        sendFrozen:async body=>{text=JSON.parse(body).text;return {kind:"accepted",id:`fixture-${day}`};},
      });
      assert.equal(result.emailOutcome,"accepted");
      const links=[...text.matchAll(/^Relevant: (https:\/\/\S+)$/gm)].map(match=>match[1]!);
      assert.equal(new Set(links).size,items.length);
      const voteAt=new Date(previous.scheduledAt);
      for(const link of links){
        const get=await handleEmailFeedbackRoute(new Request(link),db,feedback,voteAt);
        assert.equal(get?.status,200);
        const nonce=(await get!.text()).match(/name="nonce" value="([^"]+)"/)?.[1];
        assert.ok(nonce);
        const token=new URL(link).searchParams.get("token")!;
        const post=await handleEmailFeedbackRoute(new Request(`${origin}/feedback/confirm`,{
          method:"POST",headers:{origin},body:new URLSearchParams({token,nonce,rating:"relevant",revision:"0"}),
        }),db,feedback,voteAt);
        assert.equal(post?.status,200);
      }
    }
    const next=deliveryIdentity(new Date("2026-11-14T08:00:00.000Z"));
    let loads=0,dispatches=0,sends=0;
    const nextArticle=article(7);
    const history=new D1DiscoveryHistory(db);
    const notification=new D1NotificationHistory(db);
    const result=await runBatchMonitoringCycle({
      history,notification:{history:notification},now:()=>new Date(next.scheduledAt),
      geminiCycleContext:createGeminiBatchCycleContext(),
      searchPage:async()=>({rawCount:1,positions:[{resultOrdinal:1,result:{title:nextArticle.sourceTitle,url:nextArticle.sourceUrl}}]}),
      collectRss:async()=>({observations:[],metrics:{status:"disabled",configuredFeeds:0,attemptedFeeds:0,succeededFeeds:0,failedFeeds:0,
        observedPositions:0,validCandidates:0,rejectedItems:0,itemLimitTruncations:0,outcomes:[]}}),
      geminiPreflight:async()=>({allowed:true,counts:{dailyRequests:0,weeklyRequests:0,monthlyRequests:0,dailyTokens:0,weeklyTokens:0,monthlyTokens:0},
        limits:{dailyRequests:1,weeklyRequests:7,monthlyRequests:30,dailyTokens:10000,weeklyTokens:70000,monthlyTokens:300000}}),
      dailyDelivery:{context:createDailyEmailContext(),identity:next,ledger,recipient:"owner@example.test",sender:"radar@example.test",feedback,
        loadPreferenceProfile:async()=>{loads++;return calculateFeedbackPreferenceProfile(await store.loadPreferenceObservations(next.scheduledAt));},
        sendFrozen:async body=>{sends++;assert.match(JSON.parse(body).text,/Not Relevant:/);return {kind:"accepted",id:"next-fixture"};}},
      analyze:batch=>analyzeBatch(batch,{generate:async prompt=>{
        dispatches++;
        assert.equal(loads,1);
        assert.match(prompt,/Use feedback only to break relevance ties/);
        const input=JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n")+2));
        assert.deepEqual(input.feedbackPreferences,{prefer:["AI and machine learning"],deprioritize:[]});
        assert.ok(Buffer.byteLength(prompt)<=12288);
        const {sourceTitle:_title,sourceUrl:_url,...story}=nextArticle;
        return {outputText:JSON.stringify({schemaVersion:1,stories:[{...story,candidateId:batch.candidates[0]!.candidateId}]})};
      }}),
    });
    assert.equal(result.batch?.status,"validated");
    assert.equal(result.delivery?.deliveryMode,"normal");
    assert.equal(result.delivery?.emailOutcome,"accepted");
    assert.deepEqual({loads,dispatches,sends},{loads:1,dispatches:1,sends:1});
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
