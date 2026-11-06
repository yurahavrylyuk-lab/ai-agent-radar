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

let requests=0; let creations=0; let workerPort=0; let intentVisible=false;
let providerNow=Date.parse("2026-11-04T08:00:00.000Z");
let heldResponse=null;
const providerDeliveries=new Map();
function holdNextProviderResponse() {
  let acceptedResolve; let releaseResolve;
  const accepted=new Promise(resolve=>{acceptedResolve=resolve;});
  const release=new Promise(resolve=>{releaseResolve=resolve;});
  heldResponse={acceptedResolve,release};
  return {accepted,release:()=>releaseResolve()};
}
async function within(promise,label,ms=5_000){return Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(`${label} timed out`)),ms))]);}
const receiver=createServer(async (request,response)=>{
  requests++;
  let body=""; request.setEncoding("utf8"); for await(const chunk of request)body+=chunk;
  const key=request.headers["idempotency-key"];
  assert.equal(key?.startsWith("daily-digest/"),true);
  assert.equal(JSON.parse(body).to[0],"owner@example.test");
  const date=key.slice("daily-digest/".length);
  const record=await invoke(workerPort,"/read",date);
  intentVisible ||= record?.state==="attempting"&&record.slots>=1&&record.outcomes.includes("pending");
  let delivery=providerDeliveries.get(key);
  if(delivery&&providerNow-delivery.createdAt>=24*60*60*1000){providerDeliveries.delete(key);delivery=undefined;}
  if(delivery&&delivery.body!==body){response.statusCode=409;response.setHeader("content-type","application/json");response.end(JSON.stringify({name:"invalid_idempotent_request"}));return;}
  if(!delivery){creations++;delivery={body,id:`email-${creations}`,createdAt:providerNow};providerDeliveries.set(key,delivery);}
  if(heldResponse){const held=heldResponse;heldResponse=null;held.acceptedResolve({key,id:delivery.id});await held.release;}
  response.setHeader("content-type","application/json");
  response.end(JSON.stringify({id:delivery.id}));
});

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

  const crashHold=holdNextProviderResponse();
  const crashedInvocation=fetch(`http://127.0.0.1:${workerPort}/deliver?date=2026-11-11&target=${encodeURIComponent(receiverUrl)}`).catch(()=>null);
  const providerAcceptance=await within(crashHold.accepted,"provider acceptance before crash");
  const creationsAfterCrashAcceptance=creations;
  await stop(worker.child); crashHold.release(); await crashedInvocation;
  workerPort=await unusedPort(); worker=start(workerPort); await worker.ready;
  await invoke(workerPort,"/expire-lease","2026-11-11");
  const requestsBeforeCrashRecovery=requests;
  const crashRecovery=await invoke(workerPort,"/recover","2026-11-11",receiverUrl);
  assert.equal(crashRecovery.outcome.emailOutcome,"accepted");
  assert.equal(crashRecovery.record.providerMessageId,providerAcceptance.id);
  assert.equal(requests,requestsBeforeCrashRecovery+1,"recovery may replay the exact provider request once");
  assert.equal(creations,creationsAfterCrashAcceptance,"same-key replay must not create a second email");

  const acceptedWriteLost=await invoke(workerPort,"/deliver-fault","2026-11-12",receiverUrl);
  assert.equal(acceptedWriteLost.outcome.emailOutcome,"accepted");
  const acceptedWriteId=acceptedWriteLost.record.providerMessageId;
  await stop(worker.child); workerPort=await unusedPort(); worker=start(workerPort); await worker.ready;
  const requestsBeforeAcceptedRestart=requests;
  const acceptedRestart=await invoke(workerPort,"/recover","2026-11-12",receiverUrl);
  assert.equal(acceptedRestart.record.providerMessageId,acceptedWriteId);
  assert.equal(acceptedRestart.outcome.emailAttempts,0);
  assert.equal(requests,requestsBeforeAcceptedRestart);

  const historyFailure=await invoke(workerPort,"/deliver-aliased-fault","2026-11-13",receiverUrl);
  assert.equal(historyFailure.outcome.emailOutcome,"accepted");
  assert.equal(historyFailure.outcome.historyOutcome,"persistence_failed");
  const historyProviderId=historyFailure.record.providerMessageId;
  await stop(worker.child); workerPort=await unusedPort(); worker=start(workerPort); await worker.ready;
  const requestsBeforeHistoryRepair=requests;
  const historyRepair=await invoke(workerPort,"/recover","2026-11-13",receiverUrl);
  const repeatedHistoryRepair=await invoke(workerPort,"/recover","2026-11-13",receiverUrl);
  assert.equal(historyRepair.record.providerMessageId,historyProviderId);
  assert.equal(historyRepair.record.reconciled,true);
  assert.equal(repeatedHistoryRepair.record.reconciled,true);
  assert.equal(requests,requestsBeforeHistoryRepair);
  const repairedNotifications=await invoke(workerPort,"/notifications","2026-11-13");
  assert.equal(repairedNotifications.length,2);
  assert.equal(repairedNotifications.every(row=>row.provider_message_id==="email-accepted"),true,"existing notification metadata must remain unchanged");

  const conflictKey="daily-digest/2026-11-14";
  providerDeliveries.set(conflictKey,{body:JSON.stringify({from:"different",to:["owner@example.test"],subject:"different",text:"different",html:"different"}),id:"email-preexisting",createdAt:providerNow});
  const conflictRequestsBefore=requests;
  const providerConflict=await invoke(workerPort,"/deliver","2026-11-14",receiverUrl);
  assert.equal(providerConflict.record.lastReason,"payload_conflict");
  assert.equal(providerConflict.record.slots,1);
  const conflictRecovery=await invoke(workerPort,"/recover","2026-11-14",receiverUrl);
  assert.equal(conflictRecovery.outcome.emailAttempts,0);
  assert.equal(conflictRecovery.record.lastReason,"payload_conflict");
  assert.equal(requests,conflictRequestsBefore+1);

  const uncertainty=await invoke(workerPort,"/uncertainty-suite","2026-11-15");
  assert.equal(uncertainty.cases.length,24);
  for(const item of uncertainty.cases){
    const committedMutation=item.mode.startsWith("after");
    const unreadable=item.mode.endsWith("unreadable");
    assert.equal(item.achieved,committedMutation,`${item.operation}/${item.mode} authoritative state mismatch`);
    if(unreadable||!committedMutation)assert.notEqual(item.resultKind,"committed",`${item.operation}/${item.mode} must not claim an unverified commit`);
    else assert.equal(item.resultKind,"committed",`${item.operation}/${item.mode} must reconcile the committed mutation`);
  }
  assert.equal(uncertainty.providerRequests,0);

  const staleConflict=await invoke(workerPort,"/stale-payload-conflict","2026-11-17");
  assert.deepEqual([staleConflict.conflict,staleConflict.admission],["committed","blocked"]);
  assert.equal(staleConflict.record.lastReason,"payload_conflict");
  assert.equal(staleConflict.record.slots,1);
  assert.deepEqual(staleConflict.record.outcomes,["payload_conflict"]);
  assert.equal(staleConflict.record.claim,null);
  await stop(worker.child); workerPort=await unusedPort(); worker=start(workerPort); await worker.ready;
  const requestsBeforeStaleConflictRecovery=requests;
  const staleConflictRecovery=await invoke(workerPort,"/recover","2026-11-17",receiverUrl);
  assert.equal(staleConflictRecovery.outcome.emailAttempts,0);
  assert.equal(staleConflictRecovery.record.lastReason,"payload_conflict");
  assert.equal(staleConflictRecovery.record.slots,1);
  assert.equal(requests,requestsBeforeStaleConflictRecovery,"payload-conflict restart must not dispatch another email");

  const lateAfterConflict=await invoke(workerPort,"/late-acceptance-after-conflict","2026-11-18");
  assert.deepEqual([lateAfterConflict.conflict,lateAfterConflict.late,lateAfterConflict.claim],["committed","blocked","blocked"]);
  assert.equal(lateAfterConflict.record.state,"ambiguous");
  assert.equal(lateAfterConflict.record.lastReason,"payload_conflict");
  assert.equal(lateAfterConflict.record.providerMessageId,null);
  assert.deepEqual(lateAfterConflict.record.outcomes,["payload_conflict"]);

  providerNow+=24*60*60*1000;
  const expiryKey="daily-digest/2026-11-16";
  const expiryBody=JSON.stringify({from:"AI Radar <radar@example.test>",to:["owner@example.test"],subject:"Expiry",text:"Expiry",html:"<p>Expiry</p>"});
  const firstExpiry=await fetch(receiverUrl,{method:"POST",headers:{"content-type":"application/json","idempotency-key":expiryKey},body:expiryBody});
  const firstExpiryId=(await firstExpiry.json()).id;
  providerNow+=24*60*60*1000;
  const secondExpiry=await fetch(receiverUrl,{method:"POST",headers:{"content-type":"application/json","idempotency-key":expiryKey},body:expiryBody});
  assert.notEqual((await secondExpiry.json()).id,firstExpiryId,"fake provider must really expire idempotency keys after 24 hours");

  await stop(worker.child);
  console.log("Workerd email delivery regression passed: real crash/restart provider replay, accepted-write and history-repair uncertainty, payload-conflict hold, D1 mutation matrix, provider expiry, slot/cutoff exhaustion, and fencing.");
} finally {
  await new Promise(resolve=>receiver.close(()=>resolve()));
  await rm(persistence,{recursive:true,force:true});
}
