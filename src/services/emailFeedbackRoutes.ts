import { createFeedbackConfirmation, FeedbackValidationError, sha256Hex, verifyFeedbackCapability, verifyFeedbackConfirmation, type FeedbackKeyring, type FeedbackRating } from "./emailFeedback.js";
import { D1EmailFeedbackStore } from "./d1EmailFeedbackStore.js";

const securityHeaders={"cache-control":"no-store","referrer-policy":"strict-origin","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
const response=(body:string,status=200,method="GET")=>new Response(method==="HEAD"?null:body,{status,headers:{...securityHeaders,"content-type":"text/html; charset=UTF-8"}});
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const page=(title:string,body:string)=>`<!doctype html><html lang="en"><head><meta name="referrer" content="strict-origin"><title>${escape(title)}</title></head><body><main><h1>${escape(title)}</h1>${body}</main></body></html>`;

export interface FeedbackRouteConfiguration { origin:string; keyring:FeedbackKeyring }

async function exactBinding(store:D1EmailFeedbackStore, token:string, config:FeedbackRouteConfiguration, now:Date) {
  const claims=await verifyFeedbackCapability(token,config.keyring,config.origin,now);
  const binding=await store.readAcceptedBinding(claims.deliveryKey,claims.slot);
  if (!binding || binding.storySha256!==claims.storySha256 || binding.keyId!==claims.keyId
    || (claims.rating==="relevant"?binding.relevantDigest:binding.notRelevantDigest)!==await sha256Hex(token)) throw new FeedbackValidationError("invalid");
  return {claims,binding};
}

async function boundedForm(request:Request):Promise<URLSearchParams> {
  const type=request.headers.get("content-type")?.split(";",1)[0]?.trim();
  if(type!=="application/x-www-form-urlencoded") throw new FeedbackValidationError("invalid");
  if(!request.body) throw new FeedbackValidationError("invalid");
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0,timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new FeedbackValidationError("invalid")),5000);});
  try{for(;;){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;if(value){total+=value.byteLength;if(total>4096)throw new FeedbackValidationError("invalid");chunks.push(value);}}}
  catch(error){void reader.cancel().catch(()=>{});throw error;}finally{if(timer)clearTimeout(timer);}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let text:string;try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new FeedbackValidationError("invalid");}
  const form=new URLSearchParams(text); const keys=[...form.keys()];
  if(keys.length!==4 || new Set(keys).size!==4 || !["token","nonce","rating","revision"].every(k=>form.has(k))) throw new FeedbackValidationError("invalid");
  return form;
}

export async function handleEmailFeedbackRoute(request:Request,database:D1Database,config:FeedbackRouteConfiguration,now=new Date()):Promise<Response|null> {
  const url=new URL(request.url); if(url.pathname!=="/feedback" && url.pathname!=="/feedback/confirm") return null;
  if(url.origin!==config.origin || url.protocol!=="https:") return response(page("Feedback unavailable","This feedback link is unavailable."),400,request.method);
  const store=new D1EmailFeedbackStore(database);
  try {
    if(url.pathname==="/feedback" && (request.method==="GET" || request.method==="HEAD")) {
      if([...url.searchParams.keys()].length!==1 || !url.searchParams.has("token")) throw new FeedbackValidationError("invalid");
      const token=url.searchParams.get("token")!; const {claims,binding}=await exactBinding(store,token,config,now);
      const vote=await store.readVote(claims.deliveryKey,claims.slot); const revision=vote?.revision??0;
      const nonce=await createFeedbackConfirmation(token,claims.rating,revision,claims.expiresAt,config.keyring,config.origin,now);
      const body=`<p>${escape(binding.displayTitle)}</p><p>Choice: ${claims.rating==="relevant"?"Relevant":"Not relevant"}</p><form method="post" action="${config.origin}/feedback/confirm"><input type="hidden" name="token" value="${escape(token)}"><input type="hidden" name="nonce" value="${escape(nonce)}"><input type="hidden" name="rating" value="${claims.rating}"><input type="hidden" name="revision" value="${revision}"><button type="submit">Confirm feedback</button></form>`;
      return response(page("Confirm feedback",body),200,request.method);
    }
    if(url.pathname==="/feedback/confirm" && request.method==="POST") {
      if(request.headers.get("origin")!==config.origin) throw new FeedbackValidationError("invalid");
      const form=await boundedForm(request); const token=form.get("token")!; const rating=form.get("rating") as FeedbackRating;
      const revision=Number(form.get("revision")); const {claims,binding}=await exactBinding(store,token,config,now);
      if(rating!==claims.rating || !Number.isInteger(revision)) throw new FeedbackValidationError("invalid");
      await verifyFeedbackConfirmation(form.get("nonce")!,token,rating,revision,config.keyring,config.origin,now);
      const result=await store.recordVote({deliveryKey:claims.deliveryKey,slot:claims.slot,payloadSha256:binding.payloadSha256,storySha256:binding.storySha256,
        rating,capabilityDigest:await sha256Hex(token),expectedRevision:revision,now:now.toISOString()});
      if(result.kind==="recorded" || result.kind==="already_recorded") return response(page("Feedback recorded","<p>Thank you. Your feedback was recorded.</p>"));
      return response(page("Feedback changed","<p>This confirmation is stale. Reopen the email link and try again.</p>"),result.kind==="conflict"?409:503);
    }
    return response(page("Method not allowed","This method is not available."),405,request.method);
  } catch(error) {
    const status=error instanceof FeedbackValidationError?(error.code==="expired"?410:error.code==="stale"?409:400):503;
    return response(page("Feedback unavailable","<p>This feedback request could not be completed.</p>"),status,request.method);
  }
}
