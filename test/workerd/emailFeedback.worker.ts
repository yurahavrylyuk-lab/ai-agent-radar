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
async function seedCleanupGroup(db:D1Database,date:string,expiresAt:string,slots=1){const deliveryKey=`daily-digest/${date}`;
  await db.prepare(`INSERT INTO email_deliveries(delivery_key,logical_date,state,payload_sha256,created_at,updated_at,provider_message_id,accepted_at,reconciled_at,last_reason)
    VALUES(?1,?2,'accepted',?3,?4,?4,?5,?4,?4,'history_reconciled')`).bind(deliveryKey,date,"1".repeat(64),`${date}T08:00:00.000Z`,`message-${date}`).run();
  for(let slot=1;slot<=slots;slot++){await db.prepare(`INSERT INTO email_feedback_stories(delivery_key,slot,payload_sha256,story_sha256,discovery_key,display_title,kind,topic_version,topics_json,issued_at,expires_at,key_id,relevant_digest,not_relevant_digest)
      VALUES(?1,?2,?3,?4,?5,'Cleanup fixture','analyzed',1,'["ai_ml"]','2025-01-01T08:00:00.000Z',?6,'active',?7,?8)`).bind(deliveryKey,slot,"1".repeat(64),String(slot).repeat(64),`${slot}`.repeat(64),expiresAt,"c".repeat(64),"d".repeat(64)).run();
    await db.prepare(`INSERT INTO email_feedback_votes(delivery_key,slot,rating,revision,capability_digest,created_at,updated_at)
      VALUES(?1,?2,'relevant',1,?3,'2025-01-02T08:00:00.000Z','2025-01-02T08:00:00.000Z')`).bind(deliveryKey,slot,"c".repeat(64)).run();}}
export default{async fetch(request:Request,env:Env){await setup(env.DB);const url=new URL(request.url);const identity=deliveryIdentity(new Date("2026-11-12T08:00:00.000Z"));
  if(url.pathname==="/cleanup"){for(let day=1;day<=21;day++)await seedCleanupGroup(env.DB,`2025-01-${String(day).padStart(2,"0")}`,"2025-02-01T08:00:00.000Z");
    await seedCleanupGroup(env.DB,"2025-01-22","2025-02-01T08:00:00.000Z");
    await env.DB.prepare(`INSERT INTO email_feedback_stories(delivery_key,slot,payload_sha256,story_sha256,discovery_key,display_title,kind,topic_version,topics_json,issued_at,expires_at,key_id,relevant_digest,not_relevant_digest)
      VALUES('daily-digest/2025-01-22',2,?1,?2,?3,'Cleanup fixture','analyzed',1,'["ai_ml"]','2025-01-01T08:00:00.000Z','2027-12-01T08:00:00.000Z','active',?4,?5)`).bind("1".repeat(64),"2".repeat(64),"2".repeat(64),"c".repeat(64),"d".repeat(64)).run();
    await env.DB.prepare(`INSERT INTO email_feedback_votes(delivery_key,slot,rating,revision,capability_digest,created_at,updated_at)
      VALUES('daily-digest/2025-01-22',2,'relevant',1,?1,'2025-01-02T08:00:00.000Z','2025-01-02T08:00:00.000Z')`).bind("c".repeat(64)).run();
    const store=new D1EmailFeedbackStore(env.DB),first=await store.pruneExpired("2026-11-12T00:00:00.000Z"),second=await store.pruneExpired("2026-11-12T00:00:00.000Z"),third=await store.pruneExpired("2026-11-12T00:00:00.000Z");
    await seedCleanupGroup(env.DB,"2025-02-01","2025-03-01T08:00:00.000Z");
    await env.DB.prepare("CREATE TRIGGER local_cleanup_failure BEFORE DELETE ON email_feedback_votes BEGIN SELECT RAISE(ABORT,'local cleanup failure'); END").run();
    let rollback=false;try{await store.pruneExpired("2026-11-12T00:00:00.000Z");}catch{rollback=true;}await env.DB.prepare("DROP TRIGGER local_cleanup_failure").run();
    const mixed=await env.DB.prepare("SELECT count(*) count FROM email_feedback_stories WHERE delivery_key='daily-digest/2025-01-22'").first<{count:number}>();
    const rollbackRows=await env.DB.prepare("SELECT count(*) count FROM email_feedback_stories WHERE delivery_key='daily-digest/2025-02-01'").first<{count:number}>();
    return Response.json({first,second,third,mixed:mixed?.count,rollback,rollbackRows:rollbackRows?.count});}
  if(url.pathname==="/seed"){const cap=await createFeedbackCapability({deliveryKey:identity.key,slot:1,storySha256:"a".repeat(64),rating:"relevant",issuedAt:identity.scheduledAt},keyring,origin);
    const digest:any={mode:"degraded",reason:"ai_unavailable",cycleDate:identity.scheduledAt,items:[]};const frozen=await freezeDelivery(digest,identity,{from:"x",subject:"s",text:"t",html:"<p>h</p>"},"o@example.test");
    const ledger=new D1EmailDeliveryLedger(env.DB);const binding:any={deliveryKey:identity.key,slot:1,payloadSha256:frozen.payloadSha256,storySha256:"a".repeat(64),discoveryKey:"b".repeat(64),displayTitle:"Story",kind:"raw",topics:[],issuedAt:identity.scheduledAt,expiresAt:cap.claims.expiresAt,keyId:"fixture",relevantDigest:cap.digest,notRelevantDigest:"c".repeat(64)};
    await ledger.reserveWithBindings(frozen,[binding]);const claim=await ledger.claim(identity.key,"workerd");if(claim.kind!=="committed"||!claim.record.claim)throw new Error();await ledger.admitDispatch(claim.record.claim);await ledger.recordOutcome(claim.record.claim,frozen.payloadSha256,{kind:"accepted",id:"m1"});
    const result=await new D1EmailFeedbackStore(env.DB).recordVote({deliveryKey:identity.key,slot:1,payloadSha256:frozen.payloadSha256,storySha256:binding.storySha256,rating:"relevant",capabilityDigest:cap.digest,expectedRevision:0,now:"2026-11-12T09:00:00.000Z"});return Response.json(result);}
  const vote=await new D1EmailFeedbackStore(env.DB).readVote(identity.key,1);return Response.json(vote);
}};
