import assert from "node:assert/strict";
import test from "node:test";

import { BATCH_ANALYSIS_INSTRUCTIONS, prepareBatchPrompt, truncateUtf8, utf8Length } from "../src/services/batchPrompt.js";
import type { BatchCandidate, BatchTruncationStage, PreparedBatch, SearchResult } from "../src/types/index.js";

const encoder = new TextEncoder();
const maximumPromptBytes = 32768;

function candidate(index: number, source: Partial<SearchResult> = {}): BatchCandidate {
  const result = { title: `Release ${index}`, url: `https://example.test/news-${index}`, snippet: `Useful change ${index}`, ...source };
  return {
    candidateId: `c${String(index).padStart(3, "0")}`, source: result,
    normalizedUrl: result.url, aliasKey: result.url, aliases: [result.url],
    provenance: [{ queryOrdinal: 1, resultOrdinal: 1 }],
  };
}

function payload(batch: PreparedBatch) {
  return JSON.parse(batch.prompt.slice(batch.prompt.indexOf("\n\n") + 2)) as {
    schemaVersion: number;
    candidates: Array<{ candidateId: string; title: string; snippet: string; url: string; publishedAt: string | null; queryOrdinals: number[] }>;
  };
}

function assertBounded(batch: PreparedBatch, input: readonly BatchCandidate[]): void {
  assert.equal(batch.promptBytes, encoder.encode(batch.prompt).length);
  assert.ok(batch.promptBytes <= maximumPromptBytes);
  assert.deepEqual(batch.candidates.map((c) => c.candidateId), input.slice(0, batch.candidates.length).map((c) => c.candidateId));
}

test("normal fifty-result pool is submitted together", () => {
  const input = Array.from({ length: 50 }, (_, index) => candidate(index + 1, {
    title: ["Compiler update", "Agent framework", "Cloud release", "IDE workflow", "Model launch"][index % 5] + ` ${index}`,
    url: `https://publisher-${index % 7}.test/releases/story-${index}?version=${index + 1}`,
    snippet: `Release ${index} provides a practical learning and building opportunity.`,
  }));
  const batch = prepareBatchPrompt(input);
  assertBounded(batch, input);
  assert.equal(batch.candidates.length, 50);
  assert.deepEqual(batch.candidates.map((c) => c.candidateId), input.map((c) => c.candidateId));
  assert.equal(batch.sizeExcluded, 0);
  assert.equal(batch.truncationStage, "initial");
  assert.ok(batch.prompt.startsWith(BATCH_ANALYSIS_INSTRUCTIONS + "\n\n"));
});

test("fixed-key JSON preserves full URLs and serializes sorted unique valid query ordinals", () => {
  const input = candidate(1, { title: " \t Original\n title  ", snippet: "  One\r\n two\tthree ", url: "https://EXAMPLE.test/news///?x=1#part" });
  input.normalizedUrl = "https://example.test/news?x=1#part";
  input.provenance = [8, 2, 8, 1, 10, 0, 11, 1.5].map((queryOrdinal) => ({ queryOrdinal, resultOrdinal: 1 }));
  const batch = prepareBatchPrompt([input], "instructions");
  assert.equal(batch.prompt, 'instructions\n\n{"schemaVersion":1,"candidates":[{"candidateId":"c001","title":"Original title","snippet":"One two three","url":"https://EXAMPLE.test/news///?x=1#part","publishedAt":null,"queryOrdinals":[1,2,8,10]}]}');
});

test("provider dates use UTC midnight or explicit timezone and reject relative, invalid and ambiguous values", () => {
  const dates: Array<[string | undefined, string | null]> = [
    ["2026-10-12", "2026-10-12T00:00:00.000Z"],
    ["2024-02-29", "2024-02-29T00:00:00.000Z"],
    ["2026-10-12T12:30:45+02:00", "2026-10-12T10:30:45.000Z"],
    ["2026-10-12T08:00:00.125Z", "2026-10-12T08:00:00.125Z"],
    ["2026-02-29", null], ["2026-02-30T12:00:00Z", null], ["2026-13-01", null],
    ["2026-10-12T08:00:00", null], ["2026-10-12T24:00:00Z", null],
    ["2026-10-12T12:00:00+25:00", null], ["yesterday", null], ["2 hours ago", null],
    ["October 12, 2026", null], ["", null], [undefined, null],
  ];
  const batch = prepareBatchPrompt(dates.map(([publishedAt], index) => candidate(index + 1, { publishedAt })), "dates");
  assert.deepEqual(payload(batch).candidates.map((c) => c.publishedAt), dates.map(([, expected]) => expected));
});

test("UTF-8 truncation respects code points and initial title/snippet limits", () => {
  assert.equal(utf8Length("😀éa"), 7);
  assert.equal(truncateUtf8("😀a", 4), "😀");
  assert.equal(truncateUtf8("😀a", 3), "");
  assert.equal(truncateUtf8("éabc", 3), "éa");
  assert.equal(truncateUtf8("text", 0), "");
  const input = candidate(1, { title: "😀".repeat(65), snippet: "é".repeat(385) });
  const batch = prepareBatchPrompt([input], "limits");
  assert.equal(payload(batch).candidates[0].title, "😀".repeat(64));
  assert.equal(payload(batch).candidates[0].snippet, "é".repeat(384));
  assertBounded(batch, [input]);
});

// Each literal cap catches skipped stages, restored snippets and escaped-byte undercounting.
const stages: Array<[BatchTruncationStage, number, number]> = [
  ["initial", 256, 768], ["snippet384", 256, 384], ["snippet192", 256, 192],
  ["snippet96", 256, 96], ["snippet0", 256, 0], ["title128", 128, 0],
];
for (const [stage, titleBytes, snippetBytes] of stages) {
  test(`RF1 Unicode and escaping at the prompt boundary: ${stage}`, () => {
    const input = [candidate(7, { title: '😀"\\'.repeat(80), snippet: '😀"\\'.repeat(160) })];
    // One repeated unit is 6 decoded UTF-8 bytes. The final emoji consumes 4 bytes.
    const expectedTitle = '😀"\\'.repeat(Math.floor(titleBytes / 6)) + (titleBytes % 6 >= 4 ? "😀" : "");
    const expectedSnippet = '😀"\\'.repeat(Math.floor(snippetBytes / 6)) + (snippetBytes % 6 >= 4 ? "😀" : "");
    const expectedJson = JSON.stringify({ schemaVersion: 1, candidates: [{
      candidateId: "c007", title: expectedTitle, snippet: expectedSnippet,
      url: "https://example.test/news-7", publishedAt: null, queryOrdinals: [1],
    }] });
    const instructions = "i".repeat(maximumPromptBytes - 2 - encoder.encode(expectedJson).length);
    const batch = prepareBatchPrompt(input, instructions);
    assertBounded(batch, input);
    assert.equal(batch.promptBytes, maximumPromptBytes);
    assert.equal(batch.truncationStage, stage);
    assert.equal(batch.sizeExcluded, 0);
    assert.equal(payload(batch).candidates[0].title, expectedTitle);
    assert.equal(payload(batch).candidates[0].snippet, expectedSnippet);
    assert.equal(batch.candidates[0], input[0]);
    assert.equal(batch.candidates[0].source.title, '😀"\\'.repeat(80));
    assert.equal(batch.candidates[0].source.url, "https://example.test/news-7");
  });
}

test("tail removal retains original IDs, full URLs and cumulative empty snippets", () => {
  const input = [7, 19, 42].map((id) => candidate(id, {
    title: "é".repeat(150), snippet: "😀".repeat(220),
    url: `https://example.test/news-${id}?data=` + "x".repeat(1800),
  }));
  const expectedJson = JSON.stringify({ schemaVersion: 1, candidates: input.slice(0, 2).map((c) => ({
    candidateId: c.candidateId, title: "é".repeat(64), snippet: "", url: c.source.url,
    publishedAt: null, queryOrdinals: [1],
  })) });
  const instructions = "i".repeat(maximumPromptBytes - 2 - encoder.encode(expectedJson).length);
  const before = JSON.stringify(input);
  for (const c of input) { Object.freeze(c.source); Object.freeze(c); }
  Object.freeze(input);
  const batch = prepareBatchPrompt(input, instructions);
  assertBounded(batch, input);
  assert.equal(batch.truncationStage, "tail");
  assert.equal(batch.sizeExcluded, 1);
  assert.equal(batch.promptBytes, maximumPromptBytes);
  assert.deepEqual(payload(batch).candidates.map((c) => c.candidateId), ["c007", "c019"]);
  assert.deepEqual(payload(batch).candidates.map((c) => c.snippet), ["", ""]);
  assert.deepEqual(payload(batch).candidates.map((c) => c.title), ["é".repeat(64), "é".repeat(64)]);
  assert.deepEqual(payload(batch).candidates.map((c) => c.url), input.slice(0, 2).map((c) => c.source.url));
  assert.equal(batch.candidates[0], input[0]);
  assert.equal(batch.candidates[1], input[1]);
  assert.equal(JSON.stringify(input), before);
});

test("preparation rejects empty input, instruction-only overflow and a pool with no fitting candidate", () => {
  assert.throws(() => prepareBatchPrompt([]), /empty|candidate/i);
  assert.throws(() => prepareBatchPrompt([candidate(1)], "😀".repeat(8193)), /instruction/i);
  assert.throws(() => prepareBatchPrompt([candidate(1)], "i".repeat(maximumPromptBytes)), /fit|candidate/i);
});

test("preparation preserves all original source evidence byte-for-byte", () => {
  const input = [candidate(1, { title: "  Original\t😀 title  ", snippet: "\nLong  snippet\t", publishedAt: "2026-10-12", source: "Original provider" })];
  const original = encoder.encode(JSON.stringify(input));
  const batch = prepareBatchPrompt(input);
  assert.deepEqual(encoder.encode(JSON.stringify(input)), original);
  assert.equal(batch.candidates[0].source, input[0].source);
  assert.equal(batch.candidates[0].source.title, "  Original\t😀 title  ");
  assert.equal(batch.candidates[0].source.publishedAt, "2026-10-12");
});
