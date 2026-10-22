import assert from "node:assert/strict";
import test from "node:test";

import { cleanDegradedSnippet } from "../src/services/degradedSnippet.js";

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

test("cleans ordinary and nested markup into plain text", () => {
  assert.equal(cleanDegradedSnippet("<strong>Hello</strong>"), "Hello");
  assert.equal(
    cleanDegradedSnippet("<div>Alpha <span>nested <em>words</em></span></div>"),
    "Alpha nested words",
  );
});

test("decodes only approved entities exactly once", () => {
  assert.equal(
    cleanDegradedSnippet("A &amp; B &lt; C &gt; D &quot;Q&quot; &apos;P&apos;&nbsp;Z"),
    "A & B < C > D \"Q\" 'P' Z",
  );
  assert.equal(cleanDegradedSnippet("&amp;lt;strong&amp;gt;kept&amp;lt;/strong&amp;gt;"), "&lt;strong&gt;kept&lt;/strong&gt;");
  assert.equal(cleanDegradedSnippet("&#60;b&#62;numeric&#60;/b&#62; &copy;"), "&#60;b&#62;numeric&#60;/b&#62; &copy;");
});

test("removes raw and once-decoded script and style blocks with their contents", () => {
  assert.equal(cleanDegradedSnippet("before<script>alert('private')</script>after"), "before after");
  assert.equal(cleanDegradedSnippet("before<style>.secret{display:block}</style>after"), "before after");
  assert.equal(cleanDegradedSnippet("safe &lt;script&gt;private&lt;/script&gt; end"), "safe end");
});

test("omits malformed markup tails and handles quoted greater-than characters", () => {
  assert.equal(cleanDegradedSnippet('before<a title="1 > 0">inside</a>after'), "before inside after");
  assert.equal(cleanDegradedSnippet("visible <broken private tail"), "visible");
  assert.equal(cleanDegradedSnippet("visible &lt;broken private tail"), "visible");
});

test("removes controls and normalizes whitespace", () => {
  assert.equal(cleanDegradedSnippet("\u0000 A\t\n B\r\u001f C \u007f"), "A B C");
  assert.equal(cleanDegradedSnippet(undefined), "");
  assert.equal(cleanDegradedSnippet(""), "");
});

test("bounds input before scanning and output at complete UTF-8 code points", () => {
  const hiddenPastInputLimit = `${"a".repeat(8192)}<script>private</script>`;
  const bounded = cleanDegradedSnippet(hiddenPastInputLimit);
  assert.equal(bytes(bounded), 768);
  assert.equal(bounded, "a".repeat(768));

  const multibyte = cleanDegradedSnippet("🙂".repeat(300));
  assert.equal(bytes(multibyte), 768);
  assert.equal(multibyte, "🙂".repeat(192));
  assert.equal(multibyte.includes("�"), false);
});

test("bounded scanner advances through adversarial markup without exposing it", () => {
  const repeated = '<a data-value="x > y">word</a>'.repeat(400);
  const output = cleanDegradedSnippet(repeated);
  assert.equal(bytes(output) <= 768, true);
  assert.equal(output.includes("<"), false);
  assert.equal(output.includes(">"), false);
  assert.match(output, /^word(?: word)* wor$/);
});
