import type { DeliveryKey } from "./emailDeliveryLedger.js";
import type { FeedbackRating } from "./emailFeedback.js";
import type { DiscoveryTopic } from "./discoveryPriority.js";
import type { FeedbackPreferenceObservation } from "./feedbackPreferences.js";

export interface FeedbackStoryBinding {
  deliveryKey: DeliveryKey; slot: 1|2|3|4; payloadSha256: string; storySha256: string; discoveryKey: string;
  displayTitle: string; kind: "analyzed"|"raw"; topics: readonly DiscoveryTopic[]; issuedAt: string; expiresAt: string;
  keyId: string; relevantDigest: string; notRelevantDigest: string;
}
export interface FeedbackVote { rating: FeedbackRating; revision: number; updatedAt: string }
export type VoteResult = { kind: "recorded"|"already_recorded"; vote: FeedbackVote } | { kind: "conflict"|"blocked"|"unavailable" };

interface BindingRow { delivery_key: DeliveryKey; slot: 1|2|3|4; payload_sha256: string; story_sha256: string; discovery_key: string;
  display_title: string; kind: "analyzed"|"raw"; topics_json: string; issued_at: string; expires_at: string; key_id: string;
  relevant_digest: string; not_relevant_digest: string }
interface VoteRow { rating: FeedbackRating; revision: number; updated_at: string }
type SessionDatabase = D1Database & { withSession?: (constraint: "first-primary") => D1Database };

const bindingSelect = `SELECT delivery_key,slot,payload_sha256,story_sha256,discovery_key,display_title,kind,topics_json,
  issued_at,expires_at,key_id,relevant_digest,not_relevant_digest FROM email_feedback_stories`;

export function bindingFromRow(row: BindingRow): FeedbackStoryBinding {
  let topics: DiscoveryTopic[];
  try { topics = JSON.parse(row.topics_json) as DiscoveryTopic[]; } catch { throw new Error("Feedback state unavailable."); }
  const allowed=["ai_ml","it_infrastructure","programming","developer_tools_workflow"];
  if (!Array.isArray(topics) || topics.length > 4 || topics.some((x,index) => !allowed.includes(x) || allowed.indexOf(x)<allowed.indexOf(topics[index-1]??allowed[0]!)) || new Set(topics).size !== topics.length) throw new Error("Feedback state unavailable.");
  const hex=(value:string)=>/^[0-9a-f]{64}$/.test(value),titleBytes=new TextEncoder().encode(row.display_title).byteLength;
  const issued=new Date(row.issued_at),expires=new Date(row.expires_at);
  if(![row.payload_sha256,row.story_sha256,row.discovery_key,row.relevant_digest,row.not_relevant_digest].every(hex)
    || ![1,2,3,4].includes(row.slot) || titleBytes<1 || titleBytes>256 || !["analyzed","raw"].includes(row.kind)
    || (row.kind==="raw"&&topics.length>0) || !Number.isFinite(issued.getTime()) || !Number.isFinite(expires.getTime())
    || issued.toISOString()!==row.issued_at || expires.toISOString()!==row.expires_at || expires.getTime()-issued.getTime()!==30*86_400_000
    || !/^[A-Za-z0-9_-]{1,32}$/.test(row.key_id)) throw new Error("Feedback state unavailable.");
  return { deliveryKey: row.delivery_key, slot: row.slot, payloadSha256: row.payload_sha256, storySha256: row.story_sha256,
    discoveryKey: row.discovery_key, displayTitle: row.display_title, kind: row.kind, topics, issuedAt: row.issued_at,
    expiresAt: row.expires_at, keyId: row.key_id, relevantDigest: row.relevant_digest, notRelevantDigest: row.not_relevant_digest };
}

export class D1EmailFeedbackStore {
  constructor(private readonly database: D1Database) {}
  private primary(): D1Database { const db=this.database as SessionDatabase; return db.withSession?.("first-primary") ?? db; }
  async readBinding(key: DeliveryKey, slot: number): Promise<FeedbackStoryBinding|null> {
    try { const row=await this.primary().prepare(`${bindingSelect} WHERE delivery_key=?1 AND slot=?2`).bind(key,slot).first<BindingRow>(); return row?bindingFromRow(row):null; }
    catch { throw new Error("Feedback state unavailable."); }
  }
  async readAcceptedBinding(key:DeliveryKey,slot:number):Promise<FeedbackStoryBinding|null>{
    try{const row=await this.primary().prepare(`SELECT s.delivery_key,s.slot,s.payload_sha256,s.story_sha256,s.discovery_key,s.display_title,s.kind,s.topics_json,
      s.issued_at,s.expires_at,s.key_id,s.relevant_digest,s.not_relevant_digest FROM email_feedback_stories s JOIN email_deliveries e ON e.delivery_key=s.delivery_key
      WHERE s.delivery_key=?1 AND s.slot=?2 AND e.state='accepted' AND e.payload_sha256=s.payload_sha256`).bind(key,slot).first<BindingRow>();
      return row?bindingFromRow(row):null;}catch{throw new Error("Feedback state unavailable.");}
  }
  async readVote(key: DeliveryKey, slot: number): Promise<FeedbackVote|null> {
    try { const row=await this.primary().prepare("SELECT rating,revision,updated_at FROM email_feedback_votes WHERE delivery_key=?1 AND slot=?2").bind(key,slot).first<VoteRow>();
      return row?{rating:row.rating,revision:row.revision,updatedAt:row.updated_at}:null; } catch { throw new Error("Feedback state unavailable."); }
  }
  async recordVote(input: { deliveryKey: DeliveryKey; slot: number; payloadSha256: string; storySha256: string; rating: FeedbackRating;
    capabilityDigest: string; expectedRevision: number; now: string }): Promise<VoteResult> {
    const { deliveryKey:k,slot:s,payloadSha256:p,storySha256:h,rating:r,capabilityDigest:d,expectedRevision:x,now }=input;
    let changed=false;
    try {
      if (x===0) {
        const result=await this.database.prepare(`INSERT INTO email_feedback_votes(delivery_key,slot,rating,revision,capability_digest,created_at,updated_at)
        SELECT s.delivery_key,s.slot,?1,1,?2,?3,?3 FROM email_feedback_stories s JOIN email_deliveries e ON e.delivery_key=s.delivery_key
        WHERE s.delivery_key=?4 AND s.slot=?5 AND s.payload_sha256=?6 AND s.story_sha256=?7 AND e.payload_sha256=s.payload_sha256
          AND e.state='accepted' AND ?3<=s.expires_at AND ?2=CASE ?1 WHEN 'relevant' THEN s.relevant_digest ELSE s.not_relevant_digest END
        ON CONFLICT(delivery_key,slot) DO NOTHING`).bind(r,d,now,k,s,p,h).run();
        changed=(result.meta?.changes??0)>0;
      } else {
        const result=await this.database.prepare(`UPDATE email_feedback_votes SET rating=?1,revision=revision+1,capability_digest=?2,updated_at=?3
        WHERE delivery_key=?4 AND slot=?5 AND revision=?6 AND rating<>?1 AND revision<10
          AND EXISTS(SELECT 1 FROM email_feedback_stories s JOIN email_deliveries e ON e.delivery_key=s.delivery_key
            WHERE s.delivery_key=?4 AND s.slot=?5 AND s.payload_sha256=?7 AND s.story_sha256=?8 AND e.payload_sha256=s.payload_sha256
              AND e.state='accepted' AND ?3<=s.expires_at AND ?2=CASE ?1 WHEN 'relevant' THEN s.relevant_digest ELSE s.not_relevant_digest END)`)
        .bind(r,d,now,k,s,x,p,h).run();
        changed=(result.meta?.changes??0)>0;
      }
    } catch { /* authoritative read classifies committed response loss */ }
    let vote: FeedbackVote|null;
    try { vote=await this.readVote(k,s); } catch { return {kind:"unavailable"}; }
    if (vote?.rating===r && (vote.revision===x+1 || (x===0 && vote.revision>=1))) return {kind: changed?"recorded":"already_recorded",vote};
    if (vote?.rating===r) return {kind:"already_recorded",vote};
    if (vote) return {kind:"conflict"};
    return {kind:"blocked"};
  }
  async pruneExpired(now: string): Promise<number> {
    const rows=await this.primary().prepare(`SELECT delivery_key FROM email_feedback_stories WHERE expires_at<?1
      GROUP BY delivery_key ORDER BY delivery_key LIMIT 20`).bind(new Date(new Date(now).getTime()-150*86_400_000).toISOString()).all<{delivery_key:DeliveryKey}>();
    for (const row of rows.results) {
      await this.database.batch([
        this.database.prepare("DELETE FROM email_feedback_events WHERE delivery_key=?1").bind(row.delivery_key),
        this.database.prepare("DELETE FROM email_feedback_votes WHERE delivery_key=?1").bind(row.delivery_key),
        this.database.prepare("DELETE FROM email_feedback_stories WHERE delivery_key=?1").bind(row.delivery_key),
      ]);
    }
    return rows.results.length;
  }
  async loadPreferenceObservations(now:string):Promise<FeedbackPreferenceObservation[]> {
    const cutoff=new Date(new Date(now).getTime()-90*86_400_000).toISOString().slice(0,10);
    try {
      const result=await this.primary().prepare(`WITH ranked AS (
        SELECT s.discovery_key,s.topics_json,v.rating,e.logical_date,s.delivery_key,s.slot,
          row_number() OVER(PARTITION BY s.discovery_key ORDER BY e.logical_date DESC,s.delivery_key DESC,s.slot DESC) ordinal
        FROM email_feedback_stories s JOIN email_feedback_votes v USING(delivery_key,slot)
        JOIN email_deliveries e USING(delivery_key) WHERE e.state='accepted' AND e.logical_date>=?1)
        SELECT discovery_key,topics_json,rating,logical_date,delivery_key,slot FROM ranked WHERE ordinal=1
        ORDER BY logical_date DESC,delivery_key DESC,slot DESC LIMIT 400`).bind(cutoff).all<any>();
      return result.results.map(row=>({discoveryKey:row.discovery_key,topics:JSON.parse(row.topics_json),rating:row.rating,
        logicalDate:row.logical_date,deliveryKey:row.delivery_key,slot:row.slot}));
    } catch { throw new Error("Feedback preferences unavailable."); }
  }
}
