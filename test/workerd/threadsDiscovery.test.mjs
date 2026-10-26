import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const wrangler = join(repositoryRoot, "node_modules", ".bin", "wrangler");

function listen(server) { return new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", () => resolve(server.address().port))); }
async function unusedPort() { const server = createServer(); const port = await listen(server); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port; }
function waitForReady(child, output) { return new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Wrangler did not become ready.\n${output.text}`)), 20_000);
  const inspect = chunk => { output.text += chunk.toString(); if (output.text.includes("Ready on")) { clearTimeout(timer); resolve(); } };
  child.stdout.on("data", inspect); child.stderr.on("data", inspect);
  child.once("exit", code => { clearTimeout(timer); reject(new Error(`Wrangler exited before readiness (${code}).\n${output.text}`)); });
}); }

let hits = 0;
const paths = [];
let cancelledOverflow = false;
const valid = JSON.stringify({ data: [{ id: "123", text: "Fixture public post", permalink: "https://www.threads.com/@fixture/post/abc", timestamp: "2026-10-25T07:00:00.000Z" }] });
const fixture = createServer((request, response) => {
  hits++; paths.push(request.url);
  if (request.url === "/redirect") { response.writeHead(302, { location: "/target?access_token=must-not-forward" }); response.end(); return; }
  if (request.url === "/timeout") { setTimeout(() => { if (!response.destroyed) { response.writeHead(200); response.end(valid); } }, 4000); return; }
  response.writeHead(200, { "content-type": "application/json" });
  if (request.url === "/overflow") {
    response.on("close", () => { cancelledOverflow = true; });
    response.write(Buffer.alloc(131073, 0x78));
    const timer = setInterval(() => response.write(Buffer.alloc(1024, 0x78)), 10);
    setTimeout(() => { clearInterval(timer); if (!response.destroyed) response.end(); }, 1000);
    return;
  }
  response.end(valid);
});
const fixturePort = await listen(fixture);
const workerPort = await unusedPort();
const output = { text: "" };
const child = spawn(wrangler, ["dev", "--config", join(testDirectory, "threadsDiscovery.wrangler.jsonc"), "--local", "--ip", "127.0.0.1", "--port", String(workerPort), "--var", `THREADS_FIXTURE_ORIGIN:http://127.0.0.1:${fixturePort}`], {
  cwd: repositoryRoot,
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: `/private/tmp/threads-discovery-${process.pid}.log` },
  stdio: ["ignore", "pipe", "pipe"],
});

async function diagnostic(name) {
  const response = await fetch(`http://127.0.0.1:${workerPort}/?case=${name}`);
  assert.equal(response.status, 200, output.text);
  return response.json();
}

try {
  await waitForReady(child, output);
  const native = await diagnostic("native_fetch_receiver_and_abort");
  assert.equal(native.rawReferenceError.name, "TypeError");
  assert.match(native.rawReferenceError.message, /Illegal invocation.*incorrect `this` reference/);
  assert.equal(native.metrics.succeededQueries, 3);
  assert.equal(native.observations, 3);
  assert.equal(hits, 3);

  const beforeOverflow = hits;
  const overflow = await diagnostic("stream_cap_cancels_reader");
  assert.equal(overflow.metrics.reason, "body_limit");
  assert.equal(hits - beforeOverflow, 3);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(cancelledOverflow, true);

  const beforeRedirect = hits;
  const redirect = await diagnostic("redirect_never_forwards_token");
  assert.equal(redirect.metrics.reason, "redirect");
  assert.equal(hits - beforeRedirect, 3);
  assert.equal(paths.some(path => path.includes("access_token")), false);
  assert.equal(paths.some(path => path.startsWith("/target")), false);

  const beforeDisabled = hits;
  const disabled = await diagnostic("disabled_binding_has_zero_requests");
  assert.equal(disabled.metrics.health, "disabled");
  assert.equal(hits, beforeDisabled);

  const beforeFailure = hits;
  const failed = await diagnostic("failed_threads_keeps_combined_cycle");
  assert.equal(failed.metrics.health, "unavailable");
  assert.equal(failed.metrics.reason, "timeout");
  assert.equal(failed.otherSourceHealthy, true);
  assert.equal(failed.finalizerReached, true);
  assert.equal(hits - beforeFailure, 3);
  console.log("Workerd Threads discovery boundaries passed with loopback-only fixtures and bounded source isolation.");
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  await new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
}
