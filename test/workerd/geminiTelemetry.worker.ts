interface Env { DB: D1Database; }

async function readState(db: D1Database) {
  return {
    usage: await db.prepare("SELECT value FROM workerd_usage WHERE id=1").first<{ value: string }>(),
    attempt: await db.prepare("SELECT value FROM workerd_attempt WHERE id=1").first<{ value: string }>(),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/read") return Response.json(await readState(env.DB));
    await env.DB.exec("DROP TABLE IF EXISTS workerd_attempt; DROP TABLE IF EXISTS workerd_usage; CREATE TABLE workerd_usage(id INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE workerd_attempt(id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO workerd_usage VALUES(1,'reserved'); INSERT INTO workerd_attempt VALUES(1,'pending'); CREATE TRIGGER workerd_attempt_guard BEFORE UPDATE ON workerd_attempt WHEN NEW.value='reject' BEGIN SELECT RAISE(ABORT,'injected attempt failure'); END;");
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
    return Response.json({ rollbackError, rolledBack, settled: await readState(env.DB), changes: results.map(result => result.meta.changes), returned: results.map(result => result.results) });
  },
};
