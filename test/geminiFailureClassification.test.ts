import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_GEMINI_MODELS } from "../src/config/geminiModels.js";
import {
  GEMINI_FAILURE_CLASSES,
  classifyGeminiHttpFailure,
  isGeminiFailureClass,
} from "../src/services/geminiFailureClassification.js";

const model = APPROVED_GEMINI_MODELS[0];
const quotaViolation = (selectedModel: string | undefined = model) => ({
  quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
  quotaDimensions: selectedModel === undefined ? { location: "global" } : { model: selectedModel, location: "global" },
});
const quotaFailure = (...violations: unknown[]) => ({
  "@type": "type.googleapis.com/google.rpc.QuotaFailure",
  violations,
});

test("classifies_only_reviewed_http_evidence", () => {
  const canary = "UNIQUE_PROVIDER_BODY_MUST_NOT_CROSS_BOUNDARY";
  const cases: Array<{ name: string; status: number; body: unknown; expected: string }> = [
    { name: "503 absent provider status", status: 503, body: { error: { message: canary } }, expected: "unavailable_503" },
    { name: "503 explicit unavailable", status: 503, body: { error: { status: "UNAVAILABLE", message: canary } }, expected: "unavailable_503" },
    { name: "model-specific 429", status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", details: [quotaFailure(quotaViolation())], message: canary } }, expected: "resource_exhausted_429" },
    { name: "foreign-model 429", status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", details: [quotaFailure(quotaViolation("gemini-other"))], message: canary } }, expected: "unclassified_http_error" },
    { name: "missing-model 429", status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", details: [quotaFailure({ quotaMetric: "requests", quotaDimensions: { location: "global" } })], message: canary } }, expected: "unclassified_http_error" },
    { name: "malformed 429", status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", details: [], message: canary } }, expected: "unclassified_http_error" },
    { name: "unknown companion detail", status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", details: [quotaFailure(quotaViolation()), { "@type": "unknown" }], message: canary } }, expected: "unclassified_http_error" },
    { name: "provider prose only", status: 429, body: { error: { message: `${canary}: quota for ${model}` } }, expected: "unclassified_http_error" },
    { name: "401", status: 401, body: { error: { status: "UNAUTHENTICATED", message: canary } }, expected: "unclassified_http_error" },
    { name: "403", status: 403, body: { error: { status: "PERMISSION_DENIED", message: canary } }, expected: "unclassified_http_error" },
  ];

  for (const item of cases) {
    const classification = classifyGeminiHttpFailure(item.status, item.body, model);
    assert.equal(classification, item.expected, item.name);
    assert.equal(JSON.stringify({ failureClass: classification, httpStatus: item.status }).includes(canary), false);
  }
});

test("local_failures_are_closed", () => {
  assert.deepEqual(GEMINI_FAILURE_CLASSES, [
    "none",
    "unavailable_503",
    "resource_exhausted_429",
    "unclassified_http_error",
    "timeout",
    "transport_error",
    "response_invalid",
    "accounting_failure",
  ]);
  for (const value of GEMINI_FAILURE_CLASSES) assert.equal(isGeminiFailureClass(value), true);
  assert.equal(isGeminiFailureClass("UNIQUE_PROVIDER_BODY_MUST_NOT_CROSS_BOUNDARY"), false);
  assert.equal(isGeminiFailureClass({ failure: "unavailable_503" }), false);
});
