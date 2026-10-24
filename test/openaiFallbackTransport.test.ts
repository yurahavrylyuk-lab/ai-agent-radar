import assert from "node:assert/strict";
import test from "node:test";
import { parseBatchAnalysis } from "../src/services/analysisAgent.js";
import { requestLuna } from "../src/tools/llm/openaiFallback.js";
import type { PreparedBatch } from "../src/types/index.js";

const candidate = { candidateId: "c001", source: { title: "Safe title", url: "https://example.com/story", snippet: "Safe summary" }, normalizedUrl: "https://example.com/story", aliasKey: "https://example.com/story", aliases: ["https://example.com/story"], provenance: [{ kind: "brave" as const, queryOrdinal: 1, resultOrdinal: 1 }] };
const batch: PreparedBatch = { prompt: "bounded prompt", candidates: [candidate], promptBytes: 14, sizeExcluded: 0, truncationStage: "initial", snippetBytesLimit: 192 };
const output = JSON.stringify({ schemaVersion: 1, stories: [{ candidateId: "c001", relevanceScore: 8, category: "major_update", name: "Release", summary: "Summary", whyItMatters: "Useful", educationalValue: "Learn", technologies: ["TypeScript"], projectOpportunities: ["Build"] }] });
const envelope = (patch: Record<string, unknown> = {}) => ({ id: "resp_1", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: output }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 }, ...patch });

test("Luna sends one fixed strict Responses request and shared validation accepts its output", async () => {
  let calls = 0; let url = ""; let init: RequestInit | undefined;
  const result = await requestLuna(batch, { apiKey: "secret", monotonicNow: () => 100,
    fetch: async (input, value) => { calls++; url=String(input); init=value; return new Response(JSON.stringify(envelope()), { status: 200 }); } });
  assert.equal(calls, 1);
  assert.equal(url, "https://api.openai.com/v1/responses");
  assert.equal(init?.method, "POST");
  assert.equal(init?.redirect, "error");
  const body=JSON.parse(String(init?.body));
  assert.equal(body.model,"gpt-6-luna"); assert.deepEqual(body.reasoning,{effort:"low"}); assert.equal(body.max_output_tokens,12288);
  assert.equal(body.store,false); assert.equal(body.stream,false); assert.equal(body.input,batch.prompt);
  assert.equal(body.text.format.name,"radar_batch_v1"); assert.equal(body.text.format.strict,true); assert.equal(body.text.format.schema.additionalProperties,false);
  for(const forbidden of ["tools","previous_response_id","background"]) assert.equal(Object.hasOwn(body,forbidden),false);
  assert.deepEqual(result,{outcome:"success",outputText:output,usage:{inputTokens:10,outputTokens:20,totalTokens:30},httpStatus:200,durationMs:0});
  assert.equal(parseBatchAnalysis(result.outputText!,batch).selections.length,1);
});

test("incomplete and malformed outputs retain exact usage but never become success", async (t) => {
  for (const [name, value] of [
    ["incomplete", envelope({status:"incomplete",incomplete_details:{reason:"max_output_tokens"}})],
    ["refusal", envelope({output:[{type:"message",role:"assistant",content:[{type:"refusal",refusal:"no"}]}]})],
    ["multiple", envelope({output:[{type:"message",role:"assistant",content:[{type:"output_text",text:output},{type:"output_text",text:output}]}]})],
  ] as const) await t.test(name,async()=>{
    const result=await requestLuna(batch,{apiKey:"x",monotonicNow:()=>0,fetch:async()=>new Response(JSON.stringify(value))});
    assert.equal(result.outcome,"invalid_response"); assert.deepEqual(result.usage,{inputTokens:10,outputTokens:20,totalTokens:30});
  });
  const invalidUsage=await requestLuna(batch,{apiKey:"x",monotonicNow:()=>0,fetch:async()=>new Response(JSON.stringify(envelope({usage:{input_tokens:1,output_tokens:2,total_tokens:2}})))});
  assert.equal(invalidUsage.outcome,"usage_unknown"); assert.equal(invalidUsage.usage,null);
});

test("HTTP failures, transport errors, and timeout remain one-attempt bounded", async () => {
  let calls=0;
  const http=await requestLuna(batch,{apiKey:"x",monotonicNow:()=>0,fetch:async()=>{calls++;return new Response("provider private text",{status:503});}});
  assert.deepEqual([http.outcome,http.httpStatus,http.usage,calls],["http_failure",503,null,1]);
  const transport=await requestLuna(batch,{apiKey:"x",monotonicNow:()=>0,fetch:async()=>{calls++;throw new Error("private");}});
  assert.deepEqual([transport.outcome,transport.httpStatus,transport.usage,calls],["transport_error",null,null,2]);
  const timeout=await requestLuna(batch,{apiKey:"x",monotonicNow:()=>0,timeoutMs:5,fetch:async(_i,init)=>{calls++;await new Promise<void>((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError"))));return new Response();}});
  assert.deepEqual([timeout.outcome,timeout.httpStatus,timeout.usage,calls],["timeout",null,null,3]);
});

test("body cap and cancellation cannot extend the deadline", async () => {
  const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(131_073));},cancel(){return new Promise(()=>{});}});
  const result=await requestLuna(batch,{apiKey:"x",monotonicNow:()=>0,fetch:async()=>new Response(stream)});
  assert.equal(result.outcome,"invalid_response");
});
