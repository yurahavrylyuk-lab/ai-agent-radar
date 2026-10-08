import type { XSourceProvenance } from "../types/index.js";

export const X_PENDING_PAYLOAD_LIMIT = 350;
export const X_PENDING_RETENTION_MS = 7 * 86_400_000;
const decimalId = /^[1-9]\d{0,24}$/;

export type XUsageOutcome = "reserved" | "success" | "error" | "unknown";
export type XInboxState = "pending" | "processed" | "filtered" | "expired";

export interface XNormalizedPost {
  postId: string;
  authorId: string;
  createdAt: string;
  text: string;
  storyUrl: string;
  canonicalPostUrl: string;
  label: string;
  approvedHandle: string;
  editIds: string[];
}

export interface XInboxRecord {
  postId: string;
  authorId: string;
  storyUrl: string;
  createdAt: string;
  payload?: XNormalizedPost;
  state: XInboxState;
  editIds: string[];
}

export interface XRequestReservation {
  id: number;
  reservedAt: string;
  authorId: string;
  reservedPosts: number;
  reservedMicroUsd: number;
  outcome: XUsageOutcome;
}

export interface XUsageReservationLimits {
  cycleRequestsAlreadyReserved: number;
  requestsPerCycle: number;
  requestsPerDay: number;
  requestsPerIsoWeek: number;
  requestsPerMonth: number;
  reservedPostsPerRequest: number;
  reservedPostsPerMonth: number;
  reservedMicroUsdPerMonth: number;
  reservedMicroUsdPerRequest: number;
}

export interface XReservationResult { allowed: boolean; reservationId?: number; reason?: "budget" | "state_unavailable"; }

/** Validates one frozen identity without coercing opaque decimal IDs to numbers. */
export function validateXInboxRecordIdentity(record: XInboxRecord): void {
  if (!decimalId.test(record.postId) || record.editIds.length === 0
      || record.editIds.some((id) => !decimalId.test(id))
      || new Set(record.editIds).size !== record.editIds.length
      || !record.editIds.includes(record.postId)) {
    throw new Error("X inbox edit identity is invalid.");
  }
}

/** Rejects pages where one opaque Post/edit ID would identify different frozen records. */
export function validateXInboxPageIdentities(posts: readonly XInboxRecord[]): void {
  const ownerById = new Map<string, string>();
  const recordByPostId = new Map<string, XInboxRecord>();
  for (const post of posts) {
    validateXInboxRecordIdentity(post);
    const prior = recordByPostId.get(post.postId);
    if (prior && (prior.authorId !== post.authorId || prior.storyUrl !== post.storyUrl
        || JSON.stringify(prior.editIds) !== JSON.stringify(post.editIds))) {
      throw new Error("X inbox page contains conflicting frozen records.");
    }
    recordByPostId.set(post.postId, post);
    for (const id of post.editIds) {
      const owner = ownerById.get(id);
      if (owner !== undefined && owner !== post.postId) {
        throw new Error("X inbox page contains a conflicting edit alias.");
      }
      ownerById.set(id, post.postId);
    }
  }
}

export function compareOldestXInboxRecord(left: XInboxRecord, right: XInboxRecord): number {
  return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1
    : left.postId < right.postId ? -1 : left.postId > right.postId ? 1 : 0;
}

export interface XStore {
  getPollState(authorId: string): Promise<{ sinceId?: string; disabledReason?: string }>;
  getGlobalDisabledReason(): Promise<string | undefined>;
  reserveRequest(authorId: string, now: Date, limits: XUsageReservationLimits): Promise<XReservationResult>;
  settleRequest(reservationId: number, outcome: Exclude<XUsageOutcome, "reserved">): Promise<void>;
  commitPage(authorId: string, sinceId: string | undefined, posts: XInboxRecord[], lastSuccessAt: Date): Promise<void>;
  listPending(now: Date, limit: number): Promise<{ records: XInboxRecord[]; truncated: boolean }>;
  markStoryProcessed(storyUrl: string): Promise<void>;
  getStoryByPostId(postId: string): Promise<{ storyUrl: string; provenance?: XSourceProvenance } | undefined>;
  setDisabledReason(authorId: string | undefined, reason: string): Promise<void>;
}

export function isoWeekStart(now: Date): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - day + 1);
  return start;
}

export function utcDayStart(now: Date): Date { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); }
export function utcMonthStart(now: Date): Date { return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); }
