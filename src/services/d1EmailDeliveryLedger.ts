import {
  DeliveryStateUnavailableError,
  validateDeliveryRecord,
  type ClaimRef,
  type DeliveryKey,
  type DeliveryLedger,
  type DeliveryReason,
  type DeliveryRecord,
  type DispatchSlot,
  type FrozenDelivery,
  type MutationResult,
  type ResendOutcome,
} from "./emailDeliveryLedger.js";
import { bindingFromRow, type FeedbackStoryBinding } from "./d1EmailFeedbackStore.js";

interface DeliveryRow {
  delivery_key: DeliveryKey; logical_date: string; state: DeliveryRecord["state"];
  payload_version: number | null; content_json: string | null; payload_sha256: string;
  mode: FrozenDelivery["mode"] | null; reason: FrozenDelivery["reason"] | null; aliases_json: string | null;
  created_at: string; updated_at: string; first_provider_attempt_at: string | null;
  last_provider_attempt_at: string | null; retry_before: string | null; claim_token: string | null;
  claim_generation: number; lease_until: string | null; dispatch_evidence_json: string;
  provider_message_id: string | null; accepted_at: string | null; reconciled_at: string | null;
  last_reason: DeliveryReason;
}

const selectRow = `SELECT delivery_key,logical_date,state,payload_version,content_json,payload_sha256,mode,reason,aliases_json,
  created_at,updated_at,first_provider_attempt_at,last_provider_attempt_at,retry_before,claim_token,claim_generation,
  lease_until,dispatch_evidence_json,provider_message_id,accepted_at,reconciled_at,last_reason FROM email_deliveries`;

function parseJson<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T; } catch { throw new DeliveryStateUnavailableError(); }
}

function fromRow(row: DeliveryRow): DeliveryRecord {
  const slots = parseJson<DispatchSlot[]>(row.dispatch_evidence_json, "dispatch journal");
  const frozen = row.content_json === null ? null : (() => {
    const value = parseJson<{ scheduledAt: string; content: FrozenDelivery["content"] }>(row.content_json, "frozen content");
    return {
      identity: { key: row.delivery_key, logicalDate: row.logical_date, scheduledAt: value.scheduledAt },
      payloadVersion: row.payload_version as 1,
      content: value.content,
      payloadSha256: row.payload_sha256,
      mode: row.mode!, reason: row.reason!,
      aliases: parseJson<string[]>(row.aliases_json!, "aliases"),
    } satisfies FrozenDelivery;
  })();
  const record: DeliveryRecord = {
    key: row.delivery_key, logicalDate: row.logical_date, payloadSha256: row.payload_sha256, frozen,
    state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
    firstProviderAttemptAt: row.first_provider_attempt_at, lastProviderAttemptAt: row.last_provider_attempt_at,
    retryBefore: row.retry_before,
    claim: row.claim_token === null ? null : { key: row.delivery_key, token: row.claim_token, generation: row.claim_generation },
    leaseUntil: row.lease_until, slots, providerMessageId: row.provider_message_id,
    acceptedAt: row.accepted_at, reconciledAt: row.reconciled_at, lastReason: row.last_reason,
  };
  validateDeliveryRecord(record);
  return record;
}

type SessionDatabase = D1Database & { withSession?: (constraint: "first-primary") => D1Database };

export class D1EmailDeliveryLedger implements DeliveryLedger {
  constructor(private readonly database: D1Database) {}

  private primary(): D1Database {
    const database = this.database as SessionDatabase;
    return database.withSession?.("first-primary") ?? database;
  }

  async read(key: DeliveryKey): Promise<DeliveryRecord | null> {
    try {
      const row = await this.primary().prepare(`${selectRow} WHERE delivery_key=?1`).bind(key).first<DeliveryRow>();
      return row ? fromRow(row) : null;
    } catch (error) {
      if (error instanceof DeliveryStateUnavailableError) throw error;
      throw new DeliveryStateUnavailableError();
    }
  }

  private classifyReservation(existing: DeliveryRecord, frozen: FrozenDelivery): MutationResult {
    return existing.payloadSha256 === frozen.payloadSha256
      ? { kind: "committed", record: existing }
      : { kind: "superseded", record: existing };
  }

  private async insertReservation(frozen: FrozenDelivery): Promise<void> {
    const content = JSON.stringify({ scheduledAt: frozen.identity.scheduledAt, content: frozen.content });
    await this.database.prepare(`INSERT INTO email_deliveries(
      delivery_key,logical_date,state,payload_version,content_json,payload_sha256,mode,reason,aliases_json,
      created_at,updated_at,dispatch_evidence_json,last_reason
    ) VALUES(?1,?2,'prepared',1,?3,?4,?5,?6,?7,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'[]','prepared')`)
      .bind(frozen.identity.key, frozen.identity.logicalDate, content, frozen.payloadSha256,
        frozen.mode, frozen.reason, JSON.stringify(frozen.aliases)).run();
  }

  async reserve(frozen: FrozenDelivery): Promise<MutationResult> {
    let firstError = false;
    try { await this.insertReservation(frozen); }
    catch { firstError = true; }
    let existing = await this.read(frozen.identity.key);
    if (existing) return this.classifyReservation(existing, frozen);
    if (!firstError) throw new DeliveryStateUnavailableError();
    try { await this.insertReservation(frozen); } catch { /* authoritative final read decides */ }
    existing = await this.read(frozen.identity.key);
    if (!existing) throw new DeliveryStateUnavailableError();
    return this.classifyReservation(existing, frozen);
  }

  async reserveWithBindings(frozen: FrozenDelivery, bindings: readonly FeedbackStoryBinding[]): Promise<MutationResult> {
    if (bindings.length<1 || bindings.length>4 || bindings.some((b,i)=>b.deliveryKey!==frozen.identity.key || b.payloadSha256!==frozen.payloadSha256 || b.slot!==i+1)) {
      throw new DeliveryStateUnavailableError();
    }
    const content=JSON.stringify({scheduledAt:frozen.identity.scheduledAt,content:frozen.content});
    try {
      await this.database.batch([
        this.database.prepare(`INSERT INTO email_deliveries(delivery_key,logical_date,state,payload_version,content_json,payload_sha256,mode,reason,aliases_json,created_at,updated_at,dispatch_evidence_json,last_reason)
          VALUES(?1,?2,'prepared',1,?3,?4,?5,?6,?7,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'[]','prepared')`)
          .bind(frozen.identity.key,frozen.identity.logicalDate,content,frozen.payloadSha256,frozen.mode,frozen.reason,JSON.stringify(frozen.aliases)),
        ...bindings.map(b=>this.database.prepare(`INSERT INTO email_feedback_stories(delivery_key,slot,payload_sha256,story_sha256,discovery_key,display_title,kind,topic_version,topics_json,issued_at,expires_at,key_id,relevant_digest,not_relevant_digest)
          VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,?13)`).bind(b.deliveryKey,b.slot,b.payloadSha256,b.storySha256,b.discoveryKey,b.displayTitle,b.kind,JSON.stringify(b.topics),b.issuedAt,b.expiresAt,b.keyId,b.relevantDigest,b.notRelevantDigest)),
      ]);
    } catch { /* authoritative complete-set read decides */ }
    const existing=await this.read(frozen.identity.key);
    if (!existing) throw new DeliveryStateUnavailableError();
    if (existing.payloadSha256!==frozen.payloadSha256) return {kind:"superseded",record:existing};
    try {
      const rows=await this.primary().prepare(`SELECT delivery_key,slot,payload_sha256,story_sha256,discovery_key,display_title,kind,topics_json,issued_at,expires_at,key_id,relevant_digest,not_relevant_digest
        FROM email_feedback_stories WHERE delivery_key=?1 ORDER BY slot`).bind(frozen.identity.key).all<any>();
      const actual=rows.results.map(bindingFromRow);
      const canonical=(b:FeedbackStoryBinding)=>JSON.stringify({deliveryKey:b.deliveryKey,slot:b.slot,payloadSha256:b.payloadSha256,
        storySha256:b.storySha256,discoveryKey:b.discoveryKey,displayTitle:b.displayTitle,kind:b.kind,topics:[...b.topics],issuedAt:b.issuedAt,
        expiresAt:b.expiresAt,keyId:b.keyId,relevantDigest:b.relevantDigest,notRelevantDigest:b.notRelevantDigest});
      if (actual.length!==bindings.length || actual.some((value,index)=>canonical(value)!==canonical(bindings[index]!))) throw new DeliveryStateUnavailableError();
    } catch (error) { if (error instanceof DeliveryStateUnavailableError) throw error; throw new DeliveryStateUnavailableError(); }
    return {kind:"committed",record:existing};
  }

  private async updateClaim(key: DeliveryKey, token: string): Promise<void> {
    await this.database.prepare(`UPDATE email_deliveries SET
      state='attempting',claim_token=?1,claim_generation=claim_generation+1,
      lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_reason='claimed'
      WHERE delivery_key=?2 AND state IN ('prepared','ambiguous','attempting')
        AND last_reason NOT IN ('payload_conflict','integrity_hold')
        AND (claim_token IS NULL OR lease_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(token, key).run();
  }

  async claim(key: DeliveryKey, token: string): Promise<MutationResult> {
    if (!token || new TextEncoder().encode(token).byteLength > 256) return { kind: "blocked", reason: "integrity_hold" };
    try { await this.updateClaim(key, token); } catch { /* authoritative read decides */ }
    let record = await this.read(key);
    if (!record) return { kind: "blocked", reason: "integrity_hold" };
    if (record.claim?.token === token) return { kind: "committed", record };
    if (record.claim && record.leaseUntil && record.leaseUntil > new Date().toISOString()) return { kind: "blocked", reason: "in_progress" };
    if (["accepted", "confirmed_failed"].includes(record.state) || record.lastReason === "integrity_hold" || record.lastReason === "payload_conflict") {
      return { kind: "blocked", reason: record.state === "accepted" ? "already_accepted" : "integrity_hold" };
    }
    try { await this.updateClaim(key, token); } catch { /* final authoritative read decides */ }
    record = await this.read(key);
    if (record?.claim?.token === token) return { kind: "committed", record };
    return { kind: "blocked", reason: record?.claim ? "in_progress" : "ledger_unavailable" };
  }

  private slot(record: DeliveryRecord, token: string): DispatchSlot | undefined {
    return record.slots.find(slot => slot.token === token);
  }

  private owns(record: DeliveryRecord, ref: ClaimRef): boolean {
    return record.claim?.token === ref.token && record.claim.generation === ref.generation;
  }

  private async appendDispatch(ref: ClaimRef): Promise<void> {
    await this.database.prepare(`UPDATE email_deliveries SET
      dispatch_evidence_json=json_insert(dispatch_evidence_json,'$[#]',json_object(
        'token',?1,'admittedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'evidence','uncertain','outcome','pending')),
      first_provider_attempt_at=coalesce(first_provider_attempt_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_provider_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      retry_before=coalesce(retry_before,strftime('%Y-%m-%dT%H:%M:%fZ','now','+23 hours')),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_reason='dispatch_admitted'
      WHERE delivery_key=?2 AND claim_token=?1 AND claim_generation=?3 AND state='attempting'
        AND last_reason NOT IN ('payload_conflict','integrity_hold')
        AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_array_length(dispatch_evidence_json)<3
        AND (retry_before IS NULL OR retry_before>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND NOT EXISTS (SELECT 1 FROM json_each(dispatch_evidence_json) WHERE json_extract(value,'$.token')=?1)`)
      .bind(ref.token, ref.key, ref.generation).run();
  }

  async admitDispatch(ref: ClaimRef): Promise<MutationResult> {
    let record = await this.read(ref.key);
    if (!record) return { kind: "blocked", reason: "integrity_hold" };
    if (record.lastReason === "payload_conflict" || record.lastReason === "integrity_hold") {
      return { kind: "blocked", reason: "integrity_hold" };
    }
    const existing = this.slot(record, ref.token);
    if (existing) return { kind: this.owns(record, ref) ? "committed" : "superseded", record };
    if (!this.owns(record, ref)) return { kind: "blocked", reason: record.claim ? "in_progress" : "integrity_hold" };
    try { await this.appendDispatch(ref); } catch { /* authoritative read decides */ }
    record = await this.read(ref.key);
    if (!record) return { kind: "blocked", reason: "ledger_unavailable" };
    if (this.slot(record, ref.token)) return { kind: this.owns(record, ref) ? "committed" : "superseded", record };
    if (!this.owns(record, ref)) return { kind: "blocked", reason: "in_progress" };
    if (record.slots.length >= 3 || (record.retryBefore && record.retryBefore <= new Date().toISOString())) {
      return { kind: "blocked", reason: "recovery_required" };
    }
    try { await this.appendDispatch(ref); } catch { /* final authoritative read decides */ }
    record = await this.read(ref.key);
    if (record && this.slot(record, ref.token)) return { kind: "committed", record };
    return { kind: "blocked", reason: "ledger_unavailable" };
  }

  async verifyDispatch(ref: ClaimRef): Promise<{ record: DeliveryRecord; databaseNow: string }> {
    const database = this.primary();
    try {
      const row = await database.prepare(`${selectRow} WHERE delivery_key=?1`).bind(ref.key).first<DeliveryRow>();
      const time = await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now").first<{ database_now: string }>();
      if (!row || !time || !time.database_now) throw new DeliveryStateUnavailableError();
      const record = fromRow(row);
      if (!this.owns(record, ref) || !this.slot(record, ref.token)) throw new DeliveryStateUnavailableError();
      return { record, databaseNow: time.database_now };
    } catch (error) {
      if (error instanceof DeliveryStateUnavailableError) throw error;
      throw new DeliveryStateUnavailableError();
    }
  }

  private async removeUndispatched(ref: ClaimRef, record: DeliveryRecord): Promise<void> {
    const remaining = record.slots.filter(slot => slot.token !== ref.token);
    const empty = remaining.length === 0;
    await this.database.prepare(`UPDATE email_deliveries SET
      state=?1,dispatch_evidence_json=?2,
      first_provider_attempt_at=?3,last_provider_attempt_at=?4,retry_before=?5,
      claim_token=NULL,lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_reason='cancelled_before_dispatch'
      WHERE delivery_key=?6 AND claim_token=?7 AND claim_generation=?8 AND state='attempting'
        AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND dispatch_evidence_json=?9`)
      .bind(empty ? "prepared" : "ambiguous", JSON.stringify(remaining),
        empty ? null : record.firstProviderAttemptAt,
        empty ? null : remaining.at(-1)!.admittedAt,
        empty ? null : record.retryBefore,
        ref.key, ref.token, ref.generation, JSON.stringify(record.slots)).run();
  }

  async cancelUndispatched(ref: ClaimRef): Promise<MutationResult> {
    let record = await this.read(ref.key);
    if (!record || !this.owns(record, ref)) return { kind: "blocked", reason: "integrity_hold" };
    const slot = this.slot(record, ref.token);
    if (!slot || slot.evidence !== "uncertain" || slot.outcome !== "pending") return { kind: "blocked", reason: "integrity_hold" };
    try { await this.removeUndispatched(ref, record); } catch { /* authoritative read decides */ }
    const after = await this.read(ref.key);
    if (!after) return { kind: "blocked", reason: "ledger_unavailable" };
    if (!this.slot(after, ref.token) && !this.owns(after, ref)) return { kind: "committed", record: after };
    return { kind: "blocked", reason: "ledger_unavailable" };
  }
  private outcomeSlots(record: DeliveryRecord, ref: ClaimRef, outcome: ResendOutcome): DispatchSlot[] {
    return record.slots.map(slot => slot.token !== ref.token ? slot : {
      ...slot,
      evidence: "dispatched" as const,
      outcome: outcome.kind === "accepted" ? "accepted" as const
        : outcome.kind === "rejected" ? "rejected" as const
          : outcome.kind === "payload_conflict" ? "payload_conflict" as const : "ambiguous" as const,
    });
  }

  private async persistOutcome(ref: ClaimRef, record: DeliveryRecord, outcome: ResendOutcome): Promise<void> {
    const soleRejection = outcome.kind === "rejected" && record.slots.length === 1 && this.owns(record, ref);
    const state = outcome.kind === "accepted" ? "accepted" : soleRejection ? "confirmed_failed" : "ambiguous";
    const reason: DeliveryReason = outcome.kind === "accepted" ? "provider_accepted"
      : outcome.kind === "rejected" ? (soleRejection ? "provider_rejected" : "provider_ambiguous")
        : outcome.kind === "payload_conflict" ? "payload_conflict" : "provider_ambiguous";
    const slots = JSON.stringify(this.outcomeSlots(record, ref, outcome));
    await this.database.prepare(`UPDATE email_deliveries SET
      state=?1,dispatch_evidence_json=?2,provider_message_id=?3,
      accepted_at=CASE WHEN ?1='accepted' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
      claim_token=NULL,lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_reason=?4
      WHERE delivery_key=?5 AND payload_sha256=?6 AND dispatch_evidence_json=?7
        AND state IN ('attempting','ambiguous')
        AND last_reason NOT IN ('payload_conflict','integrity_hold')
        AND EXISTS (SELECT 1 FROM json_each(dispatch_evidence_json) WHERE json_extract(value,'$.token')=?8)
        AND (?1='accepted' OR (claim_token=?8 AND claim_generation=?9))`)
      .bind(state, slots, outcome.kind === "accepted" ? outcome.id : null, reason,
        ref.key, record.payloadSha256, JSON.stringify(record.slots), ref.token, ref.generation).run();
  }

  private async persistPayloadConflict(ref: ClaimRef, record: DeliveryRecord): Promise<void> {
    const slots = JSON.stringify(this.outcomeSlots(record, ref, { kind: "payload_conflict" }));
    await this.database.prepare(`UPDATE email_deliveries SET
      state='ambiguous',dispatch_evidence_json=?1,provider_message_id=NULL,accepted_at=NULL,
      claim_token=NULL,lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_reason='payload_conflict'
      WHERE delivery_key=?2 AND payload_sha256=?3 AND dispatch_evidence_json=?4
        AND state IN ('attempting','ambiguous')
        AND last_reason NOT IN ('payload_conflict','integrity_hold')
        AND provider_message_id IS NULL AND accepted_at IS NULL
        AND EXISTS (SELECT 1 FROM json_each(dispatch_evidence_json)
          WHERE json_extract(value,'$.token')=?5 AND json_extract(value,'$.outcome')='pending')`)
      .bind(slots, ref.key, record.payloadSha256, JSON.stringify(record.slots), ref.token).run();
  }

  async recordOutcome(ref: ClaimRef, hash: string, outcome: ResendOutcome): Promise<MutationResult> {
    let record = await this.read(ref.key);
    if (!record) return { kind: "blocked", reason: "integrity_hold" };
    if (record.payloadSha256 !== hash) return { kind: "blocked", reason: "payload_conflict" };
    if (record.state === "accepted") {
      if (outcome.kind === "accepted" && outcome.id === record.providerMessageId) return { kind: "committed", record };
      return outcome.kind === "accepted" ? { kind: "blocked", reason: "integrity_hold" } : { kind: "superseded", record };
    }
    const existing = this.slot(record, ref.token);
    if (!existing) return { kind: "blocked", reason: "integrity_hold" };
    if (record.lastReason === "payload_conflict" || record.lastReason === "integrity_hold") {
      return outcome.kind === "payload_conflict" && existing.outcome === "payload_conflict"
        ? { kind: "committed", record }
        : { kind: "blocked", reason: "integrity_hold" };
    }
    if (outcome.kind !== "accepted" && outcome.kind !== "payload_conflict" && !this.owns(record, ref)) {
      return { kind: "blocked", reason: "in_progress" };
    }
    try {
      if (outcome.kind === "payload_conflict") await this.persistPayloadConflict(ref, record);
      else await this.persistOutcome(ref, record, outcome);
    } catch { /* authoritative read decides */ }
    let after = await this.read(ref.key);
    if (!after) return { kind: "blocked", reason: "ledger_unavailable" };
    if (after.state === "accepted") {
      if (outcome.kind === "accepted" && after.providerMessageId === outcome.id) return { kind: "committed", record: after };
      return outcome.kind === "accepted" ? { kind: "blocked", reason: "integrity_hold" } : { kind: "superseded", record: after };
    }
    const slot = this.slot(after, ref.token);
    if (after.lastReason === "payload_conflict" || after.lastReason === "integrity_hold") {
      return outcome.kind === "payload_conflict" && slot?.outcome === "payload_conflict"
        ? { kind: "committed", record: after }
        : { kind: "blocked", reason: "integrity_hold" };
    }
    if (slot && slot.outcome !== "pending") return { kind: "committed", record: after };
    if (outcome.kind === "accepted" || outcome.kind === "payload_conflict") {
      try {
        if (outcome.kind === "payload_conflict") await this.persistPayloadConflict(ref, after);
        else await this.persistOutcome(ref, after, outcome);
      } catch { /* final read decides */ }
      after = await this.read(ref.key);
      if (outcome.kind === "accepted" && after?.state === "accepted" && after.providerMessageId === outcome.id) {
        return { kind: "committed", record: after };
      }
      const afterSlot = after && this.slot(after, ref.token);
      if (outcome.kind === "payload_conflict" && after?.lastReason === "payload_conflict"
        && afterSlot?.outcome === "payload_conflict") return { kind: "committed", record: after };
    }
    return { kind: "blocked", reason: "ledger_unavailable" };
  }

  private async repair(record: DeliveryRecord): Promise<void> {
    if (record.state !== "accepted" || !record.frozen || !record.acceptedAt || !record.providerMessageId) {
      throw new DeliveryStateUnavailableError();
    }
    const statements = record.frozen.aliases.map(alias => this.database.prepare(`INSERT OR IGNORE INTO notifications(
      normalized_url,channel,sent_at,provider_message_id)
      SELECT ?1,'email',?2,?3 WHERE EXISTS (
        SELECT 1 FROM email_deliveries WHERE delivery_key=?4 AND state='accepted' AND payload_sha256=?5
          AND accepted_at=?2 AND provider_message_id=?3)`)
      .bind(alias, record.acceptedAt, record.providerMessageId, record.key, record.payloadSha256));
    statements.push(this.database.prepare(`UPDATE email_deliveries SET
      reconciled_at=coalesce(reconciled_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_reason='history_reconciled'
      WHERE delivery_key=?1 AND state='accepted' AND payload_sha256=?2 AND accepted_at=?3 AND provider_message_id=?4`)
      .bind(record.key, record.payloadSha256, record.acceptedAt, record.providerMessageId));
    await this.database.batch(statements);
  }

  async reconcileAccepted(key: DeliveryKey): Promise<MutationResult> {
    let record = await this.read(key);
    if (!record || record.state !== "accepted") return { kind: "blocked", reason: "integrity_hold" };
    if (record.reconciledAt) return { kind: "committed", record };
    try { await this.repair(record); } catch { /* authoritative read decides */ }
    record = await this.read(key);
    if (record?.state === "accepted" && record.reconciledAt) return { kind: "committed", record };
    return { kind: "blocked", reason: "history_pending" };
  }

  async reconcileOneOlder(logicalDate: string): Promise<void> {
    let row: { delivery_key: DeliveryKey } | null;
    try {
      row = await this.primary().prepare(`SELECT delivery_key FROM email_deliveries
        WHERE state='accepted' AND reconciled_at IS NULL AND logical_date<?1
        ORDER BY accepted_at ASC,delivery_key ASC LIMIT 1`).bind(logicalDate).first<{ delivery_key: DeliveryKey }>();
    } catch { throw new DeliveryStateUnavailableError(); }
    if (row) await this.reconcileAccepted(row.delivery_key);
  }
}
