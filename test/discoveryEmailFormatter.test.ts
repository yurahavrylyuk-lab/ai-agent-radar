import assert from "node:assert/strict";
import test from "node:test";
import { formatDiscoveryEmail } from "../src/services/discoveryEmailFormatter.js";
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
