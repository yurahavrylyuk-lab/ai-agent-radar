import assert from "node:assert/strict";
import test from "node:test";
import { calculateFeedbackPreferenceProfile,feedbackPreferenceAdjustment } from "../src/services/feedbackPreferences.js";
import { prepareDailyDigest } from "../src/services/notificationOrchestrator.js";
import type { BatchDeliveryCandidate, StoredDiscovery } from "../src/types/index.js";

test("preference profile is neutral until bounded evidence thresholds are met",()=>{
  const values=[1,2,3,4].map(i=>({discoveryKey:`d${i}`,topics:["ai_ml" as const],rating:"relevant" as const,logicalDate:"2026-11-12",deliveryKey:`k${i}`,slot:1}));
  assert.equal(calculateFeedbackPreferenceProfile(values).ai_ml,0);
  const profile=calculateFeedbackPreferenceProfile([...values,{...values[0]!,discoveryKey:"d5"}]);
  assert.equal(profile.ai_ml,.5);
  assert.equal(feedbackPreferenceAdjustment(profile,["ai_ml","programming"]),.25);
  assert.equal(feedbackPreferenceAdjustment(profile,[]),0);
});

test("changed votes contribute once per distinct story and negative evidence is bounded",()=>{
  const values=Array.from({length:5},(_,i)=>({discoveryKey:`n${i}`,topics:["programming" as const],rating:"not_relevant" as const,logicalDate:"2026-11-12",deliveryKey:`k${i}`,slot:1}));
  assert.equal(calculateFeedbackPreferenceProfile(values).programming,-.5);
});

test("preferences reorder only equal-score same-lane admitted positions without changing scores",async()=>{
  const candidate=(id:string,name:string):BatchDeliveryCandidate=>{const discovery:StoredDiscovery={normalizedUrl:`https://example.test/${id}`,firstSeenAt:"2026-11-12T00:00:00.000Z",lastSeenAt:"2026-11-12T00:00:00.000Z",batchSelectionProvenance:{kind:"batch"},analysis:{name,category:"developer_tool",summary:name,relevanceScore:8,whyItMatters:name,educationalValue:name,projectOpportunities:[],technologies:[],sourceTitle:name,sourceUrl:`https://example.test/${id}`}};return{discovery,origin:"fresh",aliases:[]};};
  const neutral=neutralHistory();const profile={ai_ml:.5,it_infrastructure:0,programming:0,developer_tools_workflow:0} as const;
  const result=await prepareDailyDigest({cycleDate:"2026-11-12T08:00:00.000Z",fresh:[candidate("plain","Plain"),candidate("gemini","Gemini agent")],replay:[],rawCandidates:[],observedAliases:new Map(),allowRawFallback:true,reason:"selected"},neutral,profile);
  assert.deepEqual(result.items.map(item=>item.kind==="analyzed"?item.candidate.discovery.analysis.name:"raw"),["Gemini agent","Plain"]);
  assert.deepEqual(result.items.map(item=>item.kind==="analyzed"?item.candidate.discovery.analysis.relevanceScore:0),[8,8]);
});

function neutralHistory(){return{hasNotificationBeenSent:async()=>false,getNotificationRecord:async()=>null,recordNotificationSent:async()=>{throw new Error("unused");}};}
