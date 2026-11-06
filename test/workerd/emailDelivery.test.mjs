import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = join(directory, "..", "..");
const wrangler = join(root, "node_modules", ".bin", "wrangler");
const persistence = await mkdtemp(join(tmpdir(), "email-delivery-workerd-"));
async function unusedPort() { const server=createServer(); await new Promise((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve)); const port=server.address().port; await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())); return port; }
function start(port) { const output={text:""}; const child=spawn(wrangler,["dev","--config",join(directory,"emailDelivery.wrangler.jsonc"),"--local","--ip","127.0.0.1","--port",String(port),"--persist-to",persistence],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:"false",WRANGLER_LOG_PATH:join(persistence,"wrangler.log")},stdio:["ignore","pipe","pipe"]}); const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Wrangler did not become ready.\n${output.text}`)),20_000);const inspect=chunk=>{output.text+=chunk.toString();if(output.text.includes("Ready on")){clearTimeout(timer);resolve();}};child.stdout.on("data",inspect);child.stderr.on("data",inspect);child.once("exit",code=>{clearTimeout(timer);reject(new Error(`Wrangler exited before readiness (${code}).\n${output.text}`));});}); return {child,ready,output}; }
async function stop(child) { if(child.exitCode!==null)return; const exited=new Promise(resolve=>child.once("exit",resolve)); child.kill("SIGTERM"); await exited; }
async function invoke(port,path,date,target) { const url=new URL(`http://127.0.0.1:${port}${path}`); url.searchParams.set("date",date); if(target)url.searchParams.set("target",target); const response=await fetch(url); const text=await response.text(); assert.equal(response.ok,true,text); return JSON.parse(text); }

let requests=0; let workerPort=0; let intentVisible=false;
const receiver=createServer(async (request,response)=>{requests++; let body=""; request.setEncoding("utf8"); for await(const chunk of request)body+=chunk; assert.equal(request.headers["idempotency-key"]?.startsWith("daily-digest/"),true); assert.equal(JSON.parse(body).to[0],"owner@example.test"); const date=request.headers["idempotency-key"].slice("daily-digest/".length); const record=await invoke(workerPort,"/read",date); intentVisible ||= record.state==="attempting"&&record.slots>=1&&record.outcomes.includes("pending"); response.setHeader("content-type","application/json"); response.end(JSON.stringify({id:`email-${requests}`})); });

try {
  await new Promise((resolve,reject)=>receiver.once("error",reject).listen(0,"127.0.0.1",resolve));
  const receiverUrl=`http://127.0.0.1:${receiver.address().port}/send`;
  workerPort=await unusedPort(); let worker=start(workerPort); await worker.ready;

  const race=await invoke(workerPort,"/race","2026-11-04",receiverUrl);
  assert.deepEqual(race.reservations,["committed","superseded"]);
  assert.equal(race.outcome.emailOutcome,"accepted"); assert.equal(race.record.state,"accepted");
  assert.equal(requests,1); assert.equal(intentVisible,true,"dispatch intent must be independently readable before provider response");

  const accepted=await invoke(workerPort,"/seed-accepted","2026-11-05");
  assert.equal(accepted.record.state,"accepted"); assert.equal(accepted.record.reconciled,false);
  await stop(worker.child);
  workerPort=await unusedPort(); worker=start(workerPort); await worker.ready;
  const beforeAcceptedRecovery=requests;
  const repaired=await invoke(workerPort,"/recover","2026-11-05",receiverUrl);
  assert.equal(repaired.outcome.emailOutcome,"accepted"); assert.equal(repaired.outcome.emailAttempts,0);
  assert.equal(repaired.record.reconciled,true); assert.equal(requests,beforeAcceptedRecovery);
  const notifications=await invoke(workerPort,"/notifications","2026-11-05");
  assert.equal(notifications.length,2); assert.equal(notifications.every(row=>row.provider_message_id==="email-accepted"),true);

  const seeded=await invoke(workerPort,"/seed-ambiguous","2026-11-06");
  const originalFirst=seeded.first, originalCutoff=seeded.retryBefore;
  await stop(worker.child);
  workerPort=await unusedPort(); worker=start(workerPort); await worker.ready;
  const beforeReplay=requests;
  const replay=await invoke(workerPort,"/recover","2026-11-06",receiverUrl);
  assert.equal(replay.outcome.emailOutcome,"accepted"); assert.equal(requests,beforeReplay+1);
  assert.equal(replay.record.first,originalFirst); assert.equal(replay.record.retryBefore,originalCutoff);

  const beforeExhaustion=requests;
  const exhaustion=await invoke(workerPort,"/three-slots","2026-11-07",receiverUrl);
  assert.equal(exhaustion.record.slots,3); assert.equal(exhaustion.denied.emailAttempts,0); assert.equal(requests,beforeExhaustion);
  const conflict=await invoke(workerPort,"/conflict","2026-11-08");
  assert.deepEqual([conflict.first,conflict.second,conflict.record.providerMessageId],["committed","blocked","email-one"]);
  const beforeCutoff=requests;
  const cutoff=await invoke(workerPort,"/cutoff","2026-11-09",receiverUrl);
  assert.equal(cutoff.denied.emailAttempts,0); assert.equal(cutoff.originalWindowHours,23); assert.equal(requests,beforeCutoff);
  const late=await invoke(workerPort,"/stale-late-success","2026-11-10");
  assert.deepEqual([late.late,late.repeated,late.conflict,late.acceptedAtPreserved,late.record.providerMessageId],["committed","committed","blocked",true,"email-late"]);

  await stop(worker.child);
  console.log("Workerd email delivery regression passed: one racing winner, committed intent before HTTP, restart recovery, exact replay, slot/cutoff exhaustion, stale-claim late success, and acceptance fencing.");
} finally {
  await new Promise(resolve=>receiver.close(()=>resolve()));
  await rm(persistence,{recursive:true,force:true});
}
