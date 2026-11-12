import assert from "node:assert/strict";
import { spawn,spawnSync } from "node:child_process";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const directory=await mkdtemp(join(tmpdir(),"ai-radar-feedback-browser-"));
const key=join(directory,"key.pem"),cert=join(directory,"cert.pem"),profile=join(directory,"profile");
const generated=spawnSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=feedback.example"],{stdio:"ignore"});
assert.equal(generated.status,0,"local browser fixture certificate generation failed");
let observed;
const server=createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
  if(req.url?.startsWith("/feedback?")){
    res.setHeader("referrer-policy","strict-origin");res.setHeader("content-type","text/html");
    res.end(`<!doctype html><form id=f method=post action=/feedback/confirm><input name=token value=synthetic><button>Confirm</button></form><script>document.querySelector('button').click()</script>`);return;
  }
  let body="";for await(const chunk of req)body+=chunk;
  if(req.method==="POST"&&req.url==="/feedback/confirm") observed={method:req.method,origin:req.headers.origin,referer:req.headers.referer,body};
  res.setHeader("content-type","text/html");res.end("<!doctype html><p>done</p>");
});
try{
  await new Promise((resolve,reject)=>server.once("error",reject).listen(0,"127.0.0.1",resolve));
  const port=server.address().port;const origin=`https://feedback.example:${port}`;
  const child=spawn(chrome,["--headless=new","--disable-gpu","--no-first-run","--ignore-certificate-errors",`--user-data-dir=${profile}`,"--host-resolver-rules=MAP feedback.example 127.0.0.1","--dump-dom",`${origin}/feedback?token=SENSITIVE_QUERY_VALUE`],{stdio:"ignore"});
  await Promise.race([new Promise((resolve,reject)=>child.once("exit",code=>code===0?resolve():reject(new Error(`Chrome exited ${code}`)))),new Promise((_,reject)=>setTimeout(()=>reject(new Error("browser form timed out")),15_000))]);
  assert.deepEqual(observed,{method:"POST",origin,referer:`${origin}/`,body:"token=synthetic"});
  console.log("Browser feedback Origin regression passed: exact HTTPS Origin and origin-only Referer; query token omitted.");
}finally{await new Promise(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
