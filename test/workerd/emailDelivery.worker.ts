import { D1EmailDeliveryLedger } from "../../src/services/d1EmailDeliveryLedger.js";
import { deliveryIdentity, freezeDelivery, type DeliveryKey } from "../../src/services/emailDeliveryLedger.js";
import { createDailyEmailContext, finalizeDailyDigest, recoverDailyDelivery, type DailyDeliveryDependencies } from "../../src/services/notificationOrchestrator.js";
import { sendFrozenWithResend } from "../../src/tools/email/resend.js";
import type { PreparedDailyDigest } from "../../src/types/index.js";
// @ts-expect-error local Workerd harness imports reviewed migrations as text.
import initial from "../../migrations/0001_initial.sql";
// @ts-expect-error local Workerd harness imports reviewed migrations as text.
import ledgerMigration from "../../migrations/0010_email_delivery_ledger.sql";

interface Env { DB: D1Database }
const recipient = "owner@example.test";
const sender = "AI Radar <radar@example.test>";

async function setup(db: D1Database): Promise<void> {
  if (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_deliveries'").first()) return;
  const apply = async (sql: string) => {
    const statements = sql.trim().split(/\n\s*\n/).map(statement => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();
  };
  await apply(initial);
  await apply(ledgerMigration);
}

function identity(date: string) { return deliveryIdentity(new Date(`${date}T08:00:00.000Z`)); }
function digest(date: string): PreparedDailyDigest {
  return { mode: "status_only", reason: "no_eligible_stories", cycleDate: `${date}T08:00:00.000Z`, items: [] };
}
function aliasedDigest(date: string): PreparedDailyDigest {
  const url = "https://example.test/story#source";
  return { mode: "degraded", reason: "ai_unavailable", cycleDate: `${date}T08:00:00.000Z`, items: [{
    kind: "raw", candidate: { candidateId: "c1", source: { title: "Story", url }, normalizedUrl: url,
      aliasKey: "https://example.test/story", aliases: [url], provenance: [{ kind: "brave", queryOrdinal: 1, resultOrdinal: 1 }] },
  }] };
}
async function proposal(date: string, subject: string) {
  return freezeDelivery(digest(date), identity(date), { from: sender, subject, text: subject, html: `<p>${subject}</p>` }, recipient);
}
async function aliasedProposal(date: string, subject: string) {
  return freezeDelivery(aliasedDigest(date), identity(date), { from: sender, subject, text: subject, html: `<p>${subject}</p>` }, recipient);
}
function key(date: string): DeliveryKey { return `daily-digest/${date}`; }
function dependencies(db: D1Database, date: string, target: string): DailyDeliveryDependencies {
  return {
    context: createDailyEmailContext(), identity: identity(date), ledger: new D1EmailDeliveryLedger(db), recipient, sender,
    sendFrozen: (body, deliveryKey) => sendFrozenWithResend(body, deliveryKey, {
      environment: { RESEND_API_KEY: "loopback-only" }, fetchImplementation: (_input, init) => {
        const url = new URL(target);
        if (url.hostname !== "127.0.0.1") throw new Error("Harness refuses non-loopback traffic.");
        return globalThis.fetch(url, init);
      },
    }),
  };
}
function summary(record: Awaited<ReturnType<D1EmailDeliveryLedger["read"]>>) {
  return record && { state: record.state, hash: record.payloadSha256, slots: record.slots.length,
    outcomes: record.slots.map(slot => slot.outcome), first: record.firstProviderAttemptAt,
    retryBefore: record.retryBefore, providerMessageId: record.providerMessageId,
    acceptedAt: record.acceptedAt, reconciled: record.reconciledAt !== null, claim: record.claim?.token ?? null,
    lastReason: record.lastReason };
}

type FaultOperation = "reservation" | "claim" | "admission" | "ambiguous" | "accepted" | "reconciliation";
type FaultMode = "before" | "after" | "before_unreadable" | "after_unreadable";

class FaultStatement {
  constructor(readonly owner: FaultDatabase, readonly raw: D1PreparedStatement, readonly sql: string) {}
  bind(...values: unknown[]): FaultStatement { return new FaultStatement(this.owner, this.raw.bind(...values), this.sql); }
  async first<T>(): Promise<T | null> { this.owner.failRead(this.sql); return this.raw.first<T>(); }
  async all<T>(): Promise<D1Result<T>> { this.owner.failRead(this.sql); return this.raw.all<T>(); }
  async run(): Promise<D1Result> {
    this.owner.failMutation(this.sql, "before");
    const result = await this.raw.run();
    this.owner.failMutation(this.sql, "after");
    return result;
  }
}

class FaultDatabase {
  private mutationFailures: number;
  private readFailures: number;
  private triggered = false;
  constructor(readonly raw: D1Database, readonly operation: FaultOperation, readonly mode: FaultMode) {
    this.mutationFailures = mode.startsWith("before") ? 2 : 1;
    this.readFailures = mode.endsWith("unreadable") ? 12 : 0;
  }
  private matches(sql: string): boolean {
    if (this.operation === "reservation") return /^INSERT INTO email_deliveries/.test(sql);
    if (this.operation === "claim") return /^UPDATE email_deliveries SET\s+state='attempting'/.test(sql);
    if (this.operation === "admission") return /^UPDATE email_deliveries SET\s+dispatch_evidence_json=json_insert/.test(sql);
    if (this.operation === "ambiguous" || this.operation === "accepted") return /^UPDATE email_deliveries SET\s+state=\?1,dispatch_evidence_json/.test(sql);
    return false;
  }
  prepare(sql: string): FaultStatement { return new FaultStatement(this, this.raw.prepare(sql), sql); }
  withSession(_constraint: "first-primary"): FaultDatabase { return this; }
  failMutation(sql: string, phase: "before" | "after"): void {
    if (this.operation === "reconciliation" || !this.matches(sql) || !this.mode.startsWith(phase) || this.mutationFailures <= 0) return;
    this.mutationFailures -= 1; this.triggered = true;
    throw new Error(`simulated ${this.operation} ${phase} uncertainty`);
  }
  failRead(sql: string): void {
    if (!this.triggered || this.readFailures <= 0 || !/FROM email_deliveries/.test(sql)) return;
    this.readFailures -= 1;
    throw new Error(`simulated ${this.operation} authoritative read outage`);
  }
  async batch(statements: FaultStatement[]): Promise<D1Result[]> {
    if (this.operation === "reconciliation" && this.mode.startsWith("before") && this.mutationFailures > 0) {
      this.mutationFailures -= 1; this.triggered = true;
      throw new Error("simulated reconciliation before uncertainty");
    }
    const result = await this.raw.batch(statements.map(statement => statement.raw));
    if (this.operation === "reconciliation" && this.mode.startsWith("after") && this.mutationFailures > 0) {
      this.mutationFailures -= 1; this.triggered = true;
      throw new Error("simulated reconciliation after uncertainty");
    }
    return result;
  }
}

async function admit(ledger: D1EmailDeliveryLedger, date: string, token: string) {
  const claimed = await ledger.claim(key(date), token);
  if (claimed.kind !== "committed" || !claimed.record.claim) throw new Error("claim failed");
  const admitted = await ledger.admitDispatch(claimed.record.claim);
  if (admitted.kind !== "committed") throw new Error("admission failed");
  return claimed.record.claim;
}

async function runFaultCase(db: D1Database, date: string, operation: FaultOperation, mode: FaultMode) {
  const base = new D1EmailDeliveryLedger(db);
  const frozen = operation === "reconciliation" ? await aliasedProposal(date, `Fault ${date}`) : await proposal(date, `Fault ${date}`);
  let ref: Awaited<ReturnType<typeof admit>> | null = null;
  if (operation !== "reservation") await base.reserve(frozen);
  if (["admission", "ambiguous", "accepted", "reconciliation"].includes(operation)) {
    const claimed = await base.claim(key(date), `fault-${operation}`);
    if (claimed.kind !== "committed" || !claimed.record.claim) throw new Error("fault setup claim failed");
    ref = claimed.record.claim;
  }
  if (["ambiguous", "accepted", "reconciliation"].includes(operation)) {
    const admitted = await base.admitDispatch(ref!);
    if (admitted.kind !== "committed") throw new Error("fault setup admission failed");
  }
  if (operation === "reconciliation") {
    const accepted = await base.recordOutcome(ref!, frozen.payloadSha256, { kind: "accepted", id: `email-${date}` });
    if (accepted.kind !== "committed") throw new Error("fault setup acceptance failed");
  }

  const faulty = new D1EmailDeliveryLedger(new FaultDatabase(db, operation, mode) as unknown as D1Database);
  let resultKind = "threw";
  try {
    const result = operation === "reservation" ? await faulty.reserve(frozen)
      : operation === "claim" ? await faulty.claim(key(date), "fault-claim")
        : operation === "admission" ? await faulty.admitDispatch(ref!)
          : operation === "ambiguous" ? await faulty.recordOutcome(ref!, frozen.payloadSha256, { kind: "ambiguous", reason: "transport" })
            : operation === "accepted" ? await faulty.recordOutcome(ref!, frozen.payloadSha256, { kind: "accepted", id: `email-${date}` })
              : await faulty.reconcileAccepted(key(date));
    resultKind = result.kind;
  } catch { resultKind = "threw"; }

  const record = await base.read(key(date));
  const achieved = operation === "reservation" ? record !== null
    : operation === "claim" ? record?.claim?.token === "fault-claim"
      : operation === "admission" ? record?.slots.some(slot => slot.token === ref?.token) === true
        : operation === "ambiguous" ? record?.slots.some(slot => slot.token === ref?.token && slot.outcome === "ambiguous") === true
          : operation === "accepted" ? record?.state === "accepted" && record.providerMessageId === `email-${date}`
            : record?.reconciledAt !== null;
  return { operation, mode, resultKind, achieved };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await setup(env.DB);
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? "2026-11-04";
    const target = url.searchParams.get("target") ?? "";
    const ledger = new D1EmailDeliveryLedger(env.DB);
    if (url.pathname === "/read") return Response.json(summary(await ledger.read(key(date))));
    if (url.pathname === "/notifications") {
      const rows = await env.DB.prepare("SELECT normalized_url,provider_message_id FROM notifications ORDER BY normalized_url").all();
      return Response.json(rows.results);
    }
    if (url.pathname === "/expire-lease") {
      await env.DB.prepare("UPDATE email_deliveries SET lease_until='2020-01-01T00:00:00.000Z' WHERE delivery_key=?1 AND state='attempting'")
        .bind(key(date)).run();
      return Response.json(summary(await ledger.read(key(date))));
    }
    if (url.pathname === "/race") {
      const [left, right] = await Promise.all([ledger.reserve(await proposal(date, "Winner A")), ledger.reserve(await proposal(date, "Winner B"))]);
      const outcome = await recoverDailyDelivery(dependencies(env.DB, date, target));
      return Response.json({ reservations: [left.kind, right.kind].sort(), outcome, record: summary(await ledger.read(key(date))) });
    }
    if (url.pathname === "/seed-accepted") {
      const frozen = await aliasedProposal(date, "Accepted before history repair"); await ledger.reserve(frozen);
      const ref = await admit(ledger, date, "accepted-slot");
      const result = await ledger.recordOutcome(ref, frozen.payloadSha256, { kind: "accepted", id: "email-accepted" });
      return Response.json({ result: result.kind, record: summary(await ledger.read(key(date))) });
    }
    if (url.pathname === "/seed-ambiguous") {
      const frozen = await proposal(date, "Exact replay"); await ledger.reserve(frozen);
      const ref = await admit(ledger, date, `ambiguous-${crypto.randomUUID()}`);
      await ledger.recordOutcome(ref, frozen.payloadSha256, { kind: "ambiguous", reason: "transport" });
      return Response.json(summary(await ledger.read(key(date))));
    }
    if (url.pathname === "/recover") {
      const outcome = await recoverDailyDelivery(dependencies(env.DB, date, target));
      return Response.json({ outcome, record: summary(await ledger.read(key(date))) });
    }
    if (url.pathname === "/deliver") {
      const outcome = await finalizeDailyDigest(digest(date), dependencies(env.DB, date, target));
      return Response.json({ outcome, record: summary(await ledger.read(key(date))) });
    }
    if (url.pathname === "/deliver-fault") {
      const faultDb = new FaultDatabase(env.DB, "accepted", "after");
      const outcome = await finalizeDailyDigest(digest(date), dependencies(faultDb as unknown as D1Database, date, target));
      return Response.json({ outcome, record: summary(await ledger.read(key(date))) });
    }
    if (url.pathname === "/deliver-aliased-fault") {
      const faultDb = new FaultDatabase(env.DB, "reconciliation", "before");
      const outcome = await finalizeDailyDigest(aliasedDigest(date), dependencies(faultDb as unknown as D1Database, date, target));
      return Response.json({ outcome, record: summary(await ledger.read(key(date))) });
    }
    if (url.pathname === "/uncertainty-suite") {
      const operations: FaultOperation[] = ["reservation", "claim", "admission", "ambiguous", "accepted", "reconciliation"];
      const modes: FaultMode[] = ["before", "after", "before_unreadable", "after_unreadable"];
      const cases = [];
      let ordinal = 0;
      for (const operation of operations) for (const mode of modes) {
        ordinal += 1;
        const scenarioDate = `2026-12-${String(ordinal).padStart(2, "0")}`;
        cases.push(await runFaultCase(env.DB, scenarioDate, operation, mode));
      }
      return Response.json({ cases, providerRequests: 0 });
    }
    if (url.pathname === "/three-slots") {
      const frozen = await proposal(date, "Three slots"); await ledger.reserve(frozen);
      for (let ordinal = 1; ordinal <= 3; ordinal++) {
        const ref = await admit(ledger, date, `slot-${ordinal}`);
        await ledger.recordOutcome(ref, frozen.payloadSha256, { kind: "ambiguous", reason: "transport" });
      }
      const denied = await recoverDailyDelivery(dependencies(env.DB, date, target));
      return Response.json({ denied, record: summary(await ledger.read(key(date))) });
    }
    if (url.pathname === "/conflict") {
      const frozen = await proposal(date, "Conflict"); await ledger.reserve(frozen);
      const ref = await admit(ledger, date, "conflict-slot");
      const first = await ledger.recordOutcome(ref, frozen.payloadSha256, { kind: "accepted", id: "email-one" });
      const second = await ledger.recordOutcome(ref, frozen.payloadSha256, { kind: "accepted", id: "email-two" });
      return Response.json({ first: first.kind, second: second.kind, record: summary(await ledger.read(key(date))) });
    }
    if (url.pathname === "/cutoff") {
      const frozen = await proposal(date, "Expired cutoff"); await ledger.reserve(frozen);
      const ref = await admit(ledger, date, "expired-slot");
      await ledger.recordOutcome(ref, frozen.payloadSha256, { kind: "ambiguous", reason: "transport" });
      const before = await ledger.read(key(date));
      const trigger = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='email_deliveries_immutable_payload'").first<{ sql: string }>();
      if (!trigger?.sql) throw new Error("immutable trigger missing");
      await env.DB.prepare("DROP TRIGGER email_deliveries_immutable_payload").run();
      try { await env.DB.prepare("UPDATE email_deliveries SET first_provider_attempt_at='2020-01-01T00:00:00.000Z',last_provider_attempt_at='2020-01-01T00:00:00.000Z',retry_before='2020-01-01T23:00:00.000Z' WHERE delivery_key=?1").bind(key(date)).run(); }
      finally { await env.DB.prepare(trigger.sql).run(); }
      const denied = await recoverDailyDelivery(dependencies(env.DB, date, target));
      return Response.json({ denied, originalWindowHours: before?.retryBefore && before.firstProviderAttemptAt
        ? (new Date(before.retryBefore).getTime() - new Date(before.firstProviderAttemptAt).getTime()) / 3_600_000 : null,
        record: summary(await ledger.read(key(date))) });
    }
    if (url.pathname === "/stale-late-success") {
      const frozen = await proposal(date, "Late success"); await ledger.reserve(frozen);
      const stale = await admit(ledger, date, "stale-slot");
      await env.DB.prepare("UPDATE email_deliveries SET lease_until='2020-01-01T00:00:00.000Z' WHERE delivery_key=?1").bind(key(date)).run();
      const newer = await ledger.claim(key(date), "new-owner");
      if (newer.kind !== "committed") throw new Error("reclaim failed");
      const late = await ledger.recordOutcome(stale, frozen.payloadSha256, { kind: "accepted", id: "email-late" });
      const acceptedAt = (await ledger.read(key(date)))?.acceptedAt;
      const repeated = await ledger.recordOutcome(stale, frozen.payloadSha256, { kind: "accepted", id: "email-late" });
      const conflict = newer.record.claim
        ? await ledger.recordOutcome(newer.record.claim, frozen.payloadSha256, { kind: "accepted", id: "email-conflict" })
        : { kind: "blocked" as const };
      return Response.json({ late: late.kind, repeated: repeated.kind, conflict: conflict.kind,
        acceptedAtPreserved: acceptedAt === (await ledger.read(key(date)))?.acceptedAt, record: summary(await ledger.read(key(date))) });
    }
    return new Response("not found", { status: 404 });
  },
};
