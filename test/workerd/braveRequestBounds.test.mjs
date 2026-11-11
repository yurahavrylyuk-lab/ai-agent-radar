import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const wrangler = join(repositoryRoot, "node_modules", ".bin", "wrangler");
const hits = new Map();
const sockets = new Set();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function waitForReady(child, output) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Wrangler did not become ready.\n${output.text}`)), 20_000);
    const inspect = chunk => {
      output.text += chunk.toString();
      if (output.text.includes("Ready on")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`Wrangler exited before readiness (${code}).\n${output.text}`));
    });
  });
}

function increment(path) {
  hits.set(path, (hits.get(path) ?? 0) + 1);
}

const fixture = createServer((request, response) => {
  const path = request.url ?? "";
  increment(path);
  if (path === "/redirect-target") {
    response.writeHead(500);
    response.end("redirect followed unexpectedly");
    return;
  }
  if (path === "/redirect") {
    response.writeHead(302, { location: "/redirect-target" });
    response.end();
    return;
  }
  if (path === "/error") {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"private":"provider error body"}');
    return;
  }
  if (path === "/malformed") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{");
    return;
  }
  if (path === "/oversized") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(Buffer.alloc(262_145, 0x78));
    return;
  }
  if (path === "/delayed-headers") {
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"web":{"results":[]}}');
    }, 5_500);
    return;
  }
  if (path === "/delayed-body") {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"web":');
    setTimeout(() => {
      if (!response.destroyed) response.end('{"results":[]}}');
    }, 5_500);
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"web":{"results":[]}}');
});
fixture.on("connection", socket => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});

const fixturePort = await listen(fixture);
const workerPort = await unusedPort();
const output = { text: "" };
const child = spawn(wrangler, [
  "dev",
  "--config", join(testDirectory, "braveRequestBounds.wrangler.jsonc"),
  "--local",
  "--ip", "127.0.0.1",
  "--port", String(workerPort),
  "--var", `BRAVE_FIXTURE_ORIGIN:http://127.0.0.1:${fixturePort}`,
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: `/private/tmp/brave-request-bounds-${process.pid}.log`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function invoke(mode) {
  const response = await fetch(`http://127.0.0.1:${workerPort}/?mode=${mode}`);
  assert.equal(response.status, 200, output.text);
  return response.json();
}

try {
  await waitForReady(child, output);
  const valid = await invoke("valid");
  assert.deepEqual({ ok: valid.ok, rawCount: valid.rawCount, records: valid.records }, { ok: true, rawCount: 0, records: 1 });
  const malformed = await invoke("malformed");
  assert.deepEqual({ ok: malformed.ok, reason: malformed.reason, records: malformed.records }, { ok: false, reason: "invalid_json", records: 1 });
  const oversized = await invoke("oversized");
  assert.deepEqual({ ok: oversized.ok, reason: oversized.reason, records: oversized.records }, { ok: false, reason: "body_limit", records: 1 });
  const providerError = await invoke("error");
  assert.deepEqual({ ok: providerError.ok, reason: providerError.reason, status: providerError.status, records: providerError.records }, { ok: false, reason: "http", status: 503, records: 0 });
  const redirect = await invoke("redirect");
  assert.deepEqual({ ok: redirect.ok, reason: redirect.reason, status: redirect.status, records: redirect.records }, { ok: false, reason: "redirect", status: 302, records: 0 });
  assert.equal(hits.get("/redirect-target") ?? 0, 0);

  for (const mode of ["delayed-headers", "delayed-body"]) {
    const timeout = await invoke(mode);
    assert.equal(timeout.ok, false);
    assert.equal(timeout.reason, "timeout");
    assert.equal(timeout.records, mode === "delayed-body" ? 1 : 0);
    assert.ok(timeout.elapsedMs >= 4_800 && timeout.elapsedMs < 5_500, `${mode} elapsed ${timeout.elapsedMs}`);
  }

  for (const path of ["/valid", "/malformed", "/oversized", "/error", "/redirect", "/delayed-headers", "/delayed-body"]) {
    assert.equal(hits.get(path), 1, `${path} must receive exactly one request`);
  }
  console.log("Workerd Brave bounds passed: one request per fixture, manual redirect, bounded bodies and real five-second headers/body deadlines.");
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
}
