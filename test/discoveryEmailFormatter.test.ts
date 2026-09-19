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

test("formats the discovery details in a concise subject and plain text", () => {
  const content = formatDiscoveryEmail(discovery());
  assert.match(content.subject, /Example Agent/);
  assert.match(content.text, /Relevance: 8\/10/);
  assert.match(content.text, /A concise discovery summary\./);
  assert.match(content.text, /It is useful to study\./);
  assert.match(content.text, /\* Build a prototype/);
  assert.match(content.text, /\* Create a teaching demo/);
  assert.match(content.text, /TypeScript, MCP/);
  assert.match(content.text, /https:\/\/example\.com\/discovery/);
});

test("formats a clickable source link and project opportunities as HTML list items", () => {
  const content = formatDiscoveryEmail(discovery());
  assert.match(content.html, /<a href="https:\/\/example\.com\/discovery">https:\/\/example\.com\/discovery<\/a>/);
  assert.match(content.html, /<ul><li>Build a prototype<\/li><li>Create a teaching demo<\/li><\/ul>/);
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

test("does not mutate the stored discovery", () => {
  const input = discovery();
  const original = structuredClone(input);
  formatDiscoveryEmail(input);
  assert.deepEqual(input, original);
});
