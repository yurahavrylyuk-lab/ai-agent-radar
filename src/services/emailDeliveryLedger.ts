import { batchAliasKey } from "./batchCandidates.js";
import { normalizeDiscoveryUrl } from "./discoveryHistoryCore.js";
import type { DailyDigestMode, DailyDigestReason, DiscoveryEmailContent, PreparedDailyDigest } from "../types/index.js";
import type { FeedbackStoryBinding } from "./d1EmailFeedbackStore.js";

const encoder = new TextEncoder();
const SUBJECT_BYTES = 1024;
const TEXT_BYTES = 64 * 1024;
const HTML_BYTES = 192 * 1024;
const CONTENT_BYTES = 272 * 1024;
const REQUEST_BYTES = 280 * 1024;
const ALIAS_BYTES = 2048;
const ALIASES_BYTES = 128 * 1024;

export type DeliveryKey = `daily-digest/${string}`;
export type DeliveryState = "prepared" | "attempting" | "ambiguous" | "accepted" | "confirmed_failed";
export type DeliveryReason = "prepared" | "claimed" | "dispatch_admitted" | "cancelled_before_dispatch"
  | "provider_accepted" | "provider_rejected" | "provider_ambiguous" | "payload_conflict"
  | "already_accepted" | "in_progress" | "recovery_required" | "ledger_unavailable"
  | "configuration_payload_mismatch" | "history_pending" | "history_reconciled" | "integrity_hold";

export interface DeliveryIdentity {
  key: DeliveryKey;
  logicalDate: string;
  scheduledAt: string;
}

export interface FrozenDelivery {
  identity: DeliveryIdentity;
  payloadVersion: 1;
  content: DiscoveryEmailContent & { from: string };
  payloadSha256: string;
  mode: DailyDigestMode;
  reason: DailyDigestReason;
  aliases: readonly string[];
}

export interface DispatchSlot {
  token: string;
  admittedAt: string;
  evidence: "uncertain" | "dispatched";
  outcome: "pending" | "ambiguous" | "rejected" | "accepted" | "payload_conflict";
}

export interface ClaimRef { key: DeliveryKey; token: string; generation: number }

export interface DeliveryRecord {
  key: DeliveryKey;
  logicalDate: string;
  payloadSha256: string;
  frozen: FrozenDelivery | null;
  state: DeliveryState;
  createdAt: string;
  updatedAt: string;
  firstProviderAttemptAt: string | null;
  lastProviderAttemptAt: string | null;
  retryBefore: string | null;
  claim: ClaimRef | null;
  leaseUntil: string | null;
  slots: readonly DispatchSlot[];
  providerMessageId: string | null;
  acceptedAt: string | null;
  reconciledAt: string | null;
  lastReason: DeliveryReason;
}

export type MutationResult = { kind: "committed" | "superseded"; record: DeliveryRecord }
  | { kind: "blocked"; reason: DeliveryReason };

export type ResendOutcome = { kind: "accepted"; id: string }
  | { kind: "rejected"; rejection: "validation" | "authentication" | "permission" | "quota" }
  | { kind: "ambiguous"; reason: "timeout" | "transport" | "concurrent" | "invalid_response" | "http" }
  | { kind: "payload_conflict" };

export interface DeliveryLedger {
  read(key: DeliveryKey): Promise<DeliveryRecord | null>;
  reserve(frozen: FrozenDelivery): Promise<MutationResult>;
  reserveWithBindings?(frozen: FrozenDelivery, bindings: readonly FeedbackStoryBinding[]): Promise<MutationResult>;
  claim(key: DeliveryKey, token: string): Promise<MutationResult>;
  admitDispatch(ref: ClaimRef): Promise<MutationResult>;
  verifyDispatch(ref: ClaimRef): Promise<{ record: DeliveryRecord; databaseNow: string }>;
  cancelUndispatched(ref: ClaimRef): Promise<MutationResult>;
  recordOutcome(ref: ClaimRef, hash: string, outcome: ResendOutcome): Promise<MutationResult>;
  reconcileAccepted(key: DeliveryKey): Promise<MutationResult>;
  reconcileOneOlder(logicalDate: string): Promise<void>;
}

export class DeliveryStateUnavailableError extends Error {
  constructor() { super("Daily delivery state is unavailable."); this.name = "DeliveryStateUnavailableError"; }
}

function bytes(value: string): number { return encoder.encode(value).byteLength; }

function validIso(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function assertBound(value: string, limit: number, label: string): void {
  if (bytes(value) > limit) throw new Error(`${label} exceeds the delivery byte limit.`);
}

function canonicalBody(content: FrozenDelivery["content"], recipient: string): string {
  if (typeof recipient !== "string" || recipient.length === 0) throw new Error("Delivery recipient is unavailable.");
  return JSON.stringify({
    from: content.from,
    to: [recipient],
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export function deliveryIdentity(scheduledAt: Date): DeliveryIdentity {
  if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.getTime())) {
    throw new Error("A valid scheduled time is required for daily delivery identity.");
  }
  const iso = scheduledAt.toISOString();
  const logicalDate = iso.slice(0, 10);
  return { key: `daily-digest/${logicalDate}`, logicalDate, scheduledAt: iso };
}

function digestAliases(digest: PreparedDailyDigest): string[] {
  if (!Array.isArray(digest.items) || digest.items.length > 4) throw new Error("Daily digest items exceed the delivery limit.");
  const aliases = new Set<string>();
  for (const item of digest.items) {
    const sourceUrl = item.kind === "raw" ? item.candidate.normalizedUrl : item.candidate.discovery.normalizedUrl;
    for (const alias of [sourceUrl, ...item.candidate.aliases]) {
      const normalized = normalizeDiscoveryUrl(alias);
      const canonical = batchAliasKey(normalized);
      for (const value of [canonical, normalized]) {
        assertBound(value, ALIAS_BYTES, "Delivery alias");
        aliases.add(value);
      }
    }
  }
  if (aliases.size > 128) throw new Error("Delivery aliases exceed the count limit.");
  const result = [...aliases].sort();
  assertBound(JSON.stringify(result), ALIASES_BYTES, "Delivery aliases");
  return result;
}

export async function freezeDelivery(
  digest: PreparedDailyDigest,
  identity: DeliveryIdentity,
  content: DiscoveryEmailContent & { from: string },
  recipient: string,
): Promise<FrozenDelivery> {
  if (identity.key !== `daily-digest/${identity.logicalDate}` || !validIso(identity.scheduledAt)
      || identity.scheduledAt.slice(0, 10) !== identity.logicalDate) {
    throw new Error("Delivery identity is invalid.");
  }
  for (const [label, value] of Object.entries(content)) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Delivery ${label} is invalid.`);
  }
  assertBound(content.subject, SUBJECT_BYTES, "Delivery subject");
  assertBound(content.text, TEXT_BYTES, "Delivery text");
  assertBound(content.html, HTML_BYTES, "Delivery HTML");
  assertBound(JSON.stringify(content), CONTENT_BYTES, "Delivery content");
  const body = canonicalBody(content, recipient);
  assertBound(body, REQUEST_BYTES, "Delivery request");
  const aliases = digest.mode === "status_only" ? [] : digestAliases(digest);
  return {
    identity: { ...identity }, payloadVersion: 1, content: { ...content },
    payloadSha256: await sha256(body), mode: digest.mode, reason: digest.reason, aliases,
  };
}

export async function restoreDeliveryBody(frozen: FrozenDelivery, recipient: string): Promise<string> {
  if (frozen.payloadVersion !== 1) throw new Error("Delivery payload version is unsupported.");
  const body = canonicalBody(frozen.content, recipient);
  assertBound(body, REQUEST_BYTES, "Delivery request");
  if (await sha256(body) !== frozen.payloadSha256) throw new Error("Delivery payload does not match its frozen identity.");
  return body;
}

export function validateDeliveryRecord(record: DeliveryRecord): void {
  if (record.key !== `daily-digest/${record.logicalDate}`) throw new Error("Delivery identity is inconsistent.");
  if (!validIso(record.createdAt) || !validIso(record.updatedAt)) throw new Error("Delivery timestamps are invalid.");
  if (record.frozen && (record.frozen.identity.key !== record.key || record.frozen.payloadSha256 !== record.payloadSha256)) {
    throw new Error("Delivery frozen identity is inconsistent.");
  }
  if (!record.frozen && !(record.state === "accepted" && record.reconciledAt)) {
    throw new Error("Only a reconciled accepted delivery may omit frozen content.");
  }
  if (record.slots.length > 3 || new Set(record.slots.map(slot => slot.token)).size !== record.slots.length) {
    throw new Error("Delivery dispatch journal is invalid.");
  }
  if (record.state === "accepted" && (!record.providerMessageId || !record.acceptedAt)) {
    throw new Error("Accepted delivery requires provider acceptance evidence.");
  }
  if (record.state !== "accepted" && (record.providerMessageId || record.acceptedAt || record.reconciledAt)) {
    throw new Error("Non-accepted delivery cannot contain acceptance evidence.");
  }
  const timing = [record.firstProviderAttemptAt, record.lastProviderAttemptAt, record.retryBefore];
  if (timing.some(value => value !== null && !validIso(value))) throw new Error("Delivery attempt timestamps are invalid.");
  if ((record.firstProviderAttemptAt === null) !== (record.retryBefore === null)
      || (record.slots.length === 0 && record.firstProviderAttemptAt !== null)) {
    throw new Error("Delivery attempt clock is inconsistent.");
  }
}
