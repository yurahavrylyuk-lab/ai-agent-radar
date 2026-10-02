import assert from "node:assert/strict";
import test from "node:test";
import { formatDiscoveryEmail, formatDigestEmail } from "../src/services/discoveryEmailFormatter.js";
import type { StoredDiscovery } from "../src/types/index.js";

function discovery(): StoredDiscovery {
  return {
    normalizedUrl: "https://example.com/discovery",
    firstSeenAt: "2026-09-19T12:00:00.000Z",
    lastSeenAt: "2026-09-19T12:00:00.000Z",
    analysis: {
      name: "Example Agent",
      category: "new_agent",
      summary: "A concise discovery summary.",
      relevanceScore: 8,
      whyItMatters: "It provides useful building patterns.",
      educationalValue: "It is useful to study.",
      projectOpportunities: ["Build a prototype", "Create a teaching demo"],
      technologies: ["TypeScript", "MCP"],
      sourceTitle: "Example source",
      sourceUrl: "https://example.com/discovery",
    },
  };
}

test("formats every essential discovery field in the dark HTML briefing", () => {
  const content = formatDiscoveryEmail(discovery());

  assert.match(content.subject, /Example Agent/);
  assert.match(content.html, /AI AGENT RADAR/);
  assert.match(content.html, /New discovery/);
  assert.match(content.html, /Example Agent/);
  assert.match(content.html, /New Agent/);
  assert.match(content.html, /8\/10/);
  assert.match(content.html, /A concise discovery summary\./);
  assert.match(content.html, /It provides useful building patterns\./);
  assert.match(content.html, /It is useful to study\./);
  assert.match(content.html, /Build a prototype/);
  assert.match(content.html, /Create a teaching demo/);
  assert.match(content.html, /TypeScript/);
  assert.match(content.html, /MCP/);
  assert.match(content.html, /Example source/);
  assert.match(content.html, /https:\/\/example\.com\/discovery/);
});

test("uses the original safe source URL in the CTA link", () => {
  const content = formatDiscoveryEmail(discovery());

  assert.match(content.html, /href="https:\/\/example\.com\/discovery"/);
  assert.match(content.html, /View original source/);
});

test("plain-text fallback retains all essential discovery information", () => {
  const content = formatDiscoveryEmail(discovery());

  assert.match(content.text, /Example Agent/);
  assert.match(content.text, /Category: New Agent/);
  assert.match(content.text, /Relevance: 8\/10/);
  assert.match(content.text, /A concise discovery summary\./);
  assert.match(content.text, /It provides useful building patterns\./);
  assert.match(content.text, /It is useful to study\./);
  assert.match(content.text, /- Build a prototype/);
  assert.match(content.text, /- Create a teaching demo/);
  assert.match(content.text, /TypeScript, MCP/);
  assert.match(content.text, /Example source/);
  assert.match(content.text, /https:\/\/example\.com\/discovery/);
});

test("escapes model-derived HTML and safely represents dynamic source data", () => {
  const input = discovery();
  input.analysis.name = "<script>alert('name')</script>";
  input.analysis.summary = "<img src=x onerror=alert(1)> & \"quoted\"";
  input.analysis.projectOpportunities = ["<script>alert('opportunity')</script>"];
  input.analysis.technologies = ["<b>TypeScript</b>"];
  input.analysis.sourceTitle = "<b>Untrusted source</b>";
  input.analysis.sourceUrl = "https://example.com/?label=\"quoted\"&value=<tag>";

  const content = formatDiscoveryEmail(input);

  assert.doesNotMatch(content.html, /<script>|<img |<b>/);
  assert.match(content.html, /&lt;script&gt;alert\(&#39;name&#39;\)&lt;\/script&gt;/);
  assert.match(content.html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quoted&quot;/);
  assert.match(content.html, /&lt;b&gt;Untrusted source&lt;\/b&gt;/);
  assert.match(content.html, /href="https:\/\/example\.com\/\?label=&quot;quoted&quot;&amp;value=&lt;tag&gt;"/);
});

test("does not turn an unsafe source scheme into an active link", () => {
  const input = discovery();
  input.analysis.sourceUrl = "javascript:alert('unsafe')";

  const content = formatDiscoveryEmail(input);

  assert.match(content.html, /href="#"/);
  assert.doesNotMatch(content.html, /href="javascript:/i);
  assert.match(content.html, /javascript:alert\(&#39;unsafe&#39;\)/);
});

test("does not mutate the stored discovery", () => {
  const input = discovery();
  const original = structuredClone(input);

  formatDiscoveryEmail(input);

  assert.deepEqual(input, original);
});

// ── formatDigestEmail ─────────────────────────────────────────────────────────

function digestStory(id: string, relevanceScore = 8): StoredDiscovery {
  return {
    normalizedUrl: `https://example.com/${id}`,
    firstSeenAt: "2026-09-19T12:00:00.000Z",
    lastSeenAt: "2026-09-19T12:00:00.000Z",
    analysis: {
      name: `Story ${id}`,
      category: "new_agent",
      summary: `Summary of ${id}.`,
      relevanceScore,
      whyItMatters: `Why ${id} matters.`,
      educationalValue: `Learn from ${id}.`,
      projectOpportunities: [`Build with ${id}`, `Extend ${id}`],
      technologies: ["TypeScript"],
      sourceTitle: `Source ${id}`,
      sourceUrl: `https://example.com/${id}`,
    },
  };
}

test("digest lead story renders an h2 with the story name, summary, why-it-matters, and key-points list", () => {
  const content = formatDigestEmail([digestStory("lead"), digestStory("two")]);

  assert.match(content.html, /<h2[^>]*>[\s\S]*?Story lead[\s\S]*?<\/h2>/);
  assert.match(content.html, /Summary of lead\./);
  assert.match(content.html, /[Ww]hy it matters/);
  assert.match(content.html, /Why lead matters\./);
  assert.match(content.html, /<ul/);
  assert.match(content.html, /<li[^>]*>[\s\S]*?Build with lead/);
  assert.doesNotMatch(content.html, /<ul[^>]*><ul/, "key-points list must not nest <ul> directly inside <ul>");
});

test("digest concise stories render story name, summary, and source link without h2", () => {
  const content = formatDigestEmail([digestStory("lead"), digestStory("two"), digestStory("three")]);

  assert.match(content.html, /Story two/);
  assert.match(content.html, /Summary of two\./);
  assert.match(content.html, /href="https:\/\/example\.com\/two"/);
  assert.doesNotMatch(content.html, /<h2[^>]*>[\s\S]*?Story two[\s\S]*?<\/h2>/);
});

test("digest subject includes the lead story name and a count of additional stories", () => {
  const one = formatDigestEmail([digestStory("alpha")]);
  assert.match(one.subject, /Story alpha/);
  assert.doesNotMatch(one.subject, /\+ \d+ more/);

  const four = formatDigestEmail([digestStory("alpha"), digestStory("beta"), digestStory("gamma"), digestStory("delta")]);
  assert.match(four.subject, /Story alpha/);
  assert.match(four.subject, /\+ 3 more/);
});

test("digest with one story renders only the lead format", () => {
  const content = formatDigestEmail([digestStory("only")]);

  assert.match(content.html, /<h2[^>]*>[\s\S]*?Story only[\s\S]*?<\/h2>/);
  assert.doesNotMatch(content.html, /Story 2/);
});

test("digest with four stories renders one lead and three concise blocks", () => {
  const content = formatDigestEmail([digestStory("a"), digestStory("b"), digestStory("c"), digestStory("d")]);

  assert.match(content.html, /<h2[^>]*>[\s\S]*?Story a[\s\S]*?<\/h2>/);
  assert.match(content.html, /Story 2/);
  assert.match(content.html, /Story 3/);
  assert.match(content.html, /Story 4/);
});

test("digest plain-text body contains lead detail and concise summaries", () => {
  const content = formatDigestEmail([digestStory("alpha"), digestStory("beta")]);

  assert.match(content.text, /STORY 1 — LEAD/);
  assert.match(content.text, /Story alpha/);
  assert.match(content.text, /WHY IT MATTERS/);
  assert.match(content.text, /Why alpha matters\./);
  assert.match(content.text, /KEY POINTS/);
  assert.match(content.text, /Build with alpha/);
  assert.match(content.text, /STORY 2/);
  assert.match(content.text, /Summary of beta\./);
});

test("digest escapes model-derived HTML in lead and concise slots", () => {
  const lead = digestStory("lead");
  lead.analysis.name = "<script>alert('xss')</script>";
  lead.analysis.summary = "<img src=x onerror=alert(1)>";
  lead.analysis.whyItMatters = "<b>bold</b>";
  lead.analysis.projectOpportunities = ["<evil>point</evil>"];

  const conciseStory = digestStory("two");
  conciseStory.analysis.name = "<b>concise</b>";
  conciseStory.analysis.summary = "<i>italic</i>";

  const content = formatDigestEmail([lead, conciseStory]);

  assert.doesNotMatch(content.html, /<script>|<img |<b>|<i>|<evil>/);
  assert.match(content.html, /&lt;script&gt;/);
  assert.match(content.html, /&lt;b&gt;concise&lt;\/b&gt;/);
});

test("formatDigestEmail does not mutate stored discoveries", () => {
  const stories = [digestStory("a"), digestStory("b")];
  const originals = stories.map((s) => structuredClone(s));

  formatDigestEmail(stories);

  assert.deepEqual(stories, originals);
});
