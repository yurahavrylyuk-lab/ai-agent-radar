import { OPENAI_FALLBACK } from "../../config/openaiFallback.js";
import type { OpenAIExactUsage } from "../../services/d1OpenAIFallbackUsageStore.js";
import { agentAnalysisCategories, type PreparedBatch } from "../../types/index.js";

export interface LunaTransportResult {
  outcome: "success" | "timeout" | "transport_error" | "http_failure" | "invalid_response" | "usage_unknown";
  outputText?: string;
  usage: OpenAIExactUsage | null;
  httpStatus: number | null;
  durationMs: number;
}

interface ResponsesEnvelope {
  status?: unknown;
  output?: unknown;
  usage?: unknown;
}

const endpoint = "https://api.openai.com/v1/responses";
const storyProperties = {
  candidateId: { type: "string" },
  relevanceScore: { type: "integer", minimum: 1, maximum: 10 },
  category: { type: "string", enum: agentAnalysisCategories },
  name: { type: "string" }, summary: { type: "string" }, whyItMatters: { type: "string" }, educationalValue: { type: "string" },
  technologies: { type: "array", maxItems: 8, items: { type: "string" } },
  projectOpportunities: { type: "array", maxItems: 3, items: { type: "string" } },
};
const storyRequired = Object.keys(storyProperties);
export const LUNA_BATCH_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["schemaVersion", "stories"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    stories: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: storyRequired, properties: storyProperties } },
  },
});

function duration(now:()=>number,start:number) { const value=Math.trunc(now()-start); return Number.isSafeInteger(value)&&value>=0?Math.min(value,110_000):0; }
function exactUsage(value:unknown):OpenAIExactUsage|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const usage=value as Record<string,unknown>, input=usage.input_tokens, output=usage.output_tokens, total=usage.total_tokens;
  if(![input,output,total].every(item=>typeof item==="number"&&Number.isSafeInteger(item)&&item>=0)||total!==(input as number)+(output as number))return null;
  return {inputTokens:input as number,outputTokens:output as number,totalTokens:total as number};
}
function outputText(value:unknown):string|null {
  if(!Array.isArray(value))return null;
  const texts:string[]=[]; let assistantMessages=0;
  for(const item of value){
    if(!item||typeof item!=="object"||Array.isArray(item))return null;
    const message=item as Record<string,unknown>;
    if(message.type==="reasoning")continue;
    if(message.type!=="message"||message.role!=="assistant"||!Array.isArray(message.content))return null;
    assistantMessages++;
    for(const part of message.content){
      if(!part||typeof part!=="object"||Array.isArray(part))return null;
      const content=part as Record<string,unknown>;
      if(content.type!=="output_text"||typeof content.text!=="string")return null;
      texts.push(content.text);
    }
  }
  return assistantMessages===1&&texts.length===1&&texts[0]!.length>0?texts[0]!:null;
}

async function boundedBody(response:Response, limit:number):Promise<string> {
  if(!response.body)return "";
  const reader=response.body.getReader(), chunks:Uint8Array[]=[]; let size=0;
  try {
    while(true){
      const result=await reader.read();
      if(result.done)break;
      size+=result.value.byteLength;
      if(size>limit){void reader.cancel().catch(()=>{});throw new Error("body_limit");}
      chunks.push(result.value);
    }
  } catch(error){void reader.cancel().catch(()=>{});throw error;}
  const combined=new Uint8Array(size); let offset=0;
  for(const chunk of chunks){combined.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder("utf-8",{fatal:true}).decode(combined);
}

export async function requestLuna(batch:PreparedBatch,deps:{apiKey:string;fetch:typeof fetch;monotonicNow:()=>number;timeoutMs?:number}):Promise<LunaTransportResult>{
  const started=deps.monotonicNow(), timeoutMs=deps.timeoutMs??OPENAI_FALLBACK.timeoutMs, controller=new AbortController();
  const body=JSON.stringify({model:OPENAI_FALLBACK.model,input:batch.prompt,reasoning:{effort:OPENAI_FALLBACK.reasoning},max_output_tokens:OPENAI_FALLBACK.maxOutputTokens,store:false,stream:false,
    text:{format:{type:"json_schema",name:"radar_batch_v1",strict:true,schema:LUNA_BATCH_SCHEMA}}});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  const operation=(async()=>{
    const response=await deps.fetch(endpoint,{method:"POST",redirect:"manual",signal:controller.signal,headers:{authorization:`Bearer ${deps.apiKey}`,"content-type":"application/json"},body});
    let text:string;
    try{text=await boundedBody(response,OPENAI_FALLBACK.responseBodyBytes);}
    catch{if(controller.signal.aborted)throw new DOMException("deadline","AbortError");return {outcome:"invalid_response" as const,usage:null,httpStatus:response.status};}
    let parsed:ResponsesEnvelope|undefined;
    try{const value=JSON.parse(text) as unknown;if(value&&typeof value==="object"&&!Array.isArray(value))parsed=value as ResponsesEnvelope;}catch{/* bounded classification below */}
    const usage=exactUsage(parsed?.usage);
    if(!response.ok)return {outcome:"http_failure" as const,usage,httpStatus:response.status};
    const output=outputText(parsed?.output);
    if(parsed?.status!=="completed"||!output)return {outcome:"invalid_response" as const,usage,httpStatus:response.status};
    if(!usage)return {outcome:"usage_unknown" as const,usage:null,httpStatus:response.status};
    return {outcome:"success" as const,outputText:output,usage,httpStatus:response.status};
  })();
  const timeout=new Promise<never>((_resolve,reject)=>{controller.signal.addEventListener("abort",()=>reject(new DOMException("deadline","AbortError")),{once:true});});
  try{
    const result=await Promise.race([operation,timeout]);
    return {...result,durationMs:duration(deps.monotonicNow,started)};
  }catch{
    operation.catch(()=>{});
    return {outcome:timedOut?"timeout":"transport_error",usage:null,httpStatus:null,durationMs:duration(deps.monotonicNow,started)};
  }finally{clearTimeout(timer);}
}
