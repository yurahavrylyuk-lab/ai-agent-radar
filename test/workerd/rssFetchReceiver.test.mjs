import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..");
const wrangler = join(repositoryRoot, "node_modules", ".bin", "wrangler");
const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>
  <item><title>Receiver-safe story</title><link>https://example.com/story</link><description>Fixture body</description><pubDate>Mon, 19 Oct 2026 07:00:00 GMT</pubDate></item>
</channel></rss>`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function unusedPort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
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

let fixtureHits = 0;
const fixture = createServer((_request, response) => {
  fixtureHits += 1;
  response.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
  response.end(rss);
});
const fixturePort = await listen(fixture);
const workerPort = await unusedPort();
const output = { text: "" };
const child = spawn(wrangler, [
  "dev",
  "--config", join(testDirectory, "rssFetchReceiver.wrangler.jsonc"),
  "--local",
  "--ip", "127.0.0.1",
  "--port", String(workerPort),
  "--var", `RSS_FIXTURE_URL:http://127.0.0.1:${fixturePort}/feed.xml`,
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: `/private/tmp/rss-fetch-receiver-${process.pid}.log`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForReady(child, output);
  const response = await fetch(`http://127.0.0.1:${workerPort}/`);
  assert.equal(response.status, 200, output.text);
  const diagnostic = await response.json();
  assert.equal(diagnostic.rawReferenceError?.name, "TypeError");
  assert.match(diagnostic.rawReferenceError?.message ?? "", /Illegal invocation.*incorrect `this` reference/);
  assert.equal(diagnostic.result.metrics.succeededFeeds, 1);
  assert.equal(diagnostic.result.metrics.failedFeeds, 0);
  assert.equal(diagnostic.result.observations.length, 1);
  assert.equal(fixtureHits, 1);
  console.log("Workerd RSS fetch receiver regression passed: raw reference rejected, receiver-safe wrapper fetched exactly once.");
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
  await new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
}
