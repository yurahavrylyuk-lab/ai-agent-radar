import assert from "node:assert/strict";
import test from "node:test";
import { TRUSTED_SOURCE_REGISTRY, type TrustedSourceRegistry } from "../src/config/trustedSources.js";
import { isTrustedFallbackSource } from "../src/services/sourceTrust.js";

const APPROVED_HOSTNAMES = [
  "openai.com",
  "developers.openai.com",
  "platform.openai.com",
  "anthropic.com",
  "docs.anthropic.com",
  "blog.google",
  "ai.google.dev",
  "github.blog",
  "github.com",
  "devblogs.microsoft.com",
  "learn.microsoft.com",
  "aws.amazon.com",
  "cloud.google.com",
  "azure.microsoft.com",
  "kubernetes.io",
  "nodejs.org",
  "python.org",
  "go.dev",
  "www.rust-lang.org",
  "www.typescriptlang.org",
] as const;

test("trusted-source registry contains exactly the human-approved hostnames", () => {
  assert.equal(TRUSTED_SOURCE_REGISTRY.version, 1);
  assert.deepEqual(TRUSTED_SOURCE_REGISTRY.approvedHostnames, APPROVED_HOSTNAMES);
  assert.equal(Object.isFrozen(TRUSTED_SOURCE_REGISTRY), true);
  assert.equal(Object.isFrozen(TRUSTED_SOURCE_REGISTRY.approvedHostnames), true);
});

test("every approved exact hostname is recognized deterministically", () => {
  for (const hostname of APPROVED_HOSTNAMES) {
    const sourceUrl = `https://${hostname}/release`;
    assert.equal(isTrustedFallbackSource(sourceUrl), true, hostname);
    assert.equal(isTrustedFallbackSource(sourceUrl), true, `${hostname} repeated`);
  }
});

test("source trust normalizes URL hostname case, one terminal dot, and default ports", () => {
  assert.equal(isTrustedFallbackSource("https://OPENAI.COM/release"), true);
  assert.equal(isTrustedFallbackSource("https://openai.com./release"), true);
  assert.equal(isTrustedFallbackSource("https://openai.com:443/release"), true);
  assert.equal(isTrustedFallbackSource("http://openai.com:80/release"), true);
});

test("source trust uses exact host matching without parent, subdomain, or www inference", () => {
  assert.equal(isTrustedFallbackSource("https://unknown.example/release"), false);
  assert.equal(isTrustedFallbackSource("https://support.anthropic.com/release"), false);
  assert.equal(isTrustedFallbackSource("https://gist.github.com/release"), false);
  assert.equal(isTrustedFallbackSource("https://www.openai.com/release"), false);
  assert.equal(isTrustedFallbackSource("https://rust-lang.org/release"), false);
});

test("malformed, unsupported, credentialed, address, and non-default-port URLs fail closed", () => {
  const rejected = [
    "not a URL",
    "/relative/path",
    "ftp://openai.com/release",
    "https://user:password@openai.com/release",
    "https://127.0.0.1/openai.com",
    "https://[::1]/openai.com",
    "https://localhost/openai.com",
    "https://openai.com:8443/release",
    "https://openai.com.attacker.example/release",
    "https://attacker.example/openai.com",
  ];
  for (const sourceUrl of rejected) assert.equal(isTrustedFallbackSource(sourceUrl), false, sourceUrl);
});

test("invalid or empty registry state enables no fallback trust", () => {
  const empty: TrustedSourceRegistry = { version: 1, approvedHostnames: [] };
  const duplicate = { version: 1, approvedHostnames: ["openai.com", "openai.com"] } as TrustedSourceRegistry;
  const nonCanonical = { version: 1, approvedHostnames: ["OpenAI.com"] } as TrustedSourceRegistry;
  const malformed = { version: 1, approvedHostnames: ["https://openai.com"] } as TrustedSourceRegistry;
  const unsupportedVersion = { version: 2, approvedHostnames: ["openai.com"] } as unknown as TrustedSourceRegistry;

  for (const registry of [empty, duplicate, nonCanonical, malformed, unsupportedVersion]) {
    assert.equal(isTrustedFallbackSource("https://openai.com/release", registry), false);
  }
});

test("source trust requires no fetch, provider, DNS, or LLM call", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network must not be used"); };
  try {
    assert.equal(isTrustedFallbackSource("https://openai.com/release"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
