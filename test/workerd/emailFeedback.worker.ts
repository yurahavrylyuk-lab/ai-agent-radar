import { D1EmailDeliveryLedger } from "../../src/services/d1EmailDeliveryLedger.js";
import { D1EmailFeedbackStore } from "../../src/services/d1EmailFeedbackStore.js";
import { createFeedbackCapability } from "../../src/services/emailFeedback.js";
import { deliveryIdentity,freezeDelivery } from "../../src/services/emailDeliveryLedger.js";
// @ts-expect-error reviewed migration text import
import initial from "../../migrations/0001_initial.sql";
// @ts-expect-error reviewed migration text import
import ledgerMigration from "../../migrations/0010_email_delivery_ledger.sql";
// @ts-expect-error reviewed migration text import
import feedbackMigration from "../../migrations/0011_email_feedback.sql";
interface Env{DB:D1Database}
const keyring={active:{id:"fixture",secret:"f".repeat(32)}};const origin="https://feedback.example";
async function apply(db:D1Database,sql:string){for(const statement of sql.trim().split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();}
async function setup(db:D1Database){if(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_feedback_stories'").first())return;await apply(db,initial);await apply(db,ledgerMigration);await apply(db,feedbackMigration);}
export default{async fetch(request:Request,env:Env){await setup(env.DB);const url=new URL(request.url);const identity=deliveryIdentity(new Date("2026-11-12T08:00:00.000Z"));
  if(url.pathname==="/seed"){const cap=await createFeedbackCapability({deliveryKey:identity.key,slot:1,storySha256:"a".repeat(64),rating:"relevant",issuedAt:identity.scheduledAt},keyring,origin);
    const digest:any={mode:"degraded",reason:"ai_unavailable",cycleDate:identity.scheduledAt,items:[]};const frozen=await freezeDelivery(digest,identity,{from:"x",subject:"s",text:"t",html:"<p>h</p>"},"o@example.test");
    const ledger=new D1EmailDeliveryLedger(env.DB);const binding:any={deliveryKey:identity.key,slot:1,payloadSha256:frozen.payloadSha256,storySha256:"a".repeat(64),discoveryKey:"b".repeat(64),displayTitle:"Story",kind:"raw",topics:[],issuedAt:identity.scheduledAt,expiresAt:cap.claims.expiresAt,keyId:"fixture",relevantDigest:cap.digest,notRelevantDigest:"c".repeat(64)};
    await ledger.reserveWithBindings(frozen,[binding]);const claim=await ledger.claim(identity.key,"workerd");if(claim.kind!=="committed"||!claim.record.claim)throw new Error();await ledger.admitDispatch(claim.record.claim);await ledger.recordOutcome(claim.record.claim,frozen.payloadSha256,{kind:"accepted",id:"m1"});
    const result=await new D1EmailFeedbackStore(env.DB).recordVote({deliveryKey:identity.key,slot:1,payloadSha256:frozen.payloadSha256,storySha256:binding.storySha256,rating:"relevant",capabilityDigest:cap.digest,expectedRevision:0,now:"2026-11-12T09:00:00.000Z"});return Response.json(result);}
  const vote=await new D1EmailFeedbackStore(env.DB).readVote(identity.key,1);return Response.json(vote);
}};
