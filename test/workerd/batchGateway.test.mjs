import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const entry = fileURLToPath(new URL("../../src/batchGatewayWorker.ts", import.meta.url));
const bundle = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "browser", write: false });
const token = "a".repeat(64);
const worker = new Miniflare({
  workers: [{ config: {
    type: "worker",
    name: "synthetic-batch-gateway",
    manifest: { mainModule: "gateway.js", modules: { "gateway.js": { type: "esm", contents: bundle.outputFiles[0].text } } },
    compatibilityDate: "2026-09-20",
    env: { BATCH_GATEWAY_KEY: { type: "text", value: token }, DB: { type: "d1" } },
  } }],
});
try {
  const db = await worker.getD1Database("DB");
  await db.prepare("CREATE TABLE controlled_execution_locks (name TEXT PRIMARY KEY, created_at TEXT NOT NULL)").run();
  const date = new Date().toISOString().slice(0, 10);
  const send = (key, op = "daily.admit", args = [date]) => worker.dispatchFetch("https://gateway.example.test/v1/batch", {
    method: "POST",
    headers: key ? { authorization: "Bearer " + key } : {},
    body: JSON.stringify({ op, args }),
  });
  assert.equal((await send()).status, 401);
  assert.equal((await send("b".repeat(64))).status, 401);
  const replies = await Promise.all(Array.from({ length: 8 }, () => send(token)));
  assert.ok(replies.every((reply) => reply.status === 200));
  const results = await Promise.all(replies.map((reply) => reply.json()));
  assert.equal(results.filter(({ value }) => value === true).length, 1);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM controlled_execution_locks").first()).n, 1);

  for (const file of ["0001_initial", "0010_email_delivery_ledger", "0011_email_feedback"]) {
    const sql = await readFile(new URL(`../../migrations/${file}.sql`, import.meta.url), "utf8");
    for (const statement of sql.trim().split(/\n\s*\n/)) await db.prepare(statement).run();
  }
  const at = "2026-11-26T08:00:00.000Z";
  const profileOp = "feedback.getPreferenceProfile";
  assert.equal((await send(undefined, profileOp, [at])).status, 401);
  assert.equal((await send(token, profileOp, ["invalid"])).status, 400);
  assert.deepEqual(await (await send(token, profileOp, [at])).json(), {
    kind: "value", value: { ai_ml:0, it_infrastructure:0, programming:0, developer_tools_workflow:0 },
  });
  assert.equal((await send(token, "feedback.recordVote", [])).status, 400);

  const identity = { key: "daily-digest/2026-11-26", logicalDate: "2026-11-26", scheduledAt: at };
  const content = { from:"radar@example.test", subject:"Fixture", text:"Fixture", html:"<p>Fixture</p>" };
  const body = JSON.stringify({ from:content.from, to:["owner@example.test"], subject:content.subject, text:content.text, html:content.html });
  const payloadSha256 = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("hex");
  const frozen = {identity, payloadVersion:1, content, payloadSha256, aliases:[], mode:"normal", reason:"selected"};
  const bindings = [1,2].map(slot => ({
    deliveryKey:identity.key, slot, payloadSha256, storySha256:String(slot).repeat(64),
    discoveryKey:String(slot).repeat(64), displayTitle:"Article "+slot,
    kind:"analyzed", topics:["ai_ml"], issuedAt:at, expiresAt:"2026-12-26T08:00:00.000Z",
    keyId:"fixture", relevantDigest:"c".repeat(64), notRelevantDigest:"d".repeat(64),
  }));
  const reserveOp = "ledger.reserveWithBindings";
  const count = async (table) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
  const malformed = [{...bindings[0], payloadSha256:"e".repeat(64)}];
  assert.equal((await send(token, reserveOp, [frozen, malformed])).status, 400);
  await db.prepare(`CREATE TRIGGER fixture_rollback BEFORE INSERT ON email_feedback_stories WHEN NEW.slot=2
    BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`).run();
  assert.equal((await send(token, reserveOp, [frozen, bindings])).status, 503);
  assert.equal(await count("email_deliveries"), 0);
  assert.equal(await count("email_feedback_stories"), 0);
  await db.prepare("DROP TRIGGER fixture_rollback").run();
  for (let attempt = 0; attempt < 2; attempt++) {
    const reserved = await send(token, reserveOp, [frozen, bindings]);
    assert.equal(reserved.status, 200);
    assert.equal((await reserved.json()).value.kind, "committed");
  }
  assert.equal(await count("email_deliveries"), 1);
  assert.equal(await count("email_feedback_stories"), 2);
  assert.equal(await count("email_feedback_votes"), 0);
  const boundaryIdentity = {
    key: "daily-digest/2026-11-27", logicalDate: "2026-11-27", scheduledAt: "2026-11-27T08:00:00.000Z",
  };
  const largeContent = { ...content, text: '"'.repeat(45_000), html: "é" };
  const storedBytes = (value) => Buffer.byteLength(JSON.stringify({
    scheduledAt: boundaryIdentity.scheduledAt, content: value,
  }));
  largeContent.html += "h".repeat(278_528 - storedBytes(largeContent));
  const largeFrozen = async (value) => {
    const providerBody = JSON.stringify({ from: value.from, to: ["owner@example.test"],
      subject: value.subject, text: value.text, html: value.html });
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(providerBody))).toString("hex");
    return { ...frozen, identity: boundaryIdentity, content: value, payloadSha256: hash };
  };
  const overflow = await largeFrozen({ ...largeContent, html: largeContent.html + "h" });
  assert.equal((await send(token, "ledger.reserve", [overflow])).status, 503);
  assert.deepEqual((await (await send(token, "ledger.read", [boundaryIdentity.key])).json()).value, null);
  const atLimit = await largeFrozen(largeContent);
  assert.equal(storedBytes(largeContent), 278_528);
  assert.equal((await send(token, "ledger.reserve", [atLimit])).status, 200);
  const readback = await (await send(token, "ledger.read", [boundaryIdentity.key])).json();
  assert.deepEqual(readback.value.frozen, atLimit);
  console.log("Local Workerd gateway passed authentication, eight-way admission, closed feedback operations atomic reserve rollback/replay, and the 278,528-byte storage boundary.");
} finally { await worker.dispose(); }
