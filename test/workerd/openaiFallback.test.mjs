import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const wrangler = join(repositoryRoot, "node_modules", ".bin", "wrangler");
const persistences = {
  success: await mkdtemp(join(tmpdir(), "openai-fallback-success-")),
  maximum: await mkdtemp(join(tmpdir(), "openai-fallback-maximum-")),
  incomplete: await mkdtemp(join(tmpdir(), "openai-fallback-incomplete-")),
  timeout: await mkdtemp(join(tmpdir(), "openai-fallback-timeout-")),
};
async function unusedPort() { const server=createServer(); await new Promise((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve)); const port=server.address().port; await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); return port; }
function start(port,persistence) { const output={text:""}; const child=spawn(wrangler,["dev","--config",join(testDirectory,"openaiFallback.wrangler.jsonc"),"--local","--ip","127.0.0.1","--port",String(port),"--persist-to",persistence],{cwd:repositoryRoot,env:{...process.env,WRANGLER_SEND_METRICS:"false",WRANGLER_LOG_PATH:join(persistence,"wrangler.log")},stdio:["ignore","pipe","pipe"]}); const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Wrangler did not become ready.\n${output.text}`)),20_000);const inspect=chunk=>{output.text+=chunk.toString();if(output.text.includes("Ready on")){clearTimeout(timer);resolve();}};child.stdout.on("data",inspect);child.stderr.on("data",inspect);child.once("exit",code=>{clearTimeout(timer);reject(new Error(`Wrangler exited before readiness (${code}).\n${output.text}`));});}); return {child,ready,output}; }
async function stop(child) { if(child.exitCode!==null)return; const exited=new Promise(resolve=>child.once("exit",resolve)); child.kill("SIGTERM"); await exited; }
const maximumStory = { candidateId:"c001",relevanceScore:10,category:"major_update",name:"n".repeat(240),summary:"s".repeat(1600),whyItMatters:"w".repeat(800),educationalValue:"e".repeat(800),technologies:Array(8).fill("t".repeat(80)),projectOpportunities:Array(3).fill("p".repeat(240)) };
const output = stories => JSON.stringify({schemaVersion:1,stories});
let fixtureRequests = 0;
const fixture=createServer((request,response)=>{fixtureRequests++;let body="";request.setEncoding("utf8");request.on("data",chunk=>body+=chunk);request.on("end",()=>{const parsed=JSON.parse(body);assert.equal(parsed.model,"gpt-6-luna");if(request.url==="/timeout"){response.setHeader("content-type","application/json");response.flushHeaders();response.write('{"status":"completed"');return;}const incomplete=request.url==="/incomplete";const stories=request.url==="/maximum"?[maximumStory]:[];response.setHeader("content-type","application/json");response.end(JSON.stringify({id:"resp_local",object:"response",status:incomplete?"incomplete":"completed",incomplete_details:incomplete?{reason:"max_output_tokens"}:undefined,output:[{type:"message",role:"assistant",content:[{type:"output_text",text:output(stories)}]}],usage:{input_tokens:10,output_tokens:20,total_tokens:30}}));});});
async function invoke(port,path,name,target) { const response=await fetch(`http://127.0.0.1:${port}${path}?name=${name}${target?`&target=${encodeURIComponent(target)}`:""}`); const text=await response.text(); assert.equal(response.ok,true,text); return JSON.parse(text); }

try {
  await new Promise((resolve,reject)=>fixture.once("error",reject).listen(0,"127.0.0.1",resolve));
  const fixturePort=fixture.address().port;
  const firstPort=await unusedPort(), first=start(firstPort,persistences.success); await first.ready;
  const success=await invoke(firstPort,"/test","success",`http://127.0.0.1:${fixturePort}/success`);
  assert.deepEqual(success,{winners:1,reservationBeforeFetch:true,providerOutcome:"success",validatedSelections:0,state:"exact",dispatchStatus:"observed",requestCount:1,totalTokens:30,failureClass:"none",telemetryFinalAnalyzer:"openai"},first.output.text);
  assert.deepEqual(await invoke(firstPort,"/late-write","success"),{rejected:true,state:"exact",dispatchStatus:"observed",requestCount:1,totalTokens:30,failureClass:"none",telemetryFinalAnalyzer:"openai"});
  await stop(first.child);
  const successRestartPort=await unusedPort(), successRestart=start(successRestartPort,persistences.success); await successRestart.ready;
  assert.deepEqual(await invoke(successRestartPort,"/read","success"),{state:"exact",dispatchStatus:"observed",requestCount:1,totalTokens:30,failureClass:"none",telemetryFinalAnalyzer:"openai"});
  await stop(successRestart.child);

  const maximumPort=await unusedPort(), maximumWorker=start(maximumPort,persistences.maximum); await maximumWorker.ready;
  const maximum=await invoke(maximumPort,"/test","maximum",`http://127.0.0.1:${fixturePort}/maximum`);
  assert.deepEqual([maximum.providerOutcome,maximum.validatedSelections,maximum.state,maximum.totalTokens],["success",1,"exact",30]);
  await stop(maximumWorker.child);

  const incompletePort=await unusedPort(), incompleteWorker=start(incompletePort,persistences.incomplete); await incompleteWorker.ready;
  const incomplete=await invoke(incompletePort,"/test","incomplete",`http://127.0.0.1:${fixturePort}/incomplete`);
  assert.deepEqual([incomplete.providerOutcome,incomplete.validatedSelections,incomplete.state,incomplete.failureClass,incomplete.totalTokens],["invalid_response",null,"exact","invalid_response",30]);
  await stop(incompleteWorker.child);

  const timeoutPort=await unusedPort(), timeoutWorker=start(timeoutPort,persistences.timeout); await timeoutWorker.ready;
  const timeoutStarted=Date.now();
  const timeout=await invoke(timeoutPort,"/test","timeout",`http://127.0.0.1:${fixturePort}/timeout`);
  assert.ok(Date.now()-timeoutStarted<2_000);
  assert.deepEqual([timeout.providerOutcome,timeout.state,timeout.failureClass,timeout.totalTokens],["timeout","unknown","timeout",null]);
  assert.equal(fixtureRequests,4);
  await stop(timeoutWorker.child);

  const secondPort=await unusedPort(), second=start(secondPort,persistences.timeout); await second.ready;
  const beforeRetry=fixtureRequests;
  const denied=await invoke(secondPort,"/test","timeout",`http://127.0.0.1:${fixturePort}/must-not-dispatch`);
  assert.deepEqual([denied.winners,denied.state,denied.failureClass],[0,"unknown","timeout"]);
  assert.equal(fixtureRequests,beforeRetry);
  await stop(second.child);
  console.log("Workerd OpenAI fallback regression passed: one durable winner, bounded native request paths, exact/unknown accounting, CAS rejection, telemetry and restart denial.");
} finally {
  await new Promise(resolve=>fixture.close(()=>resolve()));
  for (const persistence of Object.values(persistences)) await rm(persistence,{recursive:true,force:true});
}
