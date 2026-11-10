import { D1MonitoringTelemetry } from "../../src/services/d1MonitoringTelemetry.js";
import { parseCycleSnapshot, serializeCycleSnapshot, type CycleSnapshotV1 } from "../../src/services/monitoringTelemetry.js";

interface Env { DB: D1Database; }

const legacySnapshot: CycleSnapshotV1 = {
  version: 1, braveHealth: "healthy", rssHealth: "degraded", outage: false,
  candidateCounts: { received: 60, unique: 41, submitted: 24 }, geminiDispatchCount: 1, delivery: null,
  accounting: { reserved: 0, exact: 1, confirmedZero: 0, ambiguous: 0, unavailable: false },
};
const latencySnapshot: CycleSnapshotV1 = {
  ...legacySnapshot,
  latency: {
    version: 1, preFilterInputCount: 47, selectedCount: 24, selectorExcluded: 23,
    byteExcluded: 0, submittedCount: 24, promptBytes: 11_234, snippetBytesLimit: 192,
    thinkingMode: "low", executionMode: "synchronous",
    attemptTimings: [{ ordinal: 1, requestStartedAt: "2026-10-23T08:00:02.125Z", elapsedMs: 75_331 }],
  },
};
const rssSnapshot: CycleSnapshotV1 = {
  ...legacySnapshot,
  rssDiagnostics: {
    version: 1, status: "recorded", collectionStatus: "collected", health: "degraded",
    configuredFeeds: 4, attemptedFeeds: 4, succeededFeeds: 3, failedFeeds: 1,
    outcomes: [
      { feedId: "openai_news", reason: "http", httpStatus: 503, elapsedMs: 25 },
      { feedId: "github_changelog", reason: "ok", elapsedMs: 10 },
      { feedId: "cloudflare_ai", reason: "ok", elapsedMs: 20 },
      { feedId: "chrome_developers", reason: "ok", elapsedMs: 30 },
    ],
  },
};
const cycleId = "11111111-1111-4111-8111-111111111111";
const legacyCycleId = "22222222-2222-4222-8222-222222222222";
const corruptCycleId = "33333333-3333-4333-8333-333333333333";

async function readState(db: D1Database) {
  const snapshots = await db.prepare("SELECT kind,value FROM workerd_snapshots ORDER BY kind").all<{ kind: string; value: string }>();
  const telemetry = new D1MonitoringTelemetry(db);
  const persisted = await telemetry.readCycle(cycleId);
  const legacyCycle = await telemetry.readCycle(legacyCycleId);
  let corruptRejected = false;
  try { await telemetry.readCycle(corruptCycleId); } catch { corruptRejected = true; }
  const raw = await db.prepare("SELECT snapshot_json FROM monitoring_cycles WHERE cycle_id=?1").bind(cycleId).first<{ snapshot_json: string }>();
  return {
    usage: await db.prepare("SELECT value FROM workerd_usage WHERE id=1").first<{ value: string }>(),
    attempt: await db.prepare("SELECT value FROM workerd_attempt WHERE id=1").first<{ value: string }>(),
    snapshots: Object.fromEntries((snapshots.results ?? []).map(row => [row.kind, parseCycleSnapshot(row.value)])),
    rssCycle: persisted && { cycleId: persisted.cycle.cycleId, phase: persisted.phase, snapshot: persisted.snapshot },
    rssRaw: raw ? JSON.parse(raw.snapshot_json) : null,
    legacyCycle: legacyCycle && { phase: legacyCycle.phase, rssDiagnostics: legacyCycle.snapshot.rssDiagnostics ?? null },
    corruptRejected,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/read") return Response.json(await readState(env.DB));
    await env.DB.exec("DROP TABLE IF EXISTS workerd_attempt; DROP TABLE IF EXISTS workerd_usage; DROP TABLE IF EXISTS workerd_snapshots; CREATE TABLE workerd_usage(id INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE workerd_attempt(id INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE workerd_snapshots(kind TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO workerd_usage VALUES(1,'reserved'); INSERT INTO workerd_attempt VALUES(1,'pending'); CREATE TRIGGER workerd_attempt_guard BEFORE UPDATE ON workerd_attempt WHEN NEW.value='reject' BEGIN SELECT RAISE(ABORT,'injected attempt failure'); END;");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workerd_snapshots(kind,value) VALUES(?1,?2)").bind("extended", serializeCycleSnapshot(latencySnapshot)),
      env.DB.prepare("INSERT INTO workerd_snapshots(kind,value) VALUES(?1,?2)").bind("legacy", serializeCycleSnapshot(legacySnapshot)),
    ]);
    const telemetry = new D1MonitoringTelemetry(env.DB, () => new Date("2026-11-10T08:00:03.000Z"));
    await telemetry.createCycle({ cycleId, scheduledAt: "2026-11-10T08:00:00.000Z", startedAt: "2026-11-10T08:00:01.000Z", sourceSha: null, workerVersion: null });
    await telemetry.checkpoint(cycleId, "sources_complete", rssSnapshot);
    await telemetry.completeCycle(cycleId, { ...rssSnapshot, delivery: {
      deliveryMode: "status_only", deliveryReason: "no_eligible_stories", analyzedStories: 0, rawStories: 0, replayStories: 0,
      emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "not_required", finalizationReached: true,
    } });
    await telemetry.createCycle({ cycleId: legacyCycleId, scheduledAt: "2026-11-10T08:00:00.000Z", startedAt: "2026-11-10T08:00:01.000Z", sourceSha: null, workerVersion: null });
    await telemetry.createCycle({ cycleId: corruptCycleId, scheduledAt: "2026-11-10T08:00:00.000Z", startedAt: "2026-11-10T08:00:01.000Z", sourceSha: null, workerVersion: null });
    await env.DB.prepare("UPDATE monitoring_cycles SET snapshot_json=?1 WHERE cycle_id=?2")
      .bind(JSON.stringify({ ...legacySnapshot, rssDiagnostics: { version: 1, status: "recorded", collectionStatus: "collected", health: "healthy",
        configuredFeeds: 1, attemptedFeeds: 1, succeededFeeds: 1, failedFeeds: 0,
        outcomes: [{ feedId: "unknown_feed", reason: "ok", elapsedMs: 1 }] } }), corruptCycleId).run();
    let rollbackError = false;
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE workerd_usage SET value='confirmed_zero' WHERE id=1 RETURNING id"),
        env.DB.prepare("UPDATE workerd_attempt SET value='reject' WHERE id=1 RETURNING id"),
      ]);
    } catch { rollbackError = true; }
    const rolledBack = await readState(env.DB);
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE workerd_usage SET value='confirmed_zero' WHERE id=1 RETURNING id"),
      env.DB.prepare("UPDATE workerd_attempt SET value='settled' WHERE id=1 RETURNING id"),
    ]);
    const legacyKeys = ["version", "braveHealth", "rssHealth", "outage", "candidateCounts", "geminiDispatchCount", "delivery", "accounting"];
    const oldStrictRejectsExtended = Object.keys(latencySnapshot).some(key => !legacyKeys.includes(key));
    return Response.json({ rollbackError, rolledBack, settled: await readState(env.DB), changes: results.map(result => result.meta.changes), returned: results.map(result => result.results), oldStrictRejectsExtended });
  },
};
