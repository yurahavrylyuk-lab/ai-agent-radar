import assert from "node:assert/strict";
import test from "node:test";

import {
  RSS_FEEDS,
  RSS_LIMITS,
  validateRssFeeds,
  type RssFeedDefinition,
} from "../src/config/rssSources.js";
import { collectRss, parseRssFeed } from "../src/services/rssDiscovery.js";

const approvedFeeds = [
  { id: "openai_news", label: "OpenAI News", endpoint: "https://openai.com/news/rss.xml", articleHostnames: ["openai.com"] },
  { id: "github_changelog", label: "GitHub Changelog", endpoint: "https://github.blog/changelog/feed/", articleHostnames: ["github.blog"] },
  { id: "cloudflare_ai", label: "Cloudflare AI", endpoint: "https://blog.cloudflare.com/tag/ai/rss/", articleHostnames: ["blog.cloudflare.com"] },
  { id: "chrome_developers", label: "Chrome for Developers", endpoint: "https://developer.chrome.com/static/blog/feed.xml", articleHostnames: ["developer.chrome.com"] },
] as const;

function feed(overrides: Partial<RssFeedDefinition> = {}): RssFeedDefinition {
  return { id: "valid_feed", label: "Valid Feed", endpoint: "https://example.com/feed.xml", articleHostnames: ["example.com"], ...overrides };
}

test("RSS registry exposes only the four approved first-party feeds in fixed order", () => {
  assert.deepEqual(RSS_FEEDS, approvedFeeds);
  assert.deepEqual(RSS_LIMITS, {
    feeds: 5, itemsPerFeed: 5, timeoutMs: 5000, bodyBytes: 1048576,
    depth: 32, elements: 10000, fieldBytes: 8192, titleBytes: 256,
    snippetBytes: 768, urlBytes: 2048, ageMs: 604800000,
  });
});

test("RSS registry accepts empty and exact safe feed definitions", () => {
  assert.doesNotThrow(() => validateRssFeeds([]));
  assert.doesNotThrow(() => validateRssFeeds([feed()]));
});

test("RSS registry rejects unsafe or ambiguous configuration", () => {
  const invalid: readonly (readonly RssFeedDefinition[])[] = [
    Array.from({ length: 6 }, (_, index) => feed({ id: `feed_${index}`, endpoint: `https://example.com/${index}.xml` })),
    [feed(), feed()],
    [feed(), feed({ id: "other", endpoint: "https://example.com/feed.xml" })],
    [feed({ endpoint: "http://example.com/feed.xml" })],
    [feed({ endpoint: "https://user:pass@example.com/feed.xml" })],
    [feed({ endpoint: "https://example.com:8443/feed.xml" })],
    [feed({ endpoint: "https://example.com/feed.xml#fragment" })],
    [feed({ endpoint: "https://127.0.0.1/feed.xml" })],
    [feed({ endpoint: "https://localhost/feed.xml" })],
    [feed({ endpoint: "https://service.internal/feed.xml" })],
    [feed({ id: "Not_Valid" })],
    [feed({ articleHostnames: [] })],
    [feed({ articleHostnames: ["*.example.com"] })],
    [feed({ articleHostnames: ["www.example.com", "www.example.com"] })],
  ];
  for (const feeds of invalid) assert.throws(() => validateRssFeeds(feeds));
});

test("RSS hostname authorization is exact rather than suffix based", async () => {
  const { isApprovedRssArticleUrl } = await import("../src/config/rssSources.js");
  const configured = feed();
  assert.equal(isApprovedRssArticleUrl("https://example.com/story", configured), true);
  assert.equal(isApprovedRssArticleUrl("https://www.example.com/story", configured), false);
  assert.equal(isApprovedRssArticleUrl("https://example.com.evil.test/story", configured), false);
  assert.equal(isApprovedRssArticleUrl("https://sub.example.com/story", configured), false);
});

const now = new Date("2026-10-16T08:00:00.000Z");
const rssFeed = feed({ endpoint: "https://example.com/news/feed.xml" });

test("RSS 2.0 parsing normalizes safe bounded item evidence", () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>
    <item><title><![CDATA[ New   Tool ]]></title><link>/news/tool?x=1#section</link><description>Useful &amp; practical</description><pubDate>Thu, 16 Oct 2026 07:00:00 +0000</pubDate></item>
    <item><title>Boundary</title><link>https://example.com/news/boundary</link><pubDate>Fri, 09 Oct 2026 08:00:00 GMT</pubDate></item>
  </channel></rss>`;
  assert.deepEqual(parseRssFeed(xml, rssFeed, now), {
    positions: [
      { itemOrdinal: 1, result: { title: "New Tool", url: "https://example.com/news/tool?x=1#section", snippet: "Useful & practical", publishedAt: "2026-10-16T07:00:00.000Z", source: "Valid Feed" } },
      { itemOrdinal: 2, result: { title: "Boundary", url: "https://example.com/news/boundary", publishedAt: "2026-10-09T08:00:00.000Z", source: "Valid Feed" } },
    ], rejectedItems: 0, itemsTruncated: false,
  });
});

test("Atom parsing accepts one alternate HTML link and updated date fallback", () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title>
    <entry><title>Atom Tool</title><link rel="alternate" type="text/html" href="/news/atom"/><summary>Short update</summary><updated>2026-10-16T07:30:00+00:00</updated></entry>
  </feed>`;
  assert.deepEqual(parseRssFeed(xml, rssFeed, now).positions, [{ itemOrdinal: 1, result: {
    title: "Atom Tool", url: "https://example.com/news/atom", snippet: "Short update", publishedAt: "2026-10-16T07:30:00.000Z", source: "Valid Feed",
  } }]);
});

test("invalid RSS items consume the first-five positional allowance", () => {
  const items = [
    `<item><title>&lt;b&gt;HTML&lt;/b&gt;</title><link>https://example.com/a</link><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item>`,
    `<item><title>Wrong host</title><link>https://www.example.com/b</link><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item>`,
    `<item><title>Homepage</title><link>https://example.com/</link><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item>`,
    `<item><title>Future</title><link>https://example.com/d</link><pubDate>Sat, 17 Oct 2026 07:00:00 GMT</pubDate></item>`,
    `<item><title>Missing date</title><link>https://example.com/e</link></item>`,
    `<item><title>Sixth valid</title><link>https://example.com/f</link><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item>`,
  ];
  const result = parseRssFeed(`<rss version="2.0"><channel><title>F</title>${items.join("")}</channel></rss>`, rssFeed, now);
  assert.equal(result.positions.length, 5);
  assert.deepEqual(result.positions.map(position => position.result), [null, null, null, null, null]);
  assert.equal(result.rejectedItems, 5);
  assert.equal(result.itemsTruncated, true);
});

test("Atom rejects ambiguous alternate links and xml:base-dependent URLs", () => {
  const result = parseRssFeed(`<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.com/"><title>F</title>
    <entry><title>A</title><link rel="alternate" href="one"/><link rel="alternate" href="two"/><published>2026-10-16T07:00:00Z</published></entry>
    <entry><title>B</title><link rel="alternate" href="relative"/><published>2026-10-16T07:00:00Z</published></entry>
  </feed>`, rssFeed, now);
  assert.deepEqual(result.positions.map(position => position.result), [null, null]);
});

test("parser rejects unsafe or incomplete documents after retained positions", () => {
  const documents = [
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>`,
    `<rss version="2.0"><channel></channel><channel></channel></rss>`,
    `<feed xmlns="urn:not-atom"><entry/></feed>`,
    `<rss version="2.0"><channel><item><title>A</title><link>https://example.com/a</link><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item></channel></rss><rss/>`,
    `<!DOCTYPE rss [<!ENTITY x "boom">]><rss version="2.0"><channel/></rss>`,
    `<rss version="2.0"><channel>${`<x>`.repeat(33)}${`</x>`.repeat(33)}</channel></rss>`,
    `<rss version="2.0"><channel><item><title>${"x".repeat(8193)}</title></item></channel></rss>`,
    `<rss version="2.0"><channel>${Array.from({ length: 5 }, (_, i) => `<item><title>A${i}</title><link>https://example.com/${i}</link><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item>`).join("")}`,
  ];
  for (const xml of documents) assert.throws(() => parseRssFeed(xml, rssFeed, now));
});

const healthyXml = `<rss version="2.0"><channel><title>F</title><item><title>One</title><link>https://example.com/news/one</link><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item></channel></rss>`;

const encoder = new TextEncoder();

function paddedDocument(prefix: string, suffix: string, bytes: number): string {
  const fixedBytes = encoder.encode(prefix + suffix).byteLength;
  const remaining = bytes - fixedBytes;
  assert.ok(remaining >= 11, `target ${bytes} is too small for bounded padding`);
  const elements = Math.ceil(remaining / 4107);
  let textBytes = remaining - elements * 11;
  assert.ok(textBytes >= 0 && textBytes <= elements * 4096);
  const padding: string[] = [];
  for (let index = 0; index < elements; index += 1) {
    const chunkBytes = Math.min(4096, textBytes);
    padding.push(`<pad>${"x".repeat(chunkBytes)}</pad>`);
    textBytes -= chunkBytes;
  }
  assert.equal(textBytes, 0);
  const document = `${prefix}${padding.join("")}${suffix}`;
  assert.equal(encoder.encode(document).byteLength, bytes);
  return document;
}

function documentAtBytes(format: "rss" | "atom", bytes: number): string {
  if (format === "rss") {
    return paddedDocument(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><item><title>Large RSS</title><link>https://example.com/news/large-rss</link><description>Bounded fixture</description><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item>`,
      `</channel></rss>`,
      bytes,
    );
  }
  return paddedDocument(
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Fixture</title><entry><title>Large Atom</title><link rel="alternate" type="text/html" href="https://example.com/news/large-atom"/><summary>Bounded fixture</summary><updated>2026-10-16T07:00:00Z</updated></entry>`,
    `</feed>`,
    bytes,
  );
}

function overflowingBody(onCancel: () => void | Promise<void>): ReadableStream<Uint8Array> {
  const chunks = Array.from({ length: 16 }, () => new Uint8Array(65536).fill(0x78));
  chunks.push(new Uint8Array([0x78]));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) {
        controller.enqueue(chunk);
        return;
      }
      return new Promise<void>(() => {});
    },
    cancel: onCancel,
  });
}

test("collector accepts complete RSS and Atom documents through the inclusive one MiB boundary", async () => {
  for (const format of ["rss", "atom"] as const) {
    for (const bytes of [262145, 524288, 1048576]) {
      const body = documentAtBytes(format, bytes);
      assert.equal(encoder.encode(body).byteLength, bytes);
      for (const declaredLength of [false, true]) {
        const result = await collectRss({
          now,
          feeds: [rssFeed],
          fetch: async () => new Response(body, { headers: {
            "content-type": format === "rss" ? "application/rss+xml" : "application/atom+xml",
            ...(declaredLength ? { "content-length": String(bytes) } : {}),
          } }),
        });
        assert.deepEqual(result.metrics.outcomes.map(({ elapsedMs: _elapsedMs, ...outcome }) => outcome), [{ feedId: rssFeed.id, reason: "ok" }]);
        assert.deepEqual(result.observations.map(observation => observation.result && {
          title: observation.result.title,
          url: observation.result.url,
        }), [{
          title: format === "rss" ? "Large RSS" : "Large Atom",
          url: format === "rss" ? "https://example.com/news/large-rss" : "https://example.com/news/large-atom",
        }]);
      }
    }
  }
});

test("stream overflow cancels without blocking and remains isolated from a later feed", { timeout: 2000 }, async () => {
  for (const contentLength of [undefined, "1"]) {
    for (const cancellation of ["reject", "stall"] as const) {
      let cancelled = false;
      const calls: string[] = [];
      const result = await collectRss({
        now,
        feeds: [
          feed({ id: "overflow", endpoint: "https://example.com/overflow.xml" }),
          feed({ id: "healthy", endpoint: "https://example.com/healthy.xml" }),
        ],
        fetch: async input => {
          calls.push(String(input));
          if (String(input).endsWith("/healthy.xml")) {
            return new Response(healthyXml, { headers: { "content-type": "application/xml" } });
          }
          return new Response(overflowingBody(() => {
            cancelled = true;
            return cancellation === "reject"
              ? Promise.reject(new Error("private cancellation failure"))
              : new Promise<void>(() => {});
          }), { headers: {
            "content-type": "application/xml",
            ...(contentLength === undefined ? {} : { "content-length": contentLength }),
          } });
        },
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(cancelled, true);
      assert.deepEqual(calls, ["https://example.com/overflow.xml", "https://example.com/healthy.xml"]);
      assert.deepEqual(result.metrics.outcomes.map(outcome => outcome.reason), ["body_limit", "ok"]);
      assert.equal(result.metrics.succeededFeeds, 1);
      assert.equal(result.metrics.failedFeeds, 1);
      assert.equal(result.observations.length, 1);
      assert.equal(result.observations[0]?.provenance.feedId, "healthy");
    }
  }
});

test("oversized or malformed declared lengths reject before body consumption while the exact limit proceeds", async () => {
  for (const declaredLength of ["1048577", "invalid", "-1", "1.5", ""]) {
    let bodyReads = 0;
    const feeds = [
      feed({ id: "declared", endpoint: "https://example.com/declared.xml" }),
      feed({ id: "healthy", endpoint: "https://example.com/healthy.xml" }),
    ];
    const result = await collectRss({ now, feeds, fetch: async input => {
      if (String(input).endsWith("/healthy.xml")) return new Response(healthyXml, { headers: { "content-type": "application/xml" } });
      return {
        status: 200,
        ok: true,
        redirected: false,
        headers: new Headers({ "content-type": "application/xml", "content-length": declaredLength }),
        body: { getReader() { bodyReads += 1; throw new Error("body must not be read"); } },
      } as unknown as Response;
    } });
    assert.equal(bodyReads, 0);
    assert.deepEqual(result.metrics.outcomes.map(outcome => outcome.reason), ["body_limit", "ok"]);
    assert.equal(result.observations.length, 1);
  }

  const exact = documentAtBytes("rss", 1048576);
  const exactResult = await collectRss({
    now,
    feeds: [rssFeed],
    fetch: async () => new Response(exact, { headers: { "content-type": "application/xml", "content-length": "1048576" } }),
  });
  assert.equal(exactResult.metrics.outcomes[0]?.reason, "ok");
  assert.equal(exactResult.observations.length, 1);
});

test("large valid first positions cannot escape malformed trailing XML or structural limits", async () => {
  const fiveItems = Array.from({ length: 5 }, (_, index) => `<item><title>Item ${index}</title><link>https://example.com/news/${index}</link><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item>`).join("");
  const malformedTail = paddedDocument(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${fiveItems}`,
    `<broken>`,
    524288,
  );
  assert.ok(encoder.encode(malformedTail).byteLength > 262144);

  const structuralDocuments = [
    malformedTail,
    `<rss version="2.0"><channel>${`<x>`.repeat(33)}${`</x>`.repeat(33)}</channel></rss>`,
    `<rss version="2.0"><channel>${"<x/>".repeat(9999)}</channel></rss>`,
    `<rss version="2.0"><channel><x>${"x".repeat(8193)}</x></channel></rss>`,
    `<rss version="2.0"><channel><x value="${"x".repeat(8193)}"/></channel></rss>`,
    `<!DOCTYPE rss [<!ENTITY external SYSTEM "https://example.com/private-entity">]><rss version="2.0"><channel><item><title>&external;</title><link>https://example.com/private-article</link><pubDate>Thu, 16 Oct 2026 07:00:00 GMT</pubDate></item></channel></rss>`,
  ];
  for (const xml of structuralDocuments) {
    assert.ok(encoder.encode(xml).byteLength < 1048576);
    assert.throws(() => parseRssFeed(xml, rssFeed, now));
  }

  const calls: string[] = [];
  const result = await collectRss({
    now,
    feeds: [
      feed({ id: "unsafe", endpoint: "https://example.com/unsafe.xml" }),
      feed({ id: "healthy", endpoint: "https://example.com/healthy.xml" }),
    ],
    fetch: async input => {
      calls.push(String(input));
      return new Response(String(input).endsWith("/unsafe.xml") ? structuralDocuments.at(-1)! : healthyXml, { headers: { "content-type": "application/xml" } });
    },
  });
  assert.deepEqual(calls, ["https://example.com/unsafe.xml", "https://example.com/healthy.xml"]);
  assert.deepEqual(result.metrics.outcomes.map(outcome => outcome.reason), ["parse", "ok"]);
  assert.equal(result.observations.length, 1);
});

test("collector fetches configured feeds sequentially once with hardened request options", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const feeds = [feed({ id: "one", endpoint: "https://example.com/one.xml" }), feed({ id: "two", endpoint: "https://example.com/two.xml" })];
  const result = await collectRss({ now, feeds, fetch: async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(healthyXml, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
  } });
  assert.deepEqual(calls.map(call => call.url), feeds.map(entry => entry.endpoint));
  assert.ok(calls.every(call => call.init?.redirect === "manual" && call.init?.credentials === "omit" && call.init?.signal instanceof AbortSignal));
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.observations[0]?.provenance, { kind: "rss", feedId: "one", itemOrdinal: 1 });
  assert.deepEqual({ ...result.metrics, outcomes: result.metrics.outcomes.map(({ elapsedMs: _elapsedMs, ...outcome }) => outcome) }, {
    status: "collected", configuredFeeds: 2, attemptedFeeds: 2, succeededFeeds: 2, failedFeeds: 0,
    observedPositions: 2, validCandidates: 2, rejectedItems: 0, itemLimitTruncations: 0,
    outcomes: [{ feedId: "one", reason: "ok" }, { feedId: "two", reason: "ok" }],
  });
  assert.ok(result.metrics.outcomes.every(outcome => Number.isSafeInteger(outcome.elapsedMs) && outcome.elapsedMs >= 0));
});

test("collector succeeds with a workerd-compatible manual redirect policy", async () => {
  let calls = 0;
  const result = await collectRss({
    now,
    feeds: [feed()],
    fetch: async (_input, init) => {
      calls += 1;
      if (init?.redirect === "error") throw new TypeError("redirect error mode is unsupported");
      assert.equal(init?.redirect, "manual");
      return new Response(healthyXml, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.metrics.succeededFeeds, 1);
  assert.equal(result.metrics.failedFeeds, 0);
  assert.equal(result.observations.length, 1);
});

test("collector classifies manual redirects without following them", async () => {
  const statuses = [301, 302, 307, 308];
  const feeds = statuses.map((status, index) => feed({ id: `redirect_${status}`, endpoint: `https://example.com/feed-${index}.xml` }));
  const calls: string[] = [];
  const result = await collectRss({
    now,
    feeds,
    fetch: async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "manual");
      const status = statuses[calls.length - 1]!;
      return new Response(null, { status, headers: { location: `https://redirected.example/feed-${status}.xml` } });
    },
  });

  assert.deepEqual(calls, feeds.map(entry => entry.endpoint));
  assert.equal(calls.length, feeds.length);
  assert.equal(result.metrics.succeededFeeds, 0);
  assert.equal(result.metrics.failedFeeds, feeds.length);
  assert.deepEqual(result.metrics.outcomes.map(outcome => outcome.reason), statuses.map(() => "redirect"));
  assert.equal(result.observations.length, 0);
});

test("collector disables empty registry and fails closed on invalid configuration without fetch", async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return new Response(healthyXml); };
  const disabled = await collectRss({ now, feeds: [], fetch: fetcher });
  const invalid = await collectRss({ now, feeds: [feed(), feed()], fetch: fetcher });
  assert.equal(calls, 0);
  assert.equal(disabled.metrics.status, "disabled");
  assert.equal(invalid.metrics.status, "configuration");
});

test("collector isolates malformed, HTTP, media-type and body-limit failures", async () => {
  const feeds = [
    feed({ id: "bad_xml", endpoint: "https://example.com/bad.xml" }),
    feed({ id: "http_fail", endpoint: "https://example.com/http.xml" }),
    feed({ id: "html", endpoint: "https://example.com/html.xml" }),
    feed({ id: "large", endpoint: "https://example.com/large.xml" }),
    feed({ id: "healthy", endpoint: "https://example.com/healthy.xml" }),
  ];
  const result = await collectRss({ now, feeds, fetch: async input => {
    const path = new URL(String(input)).pathname;
    if (path === "/bad.xml") return new Response(`<rss><channel>`, { headers: { "content-type": "application/xml" } });
    if (path === "/http.xml") return new Response("failure", { status: 503, headers: { "content-type": "application/xml" } });
    if (path === "/html.xml") return new Response("<html/>", { headers: { "content-type": "text/html" } });
    if (path === "/large.xml") return new Response("x", { headers: { "content-type": "application/xml", "content-length": String(RSS_LIMITS.bodyBytes + 1) } });
    return new Response(healthyXml, { headers: { "content-type": "application/xml" } });
  } });
  assert.equal(result.metrics.failedFeeds, 4);
  assert.deepEqual(result.metrics.outcomes.map(outcome => outcome.reason), ["parse", "http", "encoding", "body_limit", "ok"]);
  assert.equal(result.observations.length, 1);
});

test("collector rejects invalid UTF-8 and decoded streamed bodies over the fixed limit", async () => {
  const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
  const oversized = new Uint8Array(RSS_LIMITS.bodyBytes + 1).fill(0x78);
  const feeds = [feed({ id: "encoding", endpoint: "https://example.com/encoding.xml" }), feed({ id: "large", endpoint: "https://example.com/large.xml" })];
  const result = await collectRss({ now, feeds, fetch: async input => new Response(String(input).includes("encoding") ? invalidUtf8 : oversized, { headers: { "content-type": "application/xml" } }) });
  assert.deepEqual(result.metrics.outcomes.map(outcome => outcome.reason), ["encoding", "body_limit"]);
  assert.equal(result.observations.length, 0);
});

test("collector deadline covers a stalled response body and cancels its reader", { timeout: 1000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => { cancelled = true; },
  });
  const pending = collectRss({
    now,
    feeds: [feed()],
    fetch: async () => new Response(body, { headers: { "content-type": "application/xml" } }),
  });
  await Promise.resolve();
  context.mock.timers.tick(RSS_LIMITS.timeoutMs);
  const result = await pending;
  assert.equal(result.metrics.outcomes[0]?.reason, "timeout");
  assert.equal(cancelled, true);
});

test("collector timeout does not await a stalled reader cancellation", { timeout: 1000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let cancellationStarted = false;
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => {
      cancellationStarted = true;
      return new Promise<void>(() => {});
    },
  });
  const pending = collectRss({
    now,
    feeds: [feed()],
    fetch: async () => new Response(body, { headers: { "content-type": "application/xml" } }),
  });
  await Promise.resolve();
  context.mock.timers.tick(RSS_LIMITS.timeoutMs);
  await Promise.resolve();
  const outcome = await Promise.race([
    pending.then(result => result.metrics.outcomes[0]?.reason),
    new Promise<"still_pending">(resolve => setImmediate(() => resolve("still_pending"))),
  ]);
  assert.equal(cancellationStarted, true);
  assert.equal(outcome, "timeout");
});

test("collector safely handles a rejected reader cancellation", { timeout: 1000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let cancellationStarted = false;
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => {
      cancellationStarted = true;
      return Promise.reject(new Error("private cancellation failure"));
    },
  });
  const pending = collectRss({
    now,
    feeds: [feed()],
    fetch: async () => new Response(body, { headers: { "content-type": "application/xml" } }),
  });
  await Promise.resolve();
  context.mock.timers.tick(RSS_LIMITS.timeoutMs);
  const result = await pending;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(cancellationStarted, true);
  assert.equal(result.metrics.outcomes[0]?.reason, "timeout");
});

test("collector deadline covers stalled response headers without retry", { timeout: 1000 }, async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pending = collectRss({ now, feeds: [feed()], fetch: async () => {
    calls += 1;
    return new Promise<Response>(() => {});
  } });
  await Promise.resolve();
  context.mock.timers.tick(RSS_LIMITS.timeoutMs);
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.metrics.outcomes[0]?.reason, "timeout");
});
