import type { OpenAIFallbackLimits } from "../config/openaiFallback.js";
import { parseBatchAnalysis } from "./analysisAgent.js";
import type { D1OpenAIFallbackUsageStore, LunaEvidence } from "./d1OpenAIFallbackUsageStore.js";
import type { GeminiBatchCycleContext } from "../tools/llm/gemini.js";
import { requestLuna as defaultRequestLuna, type LunaTransportResult } from "../tools/llm/openaiFallback.js";
import type { BatchAnalysisResult, PreparedBatch } from "../types/index.js";
import type { AnalyzerFailoverObservation, AnalyzerFailoverEligibilityReason } from "./monitoringTelemetry.js";

export interface FailoverConsumed { consumed:boolean; }
export interface FailoverDependencies {
  primary:()=>Promise<BatchAnalysisResult>;
  geminiContext:GeminiBatchCycleContext;
  cycleId:string;
  cycleStartedAtMonotonic:number;
  monotonicNow:()=>number;
  store:D1OpenAIFallbackUsageStore;
  limits:OpenAIFallbackLimits|null;
  apiKey?:string;
  consumed:FailoverConsumed;
  requestLuna?:typeof defaultRequestLuna;
  onObservation?:(value:AnalyzerFailoverObservation)=>void;
}

export function lunaTimingAllowed(now:number,firstGeminiStart:number|undefined,cycleStart:number):boolean {
  return Number.isFinite(now)&&Number.isFinite(firstGeminiStart)&&Number.isFinite(cycleStart)&&
    firstGeminiStart!==undefined&&firstGeminiStart+90_000-now>=30_000&&cycleStart+110_000-now>=30_000;
}

function eligible(context:GeminiBatchCycleContext):boolean {
  return !context.dispatchBlockedByTimeout&&context.retrySkipReason==="exhausted"&&context.attempts.length===3&&context.attempts.every((attempt,index)=>
    attempt.ordinal===index+1&&attempt.failureClass==="unavailable_503"&&attempt.providerFailureClass==="unavailable_503"&&attempt.httpStatus===503&&attempt.accountingOutcome==="confirmed_zero");
}

function evidence(result:LunaTransportResult,endedAt:string):LunaEvidence {
  return {outcome:result.outcome==="success"?"none":result.outcome,httpStatus:result.httpStatus,endedAt,durationMs:result.durationMs};
}

export async function analyzeBatchWithFailover(batch:PreparedBatch,deps:FailoverDependencies):Promise<BatchAnalysisResult>{
  let primaryError:unknown;
  try{const result=await deps.primary();deps.onObservation?.({version:1,provider:"openai",model:"gpt-6-luna",eligible:false,eligibilityReason:"gemini_not_exhausted",attempted:false,dispatchCount:0,startedAt:null,endedAt:null,durationMs:null,outcome:"not_attempted",httpStatus:null,usage:null,accountingState:"none",finalAnalyzer:"gemini"});return result;}catch(error){primaryError=error;}
  const apiKey=deps.apiKey?.trim();
  const limits=deps.limits;
  let reason:AnalyzerFailoverEligibilityReason="eligible";
  if(!apiKey||!deps.limits)reason="configuration";else if(deps.consumed.consumed)reason="consumed";else if(!eligible(deps.geminiContext))reason="gemini_not_exhausted";else if(!lunaTimingAllowed(deps.monotonicNow(),deps.geminiContext.deadlineStartedAtMonotonic,deps.cycleStartedAtMonotonic))reason="timing";
  if(reason!=="eligible"){deps.onObservation?.({version:1,provider:"openai",model:"gpt-6-luna",eligible:false,eligibilityReason:reason,attempted:false,dispatchCount:0,startedAt:null,endedAt:null,durationMs:null,outcome:"not_attempted",httpStatus:null,usage:null,accountingState:"none",finalAnalyzer:"none"});throw primaryError;}
  if(!apiKey||!limits)throw primaryError;
  deps.consumed.consumed=true;
  const reservation=await deps.store.reserve(deps.cycleId,limits);
  if(!reservation){deps.onObservation?.({version:1,provider:"openai",model:"gpt-6-luna",eligible:false,eligibilityReason:"accounting",attempted:false,dispatchCount:0,startedAt:null,endedAt:null,durationMs:null,outcome:"not_attempted",httpStatus:null,usage:null,accountingState:"none",finalAnalyzer:"none"});throw primaryError;}
  try{await deps.store.markIntent(reservation);}catch{throw new Error("OpenAI fallback accounting intent could not be confirmed safely.");}
  if(!lunaTimingAllowed(deps.monotonicNow(),deps.geminiContext.deadlineStartedAtMonotonic,deps.cycleStartedAtMonotonic)){
    try{await deps.store.cancelBeforeDispatch(reservation);}catch{/* surviving reservation blocks later dispatch */}
    throw primaryError;
  }
  await deps.store.markObserved(reservation);
  const result=await (deps.requestLuna??defaultRequestLuna)(batch,{apiKey,fetch:(input,init)=>globalThis.fetch(input,init),monotonicNow:deps.monotonicNow});
  const endedAt=new Date().toISOString();
  if(result.usage)await deps.store.settleExact(reservation,result.usage,evidence(result,endedAt));
  else await deps.store.markUnknown(reservation,evidence(result,endedAt));
  const observation={version:1 as const,provider:"openai" as const,model:"gpt-6-luna" as const,eligible:true,eligibilityReason:"eligible" as const,attempted:true,dispatchCount:1 as const,startedAt:null,endedAt:null,durationMs:result.durationMs,httpStatus:result.httpStatus,usage:result.usage,accountingState:result.usage?"exact" as const:"unknown" as const};
  if(result.outcome!=="success"||!result.outputText){deps.onObservation?.({...observation,outcome:result.outcome,finalAnalyzer:"none"});throw new Error("OpenAI fallback analysis failed.");}
  let analysis:BatchAnalysisResult;
  try{analysis=parseBatchAnalysis(result.outputText,batch);}catch{deps.onObservation?.({...observation,outcome:"invalid_response",finalAnalyzer:"none"});throw new Error("OpenAI fallback analysis failed.");}
  deps.onObservation?.({...observation,outcome:"success",finalAnalyzer:"openai"});
  return analysis;
}
