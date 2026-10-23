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

function treeHeavyRss(hostname, bytes) {
  const items = Array.from({ length: 6 }, (_, index) => `<item><title>Story ${index}</title><link>https://${hostname}/story-${index}</link><pubDate>Mon, 19 Oct 2026 07:00:00 GMT</pubDate></item>`).join("");
  const prefix = `<?xml version="1.0"?><rss version="2.0"><channel><title>Tree-heavy fixture</title>${items}`;
  const suffix = `</channel></rss>`;
  const elements = 8000;
  let textBytes = bytes - Buffer.byteLength(prefix + suffix) - elements * 11;
  assert.ok(textBytes >= 0 && textBytes <= elements * 4096);
  const padding = [];
  for (let index = 0; index < elements; index += 1) {
    const chunkBytes = Math.min(4096, textBytes);
    padding.push(`<pad>${"x".repeat(chunkBytes)}</pad>`);
    textBytes -= chunkBytes;
  }
  assert.equal(textBytes, 0);
  const document = `${prefix}${padding.join("")}${suffix}`;
  assert.equal(Buffer.byteLength(document), bytes);
  return document;
}

const sequentialFixtures = new Map([
  ["/large-a.xml", treeHeavyRss("fixture-a.example", 1048576)],
  ["/large-b.xml", treeHeavyRss("fixture-b.example", 1048576)],
  ["/large-c.xml", treeHeavyRss("fixture-c.example", 1048576)],
]);

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
let activeFixtureResponses = 0;
let maxActiveFixtureResponses = 0;
const fixturePaths = [];
const fixture = createServer((request, response) => {
  fixtureHits += 1;
  fixturePaths.push(request.url);
  activeFixtureResponses += 1;
  maxActiveFixtureResponses = Math.max(maxActiveFixtureResponses, activeFixtureResponses);
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    activeFixtureResponses -= 1;
  };
  response.once("finish", complete);
  response.once("close", complete);
  response.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
  if (request.url === "/overflow.xml") {
    for (let index = 0; index < 64; index += 1) response.write(Buffer.alloc(16384, 0x78));
    response.write(Buffer.from("x"));
    response.end();
    return;
  }
  const body = sequentialFixtures.get(request.url ?? "") ?? rss;
  for (let offset = 0; offset < body.length; offset += 16384) response.write(body.slice(offset, offset + 16384));
  response.end();
});
const fixturePort = await listen(fixture);

async function runDiagnostic(mode) {
  const workerPort = await unusedPort();
  const output = { text: "" };
  const args = [
    "dev",
    "--config", join(testDirectory, "rssFetchReceiver.wrangler.jsonc"),
    "--local",
    "--ip", "127.0.0.1",
    "--port", String(workerPort),
    "--var", `RSS_FIXTURE_URL:http://127.0.0.1:${fixturePort}/feed.xml`,
  ];
  if (mode) args.push("--var", `RSS_FIXTURE_MODE:${mode}`);
  const child = spawn(wrangler, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: `/private/tmp/rss-fetch-receiver-${process.pid}-${mode ?? "single"}.log`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForReady(child, output);
    const response = await fetch(`http://127.0.0.1:${workerPort}/`);
    assert.equal(response.status, 200, output.text);
    return await response.json();
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  }
}

try {
  const diagnostic = await runDiagnostic();
  assert.equal(diagnostic.rawReferenceError?.name, "TypeError");
  assert.match(diagnostic.rawReferenceError?.message ?? "", /Illegal invocation.*incorrect `this` reference/);
  assert.equal(diagnostic.result.metrics.succeededFeeds, 1);
  assert.equal(diagnostic.result.metrics.failedFeeds, 0);
  assert.equal(diagnostic.result.observations.length, 1);
  assert.equal(fixtureHits, 1);

  fixtureHits = 0;
  fixturePaths.length = 0;
  maxActiveFixtureResponses = 0;
  const sequential = await runDiagnostic("sequential");
  assert.equal(sequential.result.metrics.attemptedFeeds, 4);
  assert.equal(sequential.result.metrics.succeededFeeds, 3);
  assert.equal(sequential.result.metrics.failedFeeds, 1);
  assert.deepEqual(sequential.result.metrics.outcomes.map(outcome => outcome.reason), ["ok", "body_limit", "ok", "ok"]);
  assert.equal(sequential.result.observations.length, 15);
  assert.equal(fixtureHits, 4);
  assert.deepEqual(fixturePaths, ["/large-a.xml", "/overflow.xml", "/large-b.xml", "/large-c.xml"]);
  assert.equal(maxActiveFixtureResponses, 1);
  console.log("Workerd RSS receiver and one-MiB sequential safety regressions passed with one bounded request/body flow.");
} finally {
  await new Promise((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
}
