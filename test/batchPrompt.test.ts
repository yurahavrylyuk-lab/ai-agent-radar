import assert from "node:assert/strict";
import test from "node:test";

import { BATCH_ANALYSIS_INSTRUCTIONS, prepareBatchPrompt, truncateUtf8, utf8Length } from "../src/services/batchPrompt.js";
import type { BatchCandidate, BatchTruncationStage, PreparedBatch, SearchResult } from "../src/types/index.js";

const encoder = new TextEncoder();
const maximumPromptBytes = 12288;

function candidate(index: number, source: Partial<SearchResult> = {}): BatchCandidate {
  const result = { title: `Release ${index}`, url: `https://example.test/news-${index}`, snippet: `Useful change ${index}`, ...source };
  return {
    candidateId: `c${String(index).padStart(3, "0")}`, source: result,
    normalizedUrl: result.url, aliasKey: result.url, aliases: [result.url],
    provenance: [{ kind: "brave", queryOrdinal: 1, resultOrdinal: 1 }],
  };
}

function payload(batch: PreparedBatch) {
  return JSON.parse(batch.prompt.slice(batch.prompt.indexOf("\n\n") + 2)) as {
    schemaVersion: number;
    candidates: Array<{ candidateId: string; title: string; snippet: string; sourceHost: string | null; publishedAt: string | null }>;
  };
}

function assertBounded(batch: PreparedBatch, input: readonly BatchCandidate[]): void {
  assert.equal(batch.promptBytes, encoder.encode(batch.prompt).length);
  assert.ok(batch.promptBytes <= maximumPromptBytes);
  assert.deepEqual(batch.candidates.map((c) => c.candidateId), input.slice(0, batch.candidates.length).map((c) => c.candidateId));
}

test("normal twenty-four-result selection is submitted together", () => {
  const input = Array.from({ length: 24 }, (_, index) => candidate(index + 1, {
    title: ["Compiler update", "Agent framework", "Cloud release", "IDE workflow", "Model launch"][index % 5] + ` ${index}`,
    url: `https://publisher-${index % 7}.test/releases/story-${index}?version=${index + 1}`,
    snippet: `Release ${index} provides a practical learning and building opportunity.`,
  }));
  const batch = prepareBatchPrompt(input);
  assertBounded(batch, input);
  assert.equal(batch.candidates.length, 24);
  assert.deepEqual(batch.candidates.map((c) => c.candidateId), input.map((c) => c.candidateId));
  assert.equal(batch.sizeExcluded, 0);
  assert.equal(batch.truncationStage, "initial");
  assert.ok(batch.prompt.startsWith(BATCH_ANALYSIS_INSTRUCTIONS + "\n\n"));
});

test("batch instructions ask for the best bounded stories regardless of score", () => {
  assert.match(BATCH_ANALYSIS_INSTRUCTIONS, /up to four best/i);
  assert.match(BATCH_ANALYSIS_INSTRUCTIONS, /integer relevanceScore from 1 to 10/i);
  assert.match(BATCH_ANALYSIS_INSTRUCTIONS, /do not omit.*solely.*below 7/i);
  assert.doesNotMatch(BATCH_ANALYSIS_INSTRUCTIONS, /relevanceScore >= 7/);
});

test("prompt has only compact candidate fields while original evidence remains application-owned", () => {
  const input = candidate(1, { title: " \t Original\n title  ", snippet: "  One\r\n two\tthree ", url: "https://EXAMPLE.test/news///?x=1#part" });
  input.normalizedUrl = "https://example.test/news?x=1#part";
  input.provenance = [8, 2, 8, 1, 10, 0, 11, 1.5].map((queryOrdinal) => ({ kind: "brave" as const, queryOrdinal, resultOrdinal: 1 }));
  const batch = prepareBatchPrompt([input], "instructions");
  assert.equal(batch.prompt, 'instructions\n\n{"schemaVersion":1,"candidates":[{"candidateId":"c001","title":"Original title","snippet":"One two three","sourceHost":"example.test","publishedAt":null}]}');
  assert.deepEqual(Object.keys(payload(batch).candidates[0]), ["candidateId", "title", "snippet", "sourceHost", "publishedAt"]);
  assert.equal(batch.candidates[0], input);
  assert.equal(batch.candidates[0].source.url, "https://EXAMPLE.test/news///?x=1#part");
  assert.equal(batch.candidates[0].source.title, " \t Original\n title  ");
  assert.equal(batch.candidates[0].provenance, input.provenance);
});

test("RSS-only candidates submit their normalized hostname without provenance on the wire", () => {
  const input = candidate(1, { title: "RSS release", url: "https://example.test/rss-release" });
  input.provenance = [{ kind: "rss", feedId: "openai_news", itemOrdinal: 1 }];
  assert.deepEqual(payload(prepareBatchPrompt([input], "instructions")).candidates[0], {
    candidateId: "c001", title: "RSS release", snippet: "Useful change 1", sourceHost: "example.test", publishedAt: null,
  });
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

test("UTF-8 truncation respects code points and initial 160/192 title/snippet limits", () => {
  assert.equal(utf8Length("😀éa"), 7);
  assert.equal(truncateUtf8("😀a", 4), "😀");
  assert.equal(truncateUtf8("😀a", 3), "");
  assert.equal(truncateUtf8("éabc", 3), "éa");
  assert.equal(truncateUtf8("text", 0), "");
  const input = candidate(1, { title: "😀".repeat(65), snippet: "é".repeat(385) });
  const batch = prepareBatchPrompt([input], "limits");
  assert.equal(payload(batch).candidates[0].title, "😀".repeat(40));
  assert.equal(payload(batch).candidates[0].snippet, "é".repeat(96));
  assert.equal(batch.snippetBytesLimit, 192);
  assertBounded(batch, [input]);
});

test("sourceHost is exact up to 128 UTF-8 bytes and otherwise null", () => {
  const short = candidate(1);
  short.normalizedUrl = `https://${"a".repeat(123)}.test/path`;
  const long = candidate(2);
  long.normalizedUrl = `https://${"a".repeat(124)}.test/path`;
  assert.equal(utf8Length(new URL(short.normalizedUrl).hostname), 128);
  assert.equal(utf8Length(new URL(long.normalizedUrl).hostname), 129);
  assert.deepEqual(payload(prepareBatchPrompt([short, long], "hosts")).candidates.map((item) => item.sourceHost), [new URL(short.normalizedUrl).hostname, null]);
});

test("prompt bytes include JSON escaping, controls and emoji and remain deterministic", () => {
  const input = Array.from({ length: 24 }, (_, index) => candidate(index + 1, {
    title: `\"\\\n😀 ${index} `.repeat(30), snippet: `\"\\\t😀 ${index} `.repeat(50),
  }));
  const first = prepareBatchPrompt(input, "i".repeat(3072));
  const second = prepareBatchPrompt(input, "i".repeat(3072));
  assert.equal(first.prompt, second.prompt);
  assert.equal(first.promptBytes, encoder.encode(first.prompt).length);
  assert.ok(first.promptBytes <= maximumPromptBytes);
  assert.doesNotMatch(first.prompt, /�/u);
});

// Each literal cap catches skipped stages, restored snippets and escaped-byte undercounting.
const stages: Array<[BatchTruncationStage, number, 192 | 128 | 96 | 0, number, "big" | "title"]> = [
  ["initial", 160, 192, 1, "title"], ["snippet128", 160, 128, 1, "big"],
  ["snippet96", 160, 96, 877, "big"], ["snippet0", 160, 0, 1837, "big"],
  ["title128", 128, 0, 2317, "title"],
];
for (const [stage, titleBytes, snippetBytes, instructionBytes, fixture] of stages) {
  test(`uniform reduction reaches the expected stage: ${stage}`, () => {
    const unit = fixture === "big" ? '😀"\\' : '"\\';
    const input = Array.from({ length: 24 }, (_, index) => candidate(index + 1, {
      title: unit.repeat(fixture === "big" ? 80 : 100), snippet: fixture === "big" ? '😀"\\'.repeat(160) : "",
    }));
    // One repeated unit is 6 decoded UTF-8 bytes. The final emoji consumes 4 bytes.
    const unitBytes = fixture === "big" ? 6 : 2;
    const expectedTitle = unit.repeat(Math.floor(titleBytes / unitBytes)) + (fixture === "big" && titleBytes % unitBytes >= 4 ? "😀" : "");
    const expectedSnippet = fixture === "big"
      ? '😀"\\'.repeat(Math.floor(snippetBytes / 6)) + (snippetBytes % 6 >= 4 ? "😀" : "")
      : "";
    const batch = prepareBatchPrompt(input, "i".repeat(instructionBytes));
    assertBounded(batch, input);
    assert.equal(batch.truncationStage, stage);
    assert.equal(batch.snippetBytesLimit, snippetBytes);
    assert.equal(batch.sizeExcluded, 0);
    assert.equal(payload(batch).candidates[0].title, expectedTitle);
    assert.equal(payload(batch).candidates[0].snippet, expectedSnippet);
    assert.equal(batch.candidates[0], input[0]);
    assert.equal(batch.candidates[0].source.url, "https://example.test/news-1");
  });
}

test("ordered tail removal retains original IDs and full application-owned evidence", () => {
  const input = Array.from({ length: 24 }, (_, index) => candidate(index + 1, {
    title: '\\"'.repeat(160), snippet: "😀".repeat(220), url: `https://${"a".repeat(55)}${index}.test/story`,
  }));
  const instructions = "i".repeat(3072);
  const before = JSON.stringify(input);
  const batch = prepareBatchPrompt(input, instructions);
  assertBounded(batch, input);
  assert.equal(batch.truncationStage, "tail");
  assert.ok(batch.sizeExcluded > 0);
  assert.equal(batch.snippetBytesLimit, 0);
  assert.deepEqual(payload(batch).candidates.map((c) => c.candidateId), input.slice(0, batch.candidates.length).map((c) => c.candidateId));
  assert.deepEqual(payload(batch).candidates.map((c) => c.snippet), Array(batch.candidates.length).fill(""));
  assert.ok(payload(batch).candidates.every((c) => utf8Length(c.title) <= 128));
  assert.ok(batch.candidates.every((item, index) => item === input[index]));
  assert.equal(JSON.stringify(input), before);
});

test("preparation rejects empty input, instruction-only overflow and a pool with no fitting candidate", () => {
  assert.throws(() => prepareBatchPrompt([]), /empty|candidate/i);
  assert.throws(() => prepareBatchPrompt(Array.from({ length: 25 }, (_, index) => candidate(index + 1))), /24|candidate/i);
  assert.throws(() => prepareBatchPrompt([candidate(1)], "😀".repeat(769)), /instruction/i);
  assert.throws(() => prepareBatchPrompt([candidate(1)], "i".repeat(3073)), /instruction/i);
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
