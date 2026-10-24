import { parseBatchAnalysis } from "../../src/services/analysisAgent.js";
import { D1OpenAIFallbackUsageStore, type LunaReservation } from "../../src/services/d1OpenAIFallbackUsageStore.js";
import { parseCycleSnapshot, serializeCycleSnapshot, type AnalyzerFailoverObservation, type CycleSnapshotV1 } from "../../src/services/monitoringTelemetry.js";
import { requestLuna } from "../../src/tools/llm/openaiFallback.js";
import type { PreparedBatch } from "../../src/types/index.js";
// @ts-expect-error Wrangler's Text module rule supplies the migration string in this local-only harness.
import migration from "../../migrations/0009_openai_fallback_usage.sql";

interface Env { DB: D1Database; }
const cycles = {
  success: "a233dc6e-e951-4c7e-8f24-6cc7a91979f8",
  maximum: "b233dc6e-e951-4c7e-8f24-6cc7a91979f8",
  incomplete: "c233dc6e-e951-4c7e-8f24-6cc7a91979f8",
  timeout: "d233dc6e-e951-4c7e-8f24-6cc7a91979f8",
} as const;
const offsets = { success: 0, maximum: 10, incomplete: 20, timeout: 30 } as const;
const limits = { dailyRequests: 1, weeklyRequests: 7, monthlyRequests: 31, dailyTokens: 24576, weeklyTokens: 172032, monthlyTokens: 761856 };
const candidate = { candidateId: "c001", source: { title: "Safe title", url: "https://example.com/story", snippet: "Safe summary" }, normalizedUrl: "https://example.com/story", aliasKey: "https://example.com/story", aliases: ["https://example.com/story"], provenance: [{ kind: "brave" as const, queryOrdinal: 1, resultOrdinal: 1 }] };
const batch: PreparedBatch = { prompt: "bounded loopback prompt", promptBytes: 23, sizeExcluded: 0, truncationStage: "initial", snippetBytesLimit: 192, candidates: [candidate] };

async function setup(db: D1Database) {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='openai_fallback_usage'").first();
  if (exists) return;
  await db.exec("CREATE TABLE monitoring_cycles(cycle_id TEXT PRIMARY KEY,scheduled_at TEXT NOT NULL); CREATE TABLE gemini_usage_state(id INTEGER PRIMARY KEY,usage_unknown INTEGER NOT NULL); INSERT INTO gemini_usage_state VALUES(1,0); CREATE TABLE gemini_usage(id INTEGER PRIMARY KEY,model TEXT,timestamp TEXT,accounting_status TEXT,request_count INTEGER); CREATE TABLE monitoring_gemini_attempts(cycle_id TEXT,ordinal INTEGER,usage_id INTEGER,model TEXT,started_at TEXT,dispatch_status TEXT,failure_class TEXT,http_status INTEGER,accounting_status TEXT,accounting_error INTEGER,settlement_status TEXT,retry_decision TEXT,retry_reason TEXT); CREATE TABLE workerd_failover_snapshot(cycle_id TEXT PRIMARY KEY,value TEXT NOT NULL);");
  const statements = migration.trim().split(/(?=CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER))/).filter(Boolean);
  if (statements.length !== 6) throw new Error("local migration fixture could not parse reviewed 0009");
  for (const statement of statements) await db.prepare(statement).run();
}

async function ensureProof(db: D1Database, name: keyof typeof cycles) {
  const cycleId = cycles[name];
  if (await db.prepare("SELECT cycle_id FROM monitoring_cycles WHERE cycle_id=?1").bind(cycleId).first()) return;
  const scheduled = new Date(Date.now() - 1000).toISOString();
  await db.prepare("INSERT INTO monitoring_cycles VALUES(?1,?2)").bind(cycleId, scheduled).run();
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    const usageId = offsets[name] + ordinal;
    const at = new Date(Date.now() - 4000 + ordinal * 500).toISOString();
    await db.prepare("INSERT INTO gemini_usage(id,model,timestamp,accounting_status,request_count) VALUES(?1,'gemini-3.8-flash',?2,'confirmed_zero',1)").bind(usageId, at).run();
    await db.prepare("INSERT INTO monitoring_gemini_attempts VALUES(?1,?2,?3,'gemini-3.8-flash',?4,'observed','unavailable_503',503,'confirmed_zero',0,'settled',?5,?6)").bind(cycleId, ordinal, usageId, at, ordinal === 3 ? "stop" : "retry", ordinal === 3 ? "max_attempts" : "retryable_503").run();
  }
}

function snapshot(observation: AnalyzerFailoverObservation): CycleSnapshotV1 {
  return { version: 1, braveHealth: "healthy", rssHealth: "healthy", outage: false, candidateCounts: { received: 1, unique: 1, submitted: 1 }, geminiDispatchCount: 3, delivery: null, accounting: { reserved: 0, exact: 0, confirmedZero: 3, ambiguous: 0, unavailable: false }, analyzerFailover: observation };
}
async function read(db: D1Database, cycleId: string) {
  const row = await new D1OpenAIFallbackUsageStore(db).read(cycleId);
  const saved = await db.prepare("SELECT value FROM workerd_failover_snapshot WHERE cycle_id=?1").bind(cycleId).first<{ value: string }>();
  return { state: row?.state, dispatchStatus: row?.dispatchStatus, requestCount: row?.requestCount, totalTokens: row?.totalTokens, failureClass: row?.failureClass, telemetryFinalAnalyzer: saved ? parseCycleSnapshot(saved.value).analyzerFailover?.finalAnalyzer : null };
}
function reservation(row: Awaited<ReturnType<D1OpenAIFallbackUsageStore["read"]>>): LunaReservation {
  if (!row) throw new Error("missing fallback row");
  return { cycleId: row.cycleId, attemptId: row.attemptId, scheduledAt: row.scheduledAt, reservedAt: row.reservedAt };
}

async function execute(db: D1Database, name: keyof typeof cycles, target: string, concurrent = false) {
  await ensureProof(db, name);
  const store = new D1OpenAIFallbackUsageStore(db);
  let winners: LunaReservation[];
  if (concurrent) {
    const attempts = await Promise.allSettled([store.reserve(cycles[name], limits), store.reserve(cycles[name], limits)]);
    winners = attempts.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
  } else {
    const reservation = await store.reserve(cycles[name], limits);
    winners = reservation ? [reservation] : [];
  }
  const ref = winners[0];
  if (!ref) return { winners: 0, ...(await read(db, cycles[name])) };
  const before = await store.read(cycles[name]);
  await store.markIntent(ref);
  await store.markObserved(ref);
  const transport = await requestLuna(batch, { apiKey: "local-only", monotonicNow: () => performance.now(), timeoutMs: name === "timeout" ? 50 : undefined, fetch: (_input, init) => globalThis.fetch(target, init) });
  const endedAt = new Date().toISOString();
  if (transport.usage) await store.settleExact(ref, transport.usage, { outcome: transport.outcome === "success" ? "none" : transport.outcome, httpStatus: transport.httpStatus, endedAt, durationMs: transport.durationMs });
  else await store.markUnknown(ref, { outcome: transport.outcome, httpStatus: transport.httpStatus, endedAt, durationMs: transport.durationMs });
  let validatedSelections: number | null = null;
  if (transport.outcome === "success" && transport.outputText) validatedSelections = parseBatchAnalysis(transport.outputText, batch).selections.length;
  const observation: AnalyzerFailoverObservation = { version: 1, provider: "openai", model: "gpt-6-luna", eligible: true, eligibilityReason: "eligible", attempted: true, dispatchCount: 1, startedAt: null, endedAt: null, durationMs: transport.durationMs, outcome: transport.outcome, httpStatus: transport.httpStatus, usage: transport.usage, accountingState: transport.usage ? "exact" : "unknown", finalAnalyzer: transport.outcome === "success" ? "openai" : "none" };
  await db.prepare("INSERT OR REPLACE INTO workerd_failover_snapshot(cycle_id,value) VALUES(?1,?2)").bind(cycles[name], serializeCycleSnapshot(snapshot(observation))).run();
  return { winners: winners.length, reservationBeforeFetch: before?.state === "reserved" && before.dispatchStatus === "not_dispatched", providerOutcome: transport.outcome, validatedSelections, ...(await read(db, cycles[name])) };
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    await setup(env.DB);
    const name = url.searchParams.get("name") as keyof typeof cycles | null;
    if (!name || !(name in cycles)) return new Response("missing scenario", { status: 400 });
    if (url.pathname === "/read") return Response.json(await read(env.DB, cycles[name]));
    if (url.pathname === "/late-write") {
      const store = new D1OpenAIFallbackUsageStore(env.DB);
      const row = await store.read(cycles[name]);
      let rejected = false;
      try { await store.markUnknown(reservation(row), { outcome: "transport_error", httpStatus: null, endedAt: new Date().toISOString(), durationMs: 1 }); }
      catch { rejected = true; }
      return Response.json({ rejected, ...(await read(env.DB, cycles[name])) });
    }
    const target = url.searchParams.get("target");
    if (!target) return new Response("missing target", { status: 400 });
    return Response.json(await execute(env.DB, name, target, name === "success"));
  },
};
