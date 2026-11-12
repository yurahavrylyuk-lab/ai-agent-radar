import assert from "node:assert/strict";
import test from "node:test";
import {
  createFeedbackCapability, createFeedbackConfirmation, FeedbackValidationError,
  sha256Hex, verifyFeedbackCapability, verifyFeedbackConfirmation,
  type FeedbackKeyring,
} from "../src/services/emailFeedback.js";

const origin = "https://feedback.example";
const issuedAt = "2026-11-12T08:00:00.000Z";
const active: FeedbackKeyring = { active: { id: "active", secret: "a".repeat(32) } };

async function capability(keyring = active) {
  return createFeedbackCapability({ deliveryKey: "daily-digest/2026-11-12", slot: 1,
    storySha256: "b".repeat(64), rating: "relevant", issuedAt }, keyring, origin);
}

test("feedback capability is canonical, deterministic, bounded, and expires after 30 days", async () => {
  const left = await capability();
  const right = await capability();
  assert.deepEqual(left, right);
  assert.ok(new TextEncoder().encode(left.token).byteLength <= 1024);
  assert.equal((await verifyFeedbackCapability(left.token, active, origin, new Date(issuedAt))).deliveryKey, "daily-digest/2026-11-12");
  await assert.rejects(verifyFeedbackCapability(left.token, active, origin, new Date("2026-12-12T08:00:00.001Z")), (error: unknown) => error instanceof FeedbackValidationError && error.code === "expired");
});

test("capability rejects tampering, wrong audience, noncanonical input, and unknown fields without echoing input", async () => {
  const value = await capability();
  const [payload, signature] = value.token.split(".");
  for (const candidate of [`${payload}.${signature!.slice(0, -1)}A`, `${payload}==.${signature}`, `${payload}.${signature}.extra`]) {
    await assert.rejects(verifyFeedbackCapability(candidate, active, origin, new Date(issuedAt)), /Feedback request invalid\./);
  }
  await assert.rejects(verifyFeedbackCapability(value.token, active, "https://other.example", new Date(issuedAt)), /Feedback request invalid\./);
});

test("one retiring key remains valid while unknown keys and weak key configuration fail closed", async () => {
  const old: FeedbackKeyring = { active: { id: "old", secret: "o".repeat(32) } };
  const value = await capability(old);
  const rotated: FeedbackKeyring = { active: active.active, retiring: old.active };
  assert.equal((await verifyFeedbackCapability(value.token, rotated, origin, new Date(issuedAt))).keyId, "old");
  await assert.rejects(verifyFeedbackCapability(value.token, active, origin, new Date(issuedAt)), /Feedback request invalid\./);
  await assert.rejects(capability({ active: { id: "weak", secret: "short" } }), /Feedback request configuration\./);
});

test("confirmation nonce is purpose-separated, revision-bound, short-lived, and tied to capability", async () => {
  const value = await capability();
  const nonce = await createFeedbackConfirmation(value.token, "relevant", 0, value.claims.expiresAt, active, origin, new Date(issuedAt));
  await assert.doesNotReject(verifyFeedbackConfirmation(nonce, value.token, "relevant", 0, active, origin, new Date("2026-11-12T08:09:59.999Z")));
  await assert.rejects(verifyFeedbackConfirmation(nonce, value.token, "relevant", 1, active, origin, new Date(issuedAt)), /Feedback request stale\./);
  await assert.rejects(verifyFeedbackConfirmation(nonce, value.token, "not_relevant", 0, active, origin, new Date(issuedAt)), /Feedback request stale\./);
  const other = await createFeedbackCapability({ deliveryKey: "daily-digest/2026-11-12", slot: 2,
    storySha256: await sha256Hex("other"), rating: "relevant", issuedAt }, active, origin);
  await assert.rejects(verifyFeedbackConfirmation(nonce, other.token, "relevant", 0, active, origin, new Date(issuedAt)), /Feedback request stale\./);
  await assert.rejects(verifyFeedbackConfirmation(nonce, value.token, "relevant", 0, active, origin, new Date("2026-11-12T08:10:00.001Z")), /Feedback request expired\./);
});
