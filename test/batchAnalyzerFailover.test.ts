import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBatchWithFailover, lunaTimingAllowed, type FailoverConsumed } from "../src/services/batchAnalyzerFailover.js";
import type { D1OpenAIFallbackUsageStore, LunaReservation } from "../src/services/d1OpenAIFallbackUsageStore.js";
import type { GeminiBatchCycleContext } from "../src/tools/llm/gemini.js";
import type { PreparedBatch } from "../src/types/index.js";

const candidate={candidateId:"c001",source:{title:"Title",url:"https://example.com/story"},normalizedUrl:"https://example.com/story",aliasKey:"https://example.com/story",aliases:["https://example.com/story"],provenance:[{kind:"brave" as const,queryOrdinal:1,resultOrdinal:1}]};
const batch:PreparedBatch={prompt:"prompt",candidates:[candidate],promptBytes:6,sizeExcluded:0,truncationStage:"initial",snippetBytesLimit:192};
const output=JSON.stringify({schemaVersion:1,stories:[{candidateId:"c001",relevanceScore:8,category:"major_update",name:"Name",summary:"Summary",whyItMatters:"Why",educationalValue:"Learn",technologies:[],projectOpportunities:[]}]});
const ref:LunaReservation={cycleId:"a233dc6e-e951-4c7e-8f24-6cc7a91979f8",attemptId:"b233dc6e-e951-4c7e-8f24-6cc7a91979f8",scheduledAt:"2026-10-24T08:00:00.000Z",reservedAt:"2026-10-24T08:01:00.000Z"};
const limits={dailyRequests:1,weeklyRequests:7,monthlyRequests:31,dailyTokens:24576,weeklyTokens:172032,monthlyTokens:761856};
function context(patch:Partial<GeminiBatchCycleContext>={}):GeminiBatchCycleContext{return {batchStarted:true,dispatchBlockedByTimeout:false,providerAttempts:3,fallbacks:0,analysesUsingFallbackModel:0,requestsByModel:{"gemini-3.8-flash":3,"gemini-3.6-flash":0,"gemini-3.5-flash-lite":0},reservationAttempts:3,reservations:3,providerDispatches:3,retryEligible:true,retryAttempted:true,retrySkipReason:"exhausted",attemptTimings:[],deadlineStartedAtMonotonic:0,attempts:[1,2,3].map(ordinal=>({ordinal:ordinal as 1|2|3,failureClass:"unavailable_503",providerFailureClass:"unavailable_503",httpStatus:503,accountingOutcome:"confirmed_zero",elapsedMs:1})),...patch};}
function store(events:string[]){return {reserve:async()=>{events.push("reserve");return ref;},markIntent:async()=>{events.push("intent");},markObserved:async()=>{events.push("observed");},settleExact:async()=>{events.push("settle");},markUnknown:async()=>{events.push("unknown");},cancelBeforeDispatch:async()=>{events.push("cancel");}} as unknown as D1OpenAIFallbackUsageStore;}

test("timing gate accepts exact boundary and rejects one millisecond below or missing Gemini start",()=>{
  assert.equal(lunaTimingAllowed(60_000,0, -20_000),true);
  assert.equal(lunaTimingAllowed(60_001,0,-20_000),false);
  assert.equal(lunaTimingAllowed(1,undefined,0),false);
});

test("exact three durable reviewed Gemini failures permit one Luna analysis in strict order",async()=>{
  const events:string[]=[]; const consumed:FailoverConsumed={consumed:false}; let calls=0;
  const result=await analyzeBatchWithFailover(batch,{primary:async()=>{throw new Error("Gemini unavailable");},geminiContext:context(),cycleId:ref.cycleId,cycleStartedAtMonotonic:-20_000,monotonicNow:()=>60_000,store:store(events),limits,apiKey:"key",consumed,
    requestLuna:async()=>{events.push("fetch");calls++;return {outcome:"success",outputText:output,usage:{inputTokens:1,outputTokens:2,totalTokens:3},httpStatus:200,durationMs:5};}});
  assert.equal(result.selections.length,1); assert.equal(calls,1); assert.deepEqual(events,["reserve","intent","observed","fetch","settle"]); assert.equal(consumed.consumed,true);
});

test("success and every non-eligible Gemini terminal state perform zero Luna dispatches",async(t)=>{
  const success={returnedCount:0,selections:[]}; let calls=0;
  assert.equal(await analyzeBatchWithFailover(batch,{primary:async()=>success,geminiContext:context(),cycleId:ref.cycleId,cycleStartedAtMonotonic:0,monotonicNow:()=>1,store:store([]),limits,apiKey:"key",consumed:{consumed:false},requestLuna:async()=>{calls++;throw new Error();}}),success);
  for(const [name,patch] of [
    ["timeout",{dispatchBlockedByTimeout:true}], ["429",{attempts:context().attempts.map(value=>({...value,failureClass:"resource_exhausted_429" as const,providerFailureClass:"resource_exhausted_429" as const}))}],
    ["fewer",{attempts:context().attempts.slice(0,2)}], ["quota",{retrySkipReason:"admission" as const}], ["missing timing",{deadlineStartedAtMonotonic:undefined}],
  ] as const)await t.test(name,async()=>{const original=new Error(name);await assert.rejects(analyzeBatchWithFailover(batch,{primary:async()=>{throw original;},geminiContext:context(patch),cycleId:ref.cycleId,cycleStartedAtMonotonic:0,monotonicNow:()=>1,store:store([]),limits,apiKey:"key",consumed:{consumed:false},requestLuna:async()=>{calls++;throw new Error();}}),error=>error===original);});
  assert.equal(calls,0);
});

test("transport uncertainty is durably unknown and never retries Luna",async()=>{
  const events:string[]=[];let calls=0;const original=new Error("primary");
  await assert.rejects(analyzeBatchWithFailover(batch,{primary:async()=>{throw original;},geminiContext:context(),cycleId:ref.cycleId,cycleStartedAtMonotonic:-20_000,monotonicNow:()=>60_000,store:store(events),limits,apiKey:"key",consumed:{consumed:false},requestLuna:async()=>{calls++;return {outcome:"timeout",usage:null,httpStatus:null,durationMs:15000};}}));
  assert.equal(calls,1);assert.deepEqual(events,["reserve","intent","observed","unknown"]);
});

test("a consumed or denied durable reservation never dispatches",async()=>{
  let calls=0;const original=new Error("primary");
  for(const consumed of [{consumed:true},{consumed:false}]){
    const denied={...store([]),reserve:async()=>null} as unknown as D1OpenAIFallbackUsageStore;
    await assert.rejects(analyzeBatchWithFailover(batch,{primary:async()=>{throw original;},geminiContext:context(),cycleId:ref.cycleId,cycleStartedAtMonotonic:-20_000,monotonicNow:()=>60_000,store:denied,limits,apiKey:"key",consumed,requestLuna:async()=>{calls++;throw new Error();}}),error=>error===original);
  }
  assert.equal(calls,0);
});
