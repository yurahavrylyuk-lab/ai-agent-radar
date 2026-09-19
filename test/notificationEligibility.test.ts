import assert from "node:assert/strict";
import test from "node:test";
import { isNotificationEligible, NOTIFICATION_RELEVANCE_THRESHOLD } from "../src/services/notificationEligibility.js";
import type { DiscoveryProcessingResult } from "../src/types/index.js";

function result(status: DiscoveryProcessingResult["status"], relevanceScore: number): DiscoveryProcessingResult {
  return {
    status,
    discovery: {
      normalizedUrl: "https://example.com/discovery",
      firstSeenAt: "2026-09-19T12:00:00.000Z",
      lastSeenAt: "2026-09-19T12:00:00.000Z",
      analysis: {
        name: "Example Agent",
        category: "new_agent",
        summary: "A test analysis.",
        relevanceScore,
        whyItMatters: "It is useful for testing.",
        educationalValue: "It demonstrates eligibility.",
        projectOpportunities: ["Build a prototype"],
        technologies: ["TypeScript"],
        sourceTitle: "Example discovery",
        sourceUrl: "https://example.com/discovery",
      },
    },
  };
}

test("new discoveries below the threshold are not eligible", () => {
  assert.equal(isNotificationEligible(result("new", 1)), false);
  assert.equal(isNotificationEligible(result("new", 6)), false);
});

test("new discoveries at and above the threshold are eligible", () => {
  assert.equal(NOTIFICATION_RELEVANCE_THRESHOLD, 7);
  assert.equal(isNotificationEligible(result("new", 7)), true);
  assert.equal(isNotificationEligible(result("new", 8)), true);
  assert.equal(isNotificationEligible(result("new", 10)), true);
});

test("duplicate discoveries are never eligible regardless of relevance", () => {
  assert.equal(isNotificationEligible(result("duplicate", 7)), false);
  assert.equal(isNotificationEligible(result("duplicate", 10)), false);
});

test("eligibility evaluation does not mutate its input", () => {
  const input = result("new", 7);
  const original = structuredClone(input);
  assert.equal(isNotificationEligible(input), true);
  assert.deepEqual(input, original);
});
