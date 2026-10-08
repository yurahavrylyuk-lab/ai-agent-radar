import type { XSourceProvenance } from "../types/index.js";

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
