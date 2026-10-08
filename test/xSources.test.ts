import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_X_SOURCES, X_USAGE_LIMITS, isXDiscoveryEnabled, validateXSourceRegistry } from "../src/config/xSources.js";

test("P6 registry contains exactly the five human-approved opaque string IDs in fixed order", () => {
  validateXSourceRegistry();
  assert.deepEqual(APPROVED_X_SOURCES.map(({ approvedHandle, userId }) => ({ approvedHandle, userId })), [
    { approvedHandle: "OpenAI", userId: "4398626122" },
    { approvedHandle: "AnthropicAI", userId: "1353836358901501952" },
    { approvedHandle: "GoogleDeepMind", userId: "4783690002" },
    { approvedHandle: "github", userId: "13334762" },
    { approvedHandle: "Microsoft", userId: "74286565" },
  ]);
  assert.equal(typeof APPROVED_X_SOURCES[1].userId, "string");
  assert.deepEqual(X_USAGE_LIMITS, { requestsPerCycle: 5, requestsPerDay: 5, requestsPerIsoWeek: 35, requestsPerMonth: 155, reservedPostsPerRequest: 10, reservedPostsPerMonth: 1550, reservedMicroUsdPerMonth: 8_000_000 });
});

test("registry validation rejects duplicate, invalid and oversized registries", () => {
  const base = APPROVED_X_SOURCES[0];
  assert.throws(() => validateXSourceRegistry([base, base]), /duplicate/);
  assert.throws(() => validateXSourceRegistry([{ ...base, userId: "9007199254740993x" }]), /decimal strings/);
  assert.throws(() => validateXSourceRegistry([...APPROVED_X_SOURCES, { ...base, userId: "999" }]), /one to five/);
});

test("X discovery is disabled by default and invalid flags fail closed", () => {
  assert.equal(isXDiscoveryEnabled({}), false);
  assert.equal(isXDiscoveryEnabled({ X_DISCOVERY_ENABLED: "false" }), false);
  assert.equal(isXDiscoveryEnabled({ X_DISCOVERY_ENABLED: "true" }), true);
  assert.throws(() => isXDiscoveryEnabled({ X_DISCOVERY_ENABLED: "yes" }), /true or false/);
});
