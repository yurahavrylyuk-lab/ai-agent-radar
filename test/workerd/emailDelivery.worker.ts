import { D1EmailDeliveryLedger } from "../../src/services/d1EmailDeliveryLedger.js";
import { deliveryIdentity, freezeDelivery, type DeliveryKey } from "../../src/services/emailDeliveryLedger.js";
import { createDailyEmailContext, recoverDailyDelivery, type DailyDeliveryDependencies } from "../../src/services/notificationOrchestrator.js";
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
async function proposal(date: string, subject: string) {
  return freezeDelivery(digest(date), identity(date), { from: sender, subject, text: subject, html: `<p>${subject}</p>` }, recipient);
}
async function aliasedProposal(date: string, subject: string) {
  const url = "https://example.test/story#source";
  const value: PreparedDailyDigest = { mode: "degraded", reason: "ai_unavailable", cycleDate: `${date}T08:00:00.000Z`, items: [{
    kind: "raw", candidate: { candidateId: "c1", source: { title: "Story", url }, normalizedUrl: url,
      aliasKey: "https://example.test/story", aliases: [url], provenance: [{ kind: "brave", queryOrdinal: 1, resultOrdinal: 1 }] },
  }] };
  return freezeDelivery(value, identity(date), { from: sender, subject, text: subject, html: `<p>${subject}</p>` }, recipient);
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
    acceptedAt: record.acceptedAt, reconciled: record.reconciledAt !== null, claim: record.claim?.token ?? null };
}

async function admit(ledger: D1EmailDeliveryLedger, date: string, token: string) {
  const claimed = await ledger.claim(key(date), token);
  if (claimed.kind !== "committed" || !claimed.record.claim) throw new Error("claim failed");
  const admitted = await ledger.admitDispatch(claimed.record.claim);
  if (admitted.kind !== "committed") throw new Error("admission failed");
  return claimed.record.claim;
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
