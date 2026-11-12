const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const FEEDBACK_CAPABILITY_DAYS = 30;
export const FEEDBACK_CONFIRMATION_MINUTES = 10;
export const MAX_FEEDBACK_TOKEN_BYTES = 1024;
export const MAX_FEEDBACK_URL_BYTES = 2048;
export const feedbackRatings = ["relevant", "not_relevant"] as const;
export type FeedbackRating = (typeof feedbackRatings)[number];

export type FeedbackErrorCode = "invalid" | "expired" | "configuration" | "stale";

export class FeedbackValidationError extends Error {
  constructor(readonly code: FeedbackErrorCode) {
    super(`Feedback request ${code}.`);
    this.name = "FeedbackValidationError";
  }
}

export interface FeedbackSigningKey { id: string; secret: string }
export interface FeedbackKeyring { active: FeedbackSigningKey; retiring?: FeedbackSigningKey }

export interface FeedbackCapabilityClaims {
  version: 1;
  keyId: string;
  deliveryKey: `daily-digest/${string}`;
  slot: 1 | 2 | 3 | 4;
  storySha256: string;
  rating: FeedbackRating;
  issuedAt: string;
  expiresAt: string;
}

interface ConfirmationClaims {
  version: 1;
  keyId: string;
  capabilitySha256: string;
  rating: FeedbackRating;
  expectedRevision: number;
  expiresAt: string;
}

const capabilityPurpose = "radar-feedback-capability-v1";
const confirmationPurpose = "radar-feedback-confirmation-v1";

function bytes(value: string): number { return encoder.encode(value).byteLength; }
function validHex(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
function validKeyId(value: string): boolean { return /^[A-Za-z0-9_-]{1,32}$/.test(value); }
function validIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function assertOrigin(origin: string): void {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.pathname !== "/") throw new Error();
  } catch { throw new FeedbackValidationError("configuration"); }
}

function base64url(data: Uint8Array): string {
  let binary = "";
  for (const value of data) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new FeedbackValidationError("invalid");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch { throw new FeedbackValidationError("invalid"); }
}

function canonicalCapability(claims: FeedbackCapabilityClaims): string {
  return JSON.stringify({ v: claims.version, k: claims.keyId, d: claims.deliveryKey, s: claims.slot,
    h: claims.storySha256, r: claims.rating, i: claims.issuedAt, e: claims.expiresAt });
}

function canonicalConfirmation(claims: ConfirmationClaims): string {
  return JSON.stringify({ v: claims.version, k: claims.keyId, h: claims.capabilitySha256,
    r: claims.rating, x: claims.expectedRevision, e: claims.expiresAt });
}

function signingKey(key: FeedbackSigningKey): Promise<CryptoKey> {
  if (!validKeyId(key.id) || bytes(key.secret) < 32) throw new FeedbackValidationError("configuration");
  return crypto.subtle.importKey("raw", encoder.encode(key.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(payload: string, purpose: string, origin: string, key: FeedbackSigningKey): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await signingKey(key), encoder.encode(`${purpose}\n${origin}\n${payload}`));
  return base64url(new Uint8Array(signature));
}

async function verifySignature(payload: string, signature: string, purpose: string, origin: string, key: FeedbackSigningKey): Promise<boolean> {
  try {
    const decoded=decodeBase64url(signature);
    const bytes=decoded.buffer.slice(decoded.byteOffset,decoded.byteOffset+decoded.byteLength) as ArrayBuffer;
    return await crypto.subtle.verify("HMAC", await signingKey(key), bytes, encoder.encode(`${purpose}\n${origin}\n${payload}`));
  } catch { return false; }
}

function keyFor(keyring: FeedbackKeyring, id: string): FeedbackSigningKey {
  if (keyring.active.id === id) return keyring.active;
  if (keyring.retiring?.id === id) return keyring.retiring;
  throw new FeedbackValidationError("invalid");
}

function parseToken(token: string): [string, string] {
  if (bytes(token) > MAX_FEEDBACK_TOKEN_BYTES) throw new FeedbackValidationError("invalid");
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some(value => value.length === 0)) throw new FeedbackValidationError("invalid");
  return [parts[0]!, parts[1]!];
}

function parseCanonical<T>(encoded: string, decode: (raw: unknown) => T, canonical: (value: T) => string): T {
  let decoded: string;
  let value: T;
  try {
    decoded = decoder.decode(decodeBase64url(encoded));
    value = decode(JSON.parse(decoded));
  } catch { throw new FeedbackValidationError("invalid"); }
  if (canonical(value) !== decoded || base64url(encoder.encode(decoded)) !== encoded) throw new FeedbackValidationError("invalid");
  return value;
}

function exactObject(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new FeedbackValidationError("invalid");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new FeedbackValidationError("invalid");
  return value;
}

function decodeCapability(raw: unknown): FeedbackCapabilityClaims {
  const value = exactObject(raw, ["v", "k", "d", "s", "h", "r", "i", "e"]);
  return { version: value.v as 1, keyId: value.k as string, deliveryKey: value.d as FeedbackCapabilityClaims["deliveryKey"],
    slot: value.s as FeedbackCapabilityClaims["slot"], storySha256: value.h as string,
    rating: value.r as FeedbackRating, issuedAt: value.i as string, expiresAt: value.e as string };
}

function decodeConfirmation(raw: unknown): ConfirmationClaims {
  const value = exactObject(raw, ["v", "k", "h", "r", "x", "e"]);
  return { version: value.v as 1, keyId: value.k as string, capabilitySha256: value.h as string,
    rating: value.r as FeedbackRating, expectedRevision: value.x as number, expiresAt: value.e as string };
}

function assertCapability(claims: FeedbackCapabilityClaims): void {
  const valid = claims.version === 1 && validKeyId(claims.keyId)
    && /^daily-digest\/\d{4}-\d{2}-\d{2}$/.test(claims.deliveryKey)
    && [1, 2, 3, 4].includes(claims.slot) && validHex(claims.storySha256)
    && feedbackRatings.includes(claims.rating) && validIso(claims.issuedAt) && validIso(claims.expiresAt)
    && claims.deliveryKey.endsWith(claims.issuedAt.slice(0, 10))
    && new Date(claims.expiresAt).getTime() - new Date(claims.issuedAt).getTime() === FEEDBACK_CAPABILITY_DAYS * 86_400_000;
  if (!valid) throw new FeedbackValidationError("invalid");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(item => item.toString(16).padStart(2, "0")).join("");
}

export async function createFeedbackCapability(
  input: Omit<FeedbackCapabilityClaims, "version" | "keyId" | "expiresAt">,
  keyring: FeedbackKeyring,
  origin: string,
): Promise<{ token: string; claims: FeedbackCapabilityClaims; digest: string }> {
  assertOrigin(origin);
  const claims: FeedbackCapabilityClaims = { version: 1, keyId: keyring.active.id, ...input,
    expiresAt: new Date(new Date(input.issuedAt).getTime() + FEEDBACK_CAPABILITY_DAYS * 86_400_000).toISOString() };
  assertCapability(claims);
  const payload = canonicalCapability(claims);
  const token = `${base64url(encoder.encode(payload))}.${await sign(payload, capabilityPurpose, origin, keyring.active)}`;
  if (bytes(token) > MAX_FEEDBACK_TOKEN_BYTES) throw new FeedbackValidationError("configuration");
  return { token, claims, digest: await sha256Hex(token) };
}

export async function verifyFeedbackCapability(token: string, keyring: FeedbackKeyring, origin: string, now = new Date()): Promise<FeedbackCapabilityClaims> {
  assertOrigin(origin);
  const [encoded, signature] = parseToken(token);
  const claims = parseCanonical(encoded, decodeCapability, canonicalCapability);
  assertCapability(claims);
  if (!await verifySignature(canonicalCapability(claims), signature, capabilityPurpose, origin, keyFor(keyring, claims.keyId))) {
    throw new FeedbackValidationError("invalid");
  }
  if (now.getTime() < new Date(claims.issuedAt).getTime() || now.getTime() > new Date(claims.expiresAt).getTime()) {
    throw new FeedbackValidationError("expired");
  }
  return claims;
}

export async function createFeedbackConfirmation(
  capabilityToken: string, rating: FeedbackRating, expectedRevision: number,
  capabilityExpiresAt: string, keyring: FeedbackKeyring, origin: string, now = new Date(),
): Promise<string> {
  assertOrigin(origin);
  if (!feedbackRatings.includes(rating) || !Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 10 || !validIso(capabilityExpiresAt)) {
    throw new FeedbackValidationError("invalid");
  }
  const expiry = new Date(Math.min(now.getTime() + FEEDBACK_CONFIRMATION_MINUTES * 60_000, new Date(capabilityExpiresAt).getTime())).toISOString();
  const claims: ConfirmationClaims = { version: 1, keyId: keyring.active.id,
    capabilitySha256: await sha256Hex(capabilityToken), rating, expectedRevision, expiresAt: expiry };
  const payload = canonicalConfirmation(claims);
  return `${base64url(encoder.encode(payload))}.${await sign(payload, confirmationPurpose, origin, keyring.active)}`;
}

export async function verifyFeedbackConfirmation(
  nonce: string, capabilityToken: string, rating: FeedbackRating, expectedRevision: number,
  keyring: FeedbackKeyring, origin: string, now = new Date(),
): Promise<void> {
  assertOrigin(origin);
  const [encoded, signature] = parseToken(nonce);
  const claims = parseCanonical(encoded, decodeConfirmation, canonicalConfirmation);
  const valid = claims.version === 1 && validKeyId(claims.keyId) && validHex(claims.capabilitySha256)
    && feedbackRatings.includes(claims.rating) && Number.isInteger(claims.expectedRevision)
    && claims.expectedRevision >= 0 && claims.expectedRevision <= 10 && validIso(claims.expiresAt);
  if (!valid || !await verifySignature(canonicalConfirmation(claims), signature, confirmationPurpose, origin, keyFor(keyring, claims.keyId))) {
    throw new FeedbackValidationError("invalid");
  }
  if (claims.capabilitySha256 !== await sha256Hex(capabilityToken) || claims.rating !== rating || claims.expectedRevision !== expectedRevision) {
    throw new FeedbackValidationError("stale");
  }
  if (now.getTime() > new Date(claims.expiresAt).getTime()) throw new FeedbackValidationError("expired");
}
