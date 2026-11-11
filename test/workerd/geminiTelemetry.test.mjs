import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const wrangler = join(repositoryRoot, "node_modules", ".bin", "wrangler");
const persistence = await mkdtemp(join(tmpdir(), "gemini-telemetry-workerd-"));
const config = join(testDirectory, "geminiTelemetry.wrangler.jsonc");

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function start(port) {
  const output = { text: "" };
  const child = spawn(wrangler, ["dev", "--config", config, "--local", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", persistence], {
    cwd: repositoryRoot,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(persistence, "wrangler.log") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Wrangler did not become ready.\n${output.text}`)), 20_000);
    const inspect = chunk => { output.text += chunk.toString(); if (output.text.includes("Ready on")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", inspect); child.stderr.on("data", inspect);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Wrangler exited before readiness (${code}).\n${output.text}`)); });
  });
  return { child, ready, output };
}
async function stop(child) { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); }

try {
  const schema = spawnSync(wrangler, ["d1", "execute", "gemini-telemetry-regression", "--local", "--config", config, "--persist-to", persistence,
    "--file", join(repositoryRoot, "migrations", "0008_monitoring_cycle_observability.sql")], {
    cwd: repositoryRoot, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, encoding: "utf8",
  });
  assert.equal(schema.status, 0, `${schema.stdout}\n${schema.stderr}`);
  const firstPort = await unusedPort(); const first = start(firstPort); await first.ready;
  const result = await (await fetch(`http://127.0.0.1:${firstPort}/test`)).json();
  assert.equal(result.rollbackError, true, first.output.text);
  const expectedSnapshots = {
    extended: {
      version: 1, braveHealth: "healthy", rssHealth: "degraded", outage: false,
      candidateCounts: { received: 60, unique: 41, submitted: 24 }, geminiDispatchCount: 1, delivery: null,
      accounting: { reserved: 0, exact: 1, confirmedZero: 0, ambiguous: 0, unavailable: false },
      latency: { version: 1, preFilterInputCount: 47, selectedCount: 24, selectorExcluded: 23, byteExcluded: 0,
        submittedCount: 24, promptBytes: 11234, snippetBytesLimit: 192, thinkingMode: "low", executionMode: "synchronous",
        attemptTimings: [{ ordinal: 1, requestStartedAt: "2026-10-23T08:00:02.125Z", elapsedMs: 75331 }] },
    },
    legacy: {
      version: 1, braveHealth: "healthy", rssHealth: "degraded", outage: false,
      candidateCounts: { received: 60, unique: 41, submitted: 24 }, geminiDispatchCount: 1, delivery: null,
      accounting: { reserved: 0, exact: 1, confirmedZero: 0, ambiguous: 0, unavailable: false },
    },
  };
  const rssDiagnostics = {
    version: 1, status: "recorded", collectionStatus: "collected", health: "degraded",
    configuredFeeds: 4, attemptedFeeds: 4, succeededFeeds: 3, failedFeeds: 1,
    outcomes: [
      { feedId: "openai_news", reason: "structure", subreason: "text_limit", elapsedMs: 25 },
      { feedId: "github_changelog", reason: "ok", elapsedMs: 10 },
      { feedId: "cloudflare_ai", reason: "ok", elapsedMs: 20 },
      { feedId: "chrome_developers", reason: "ok", elapsedMs: 30 },
    ],
  };
  const rssSnapshot = {
    version: 1, braveHealth: "healthy", rssHealth: "degraded", outage: false,
    candidateCounts: { received: 60, unique: 41, submitted: 24 }, geminiDispatchCount: 1,
    delivery: { deliveryMode: "status_only", deliveryReason: "no_eligible_stories", analyzedStories: 0, rawStories: 0, replayStories: 0,
      emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "not_required", finalizationReached: true },
    accounting: { reserved: 0, exact: 1, confirmedZero: 0, ambiguous: 0, unavailable: false }, rssDiagnostics,
  };
  const common = { rssCycle: { cycleId: "11111111-1111-4111-8111-111111111111", phase: "completed", snapshot: rssSnapshot }, rssRaw: rssSnapshot,
    legacyCycle: { phase: "started", rssDiagnostics: null }, corruptRejected: true, corruptSubreasonRejected: true };
  assert.deepEqual(result.rolledBack, { usage: { value: "reserved" }, attempt: { value: "pending" }, snapshots: expectedSnapshots, ...common });
  assert.deepEqual(result.settled, { usage: { value: "confirmed_zero" }, attempt: { value: "settled" }, snapshots: expectedSnapshots, ...common });
  assert.equal(result.oldStrictRejectsExtended, true);
  assert.equal(result.oldStrictRejectsRssSubreason, true);
  assert.deepEqual(result.changes, [1, 1]);
  assert.deepEqual(result.returned, [[{ id: 1 }], [{ id: 1 }]]);
  await stop(first.child);

  const secondPort = await unusedPort(); const second = start(secondPort); await second.ready;
  const recovered = await (await fetch(`http://127.0.0.1:${secondPort}/read`)).json();
  assert.deepEqual(recovered, result.settled);
  await stop(second.child);
  console.log("Workerd Gemini/RSS telemetry regression passed: failed batches rolled back and bounded RSS evidence survived D1 restart/readback.");
} finally { await rm(persistence, { recursive: true, force: true }); }
