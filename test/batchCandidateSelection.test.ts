import assert from "node:assert/strict";
import test from "node:test";

import { selectGeminiCandidates } from "../src/services/batchCandidateSelection.js";
import type { BatchCandidate, DiscoveryProvenance } from "../src/types/index.js";

function candidate(
  id: number,
  provenance: DiscoveryProvenance[],
  hostname = `host-${id}.example.test`,
): BatchCandidate {
  const url = `https://${hostname}/story-${id}`;
  return {
    candidateId: `c${String(id).padStart(3, "0")}`,
    source: { title: `Story ${id}`, url, snippet: `Snippet ${id}` },
    normalizedUrl: url,
    aliasKey: url,
    aliases: [url],
    provenance,
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function brave(id: number, queryOrdinal: number, resultOrdinal: number, hostname?: string): BatchCandidate {
  return candidate(id, [{ kind: "brave", queryOrdinal, resultOrdinal }], hostname);
}

function rss(id: number, feedId: string, itemOrdinal: number, hostname?: string): BatchCandidate {
  return candidate(id, [{ kind: "rss", feedId, itemOrdinal }], hostname);
}

function threads(id: number, queryId: "ai_agents" | "claude_code" | "codex", resultOrdinal: number, hostname = "www.threads.net"): BatchCandidate {
  return candidate(id, [{ kind: "threads", queryId, postId: String(10_000 + id), resultOrdinal }], hostname);
}

test("caps_at_24_without_mutation", () => {
  const input = freezeDeep(Array.from({ length: 47 }, (_, index) => brave(index + 1, index % 10 + 1, Math.floor(index / 10) + 1)));
  const before = structuredClone(input);

  const result = selectGeminiCandidates(input);

  assert.equal(result.preFilterInputCount, 47);
  assert.equal(result.candidates.length, 24);
  assert.equal(result.selectorExcluded, 23);
  assert.deepEqual(input, before);
  assert.equal(result.candidates.every(selected => input.includes(selected)), true);
  assert.equal(new Set(result.candidates.map(selected => selected.candidateId)).size, 24);
  assert.deepEqual(selectGeminiCandidates(input).candidates.map(item => item.candidateId), result.candidates.map(item => item.candidateId));
  assert.deepEqual(selectGeminiCandidates([]), { candidates: [], preFilterInputCount: 0, selectorExcluded: 0 });
});

test("stable_query_feed_round_robin", () => {
  const braveCandidates = Array.from({ length: 30 }, (_, index) => brave(index + 1, index % 10 + 1, Math.floor(index / 10) + 1));
  const feedIds = ["openai_news", "github_changelog", "cloudflare_ai", "chrome_developers"];
  const rssCandidates = Array.from({ length: 16 }, (_, index) => rss(31 + index, feedIds[index % 4]!, Math.floor(index / 4) + 1));

  const selected = selectGeminiCandidates([...rssCandidates, ...braveCandidates]).candidates;
  const braveSelected = selected.filter(item => item.provenance.some(entry => entry.kind === "brave"));
  const rssSelected = selected.filter(item => item.provenance.every(entry => entry.kind === "rss"));

  assert.equal(selected.length, 24);
  assert.equal(braveSelected.length, 18);
  assert.equal(rssSelected.length, 6);
  assert.deepEqual(selected.slice(0, 8).map(item => item.provenance.some(entry => entry.kind === "brave") ? "B" : "R"), ["B", "B", "B", "R", "B", "B", "B", "R"]);
  assert.deepEqual(new Set(braveSelected.flatMap(item => item.provenance.filter(entry => entry.kind === "brave").map(entry => entry.queryOrdinal))), new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  assert.deepEqual(new Set(rssSelected.flatMap(item => item.provenance.filter(entry => entry.kind === "rss").map(entry => entry.feedId))), new Set(feedIds));
});

test("borrows_in_both_directions", () => {
  const braveOnly = Array.from({ length: 30 }, (_, index) => brave(index + 1, index % 10 + 1, Math.floor(index / 10) + 1));
  assert.equal(selectGeminiCandidates(braveOnly).candidates.length, 24);

  const feedIds = ["openai_news", "github_changelog", "cloudflare_ai", "chrome_developers"];
  const rssOnly = Array.from({ length: 20 }, (_, index) => rss(index + 1, feedIds[index % 4]!, Math.floor(index / 4) + 1));
  assert.equal(selectGeminiCandidates(rssOnly).candidates.length, 20);

  const mixedMostlyRss = [brave(41, 1, 1), brave(42, 2, 1), ...rssOnly];
  assert.equal(selectGeminiCandidates(mixedMostlyRss).candidates.length, 22);

  const mixedMostlyBrave = [...braveOnly, rss(43, "openai_news", 1), rss(44, "github_changelog", 1)];
  const selected = selectGeminiCandidates(mixedMostlyBrave).candidates;
  assert.equal(selected.length, 24);
  assert.equal(selected.filter(item => item.provenance.every(entry => entry.kind === "rss")).length, 2);
});

test("host_cap_relaxes_only_after_no_progress", () => {
  const candidates: BatchCandidate[] = [];
  for (let query = 1; query <= 10; query += 1) {
    candidates.push(brave(candidates.length + 1, query, 1, "dominant.example.test"));
    candidates.push(brave(candidates.length + 1, query, 2, `alternative-${query}.example.test`));
    candidates.push(brave(candidates.length + 1, query, 3, "dominant.example.test"));
  }
  const selected = selectGeminiCandidates(candidates).candidates;
  const dominantPositions = selected.map((item, index) => item.normalizedUrl.includes("dominant.example.test") ? index : -1).filter(index => index >= 0);

  assert.equal(selected.length, 24);
  assert.deepEqual(dominantPositions.slice(0, 2), [0, 1]);
  assert.equal(selected.slice(2, 12).every(item => !item.normalizedUrl.includes("dominant.example.test")), true);

  const singleHost = Array.from({ length: 47 }, (_, index) => brave(index + 1, index % 10 + 1, Math.floor(index / 10) + 1, "single.example.test"));
  assert.equal(selectGeminiCandidates(singleHost).candidates.length, 24);
});

test("dual_provenance_is_selected_once", () => {
  const dual = candidate(1, [
    { kind: "rss", feedId: "openai_news", itemOrdinal: 1 },
    { kind: "brave", queryOrdinal: 2, resultOrdinal: 1 },
    { kind: "brave", queryOrdinal: 1, resultOrdinal: 2 },
  ]);
  const input = [dual, brave(2, 1, 1), rss(3, "github_changelog", 1)];

  const selected = selectGeminiCandidates(input).candidates;

  assert.equal(selected.filter(item => item === dual).length, 1);
  assert.deepEqual(selected.map(item => item.candidateId), ["c002", "c001", "c003"]);
  assert.equal(selected[1], dual);
  assert.deepEqual(dual.provenance, [
    { kind: "rss", feedId: "openai_news", itemOrdinal: 1 },
    { kind: "brave", queryOrdinal: 2, resultOrdinal: 1 },
    { kind: "brave", queryOrdinal: 1, resultOrdinal: 2 },
  ]);
});

test("saturated_three_sources_select_12_6_6", () => {
  const braveCandidates = Array.from({ length: 30 }, (_, index) => brave(index + 1, index % 10 + 1, Math.floor(index / 10) + 1));
  const feeds = ["openai_news", "github_changelog", "cloudflare_ai", "chrome_developers"];
  const rssCandidates = Array.from({ length: 20 }, (_, index) => rss(31 + index, feeds[index % feeds.length]!, Math.floor(index / feeds.length) + 1));
  const queries = ["ai_agents", "claude_code", "codex"] as const;
  const threadCandidates = Array.from({ length: 15 }, (_, index) => threads(51 + index, queries[index % 3]!, Math.floor(index / 3) + 1));
  const selected = selectGeminiCandidates([...threadCandidates, ...rssCandidates, ...braveCandidates]).candidates;
  const ownership = selected.map(item => item.provenance.some(p => p.kind === "brave") ? "B" : item.provenance.some(p => p.kind === "rss") ? "R" : "T");
  assert.deepEqual(ownership.slice(0, 4), ["B", "R", "B", "T"]);
  assert.deepEqual({ B: ownership.filter(x => x === "B").length, R: ownership.filter(x => x === "R").length, T: ownership.filter(x => x === "T").length }, { B: 12, R: 6, T: 6 });
});

test("borrowing_uses_brave_rss_threads_order", () => {
  const queries = ["ai_agents", "claude_code", "codex"] as const;
  const manyThreads = Array.from({ length: 15 }, (_, index) => threads(50 + index, queries[index % 3]!, Math.floor(index / 3) + 1));
  const manyBrave = Array.from({ length: 30 }, (_, index) => brave(index + 1, index % 10 + 1, Math.floor(index / 10) + 1));
  const oneRss = rss(40, "openai_news", 1);
  const first = selectGeminiCandidates([...manyThreads, oneRss, ...manyBrave]).candidates;
  assert.equal(first.filter(item => item === oneRss).length, 1);
  assert.equal(first.filter(item => item.provenance.some(p => p.kind === "threads")).length, 6);
  assert.equal(first.filter(item => item.provenance.some(p => p.kind === "brave")).length, 17);

  const rssMany = Array.from({ length: 20 }, (_, index) => rss(index + 1, ["openai_news", "github_changelog", "cloudflare_ai", "chrome_developers"][index % 4]!, Math.floor(index / 4) + 1));
  const noBrave = selectGeminiCandidates([...rssMany, ...manyThreads]).candidates;
  assert.equal(noBrave.filter(item => item.provenance.some(p => p.kind === "rss")).length, 18);
  assert.equal(noBrave.filter(item => item.provenance.some(p => p.kind === "threads")).length, 6);
});
