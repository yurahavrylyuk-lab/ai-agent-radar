import { classifyDiscoveryTopics } from "./discoveryPriority.js";
import { createFeedbackCapability, sha256Hex, type FeedbackKeyring } from "./emailFeedback.js";
import type { FeedbackStoryBinding } from "./d1EmailFeedbackStore.js";
import type { DeliveryIdentity } from "./emailDeliveryLedger.js";
import type { PreparedDailyDigest } from "../types/index.js";
import type { FeedbackActionLinks } from "./discoveryEmailFormatter.js";

export interface EmailFeedbackConfiguration { origin: string; keyring: FeedbackKeyring }
export type PreparedFeedback = { actions: FeedbackActionLinks[]; bindings: Omit<FeedbackStoryBinding,"payloadSha256">[] };

export async function prepareEmailFeedback(digest: PreparedDailyDigest, identity: DeliveryIdentity, config: EmailFeedbackConfiguration): Promise<PreparedFeedback> {
  if (digest.items.length===0) return {actions:[],bindings:[]};
  const actions: FeedbackActionLinks[]=[]; const bindings: Omit<FeedbackStoryBinding,"payloadSha256">[]=[];
  for (const [index,item] of digest.items.entries()) {
    const slot=(index+1) as 1|2|3|4;
    const analyzed=item.kind==="analyzed";
    const url=analyzed?item.candidate.discovery.normalizedUrl:item.candidate.normalizedUrl;
    const title=analyzed?item.candidate.discovery.analysis.name:item.candidate.source.title;
    const discoveryKey=await sha256Hex(url);
    const storySha256=await sha256Hex(JSON.stringify({deliveryKey:identity.key,slot,discoveryKey,title,kind:analyzed?"analyzed":"raw"}));
    const common={deliveryKey:identity.key,slot,storySha256,issuedAt:identity.scheduledAt} as const;
    const relevant=await createFeedbackCapability({...common,rating:"relevant"},config.keyring,config.origin);
    const negative=await createFeedbackCapability({...common,rating:"not_relevant"},config.keyring,config.origin);
    const link=(token:string)=>{ const value=`${config.origin}/feedback?token=${encodeURIComponent(token)}`; if(new TextEncoder().encode(value).byteLength>2048) throw new Error("Feedback URL exceeds limit."); return value; };
    const boundedTitle=(()=>{const encoder=new TextEncoder();let value="";for(const char of title){if(encoder.encode(value+char).byteLength>256)break;value+=char;}if(!value)throw new Error("Feedback title is unavailable.");return value;})();
    actions.push({slot,title:boundedTitle,relevantUrl:link(relevant.token),notRelevantUrl:link(negative.token)});
    bindings.push({deliveryKey:identity.key,slot,storySha256,discoveryKey,displayTitle:boundedTitle,kind:analyzed?"analyzed":"raw",
      topics:analyzed?classifyDiscoveryTopics(item.candidate.discovery.analysis):[],issuedAt:identity.scheduledAt,expiresAt:relevant.claims.expiresAt,
      keyId:relevant.claims.keyId,relevantDigest:relevant.digest,notRelevantDigest:negative.digest});
  }
  return {actions,bindings};
}
