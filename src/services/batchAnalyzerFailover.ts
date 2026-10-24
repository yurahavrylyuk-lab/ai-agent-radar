import type { OpenAIFallbackLimits } from "../config/openaiFallback.js";
import { parseBatchAnalysis } from "./analysisAgent.js";
import type { D1OpenAIFallbackUsageStore, LunaEvidence } from "./d1OpenAIFallbackUsageStore.js";
import type { GeminiBatchCycleContext } from "../tools/llm/gemini.js";
import { requestLuna as defaultRequestLuna, type LunaTransportResult } from "../tools/llm/openaiFallback.js";
import type { BatchAnalysisResult, PreparedBatch } from "../types/index.js";

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
  try{return await deps.primary();}catch(error){primaryError=error;}
  const apiKey=deps.apiKey?.trim();
  if(!apiKey||!deps.limits||deps.consumed.consumed||!eligible(deps.geminiContext)||
    !lunaTimingAllowed(deps.monotonicNow(),deps.geminiContext.deadlineStartedAtMonotonic,deps.cycleStartedAtMonotonic))throw primaryError;
  deps.consumed.consumed=true;
  const reservation=await deps.store.reserve(deps.cycleId,deps.limits);
  if(!reservation)throw primaryError;
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
  if(result.outcome!=="success"||!result.outputText)throw new Error("OpenAI fallback analysis failed.");
  return parseBatchAnalysis(result.outputText,batch);
}
