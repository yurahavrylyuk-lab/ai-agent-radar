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

async function readState(db: D1Database) {
  const snapshots = await db.prepare("SELECT kind,value FROM workerd_snapshots ORDER BY kind").all<{ kind: string; value: string }>();
  return {
    usage: await db.prepare("SELECT value FROM workerd_usage WHERE id=1").first<{ value: string }>(),
    attempt: await db.prepare("SELECT value FROM workerd_attempt WHERE id=1").first<{ value: string }>(),
    snapshots: Object.fromEntries((snapshots.results ?? []).map(row => [row.kind, parseCycleSnapshot(row.value)])),
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
