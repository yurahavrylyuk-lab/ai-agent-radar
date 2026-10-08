import { APPROVED_X_SOURCES, X_PRICE_EXPIRES_AT, isXDiscoveryEnabled, validateXSourceRegistry, type ApprovedXSource } from "../config/xSources.js";
import { normalizeDiscoveryUrl } from "./discoveryHistoryCore.js";
import { reserveXRequest } from "./xUsageGuard.js";
import type { XInboxRecord, XNormalizedPost, XStore } from "./xStore.js";
import { readAccountPosts, XRequestError, type XTimelineResponse } from "../tools/x/readAccountPosts.js";
import type { SearchResult, XAccountFailure, XBlockedReason, XSourceProvenance } from "../types/index.js";

const MAX_POST_TEXT_LENGTH = 8_000;
const MAX_URL_LENGTH = 2_048;
const MAX_PENDING = 350;
const decimalId = /^[1-9]\d{0,24}$/;

export interface XDiscoveryCandidate {
  result: SearchResult;
  provenance: XSourceProvenance;
  storyUrl: string;
}

export interface XDiscoveryResult {
  candidates: XDiscoveryCandidate[];
  postStoryUrls: Map<string, string>;
  requestsAttempted: number;
  postsReceived: number;
  candidatesAdmitted: number;
  duplicates: number;
  accountsFailed: number;
  truncated: boolean;
  failures: XAccountFailure[];
  blockedReason?: XBlockedReason;
}

const emptyResult = (blockedReason?: XBlockedReason): XDiscoveryResult => ({ candidates: [], postStoryUrls: new Map(), requestsAttempted: 0, postsReceived: 0, candidatesAdmitted: 0, duplicates: 0, accountsFailed: 0, truncated: false, failures: [], ...(blockedReason ? { blockedReason } : {}) });

function canonicalPostUrl(postId: string): string { return `https://x.com/i/web/status/${postId}`; }

export function xPostIdFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]).has(host)) return undefined;
    const match = url.pathname.match(/^\/(?:i\/web|[^/]+)\/status\/(\d+)\/?$/);
    return match && decimalId.test(match[1]) ? match[1] : undefined;
  } catch { return undefined; }
}

function isUnsafeHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host === "localhost" || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) return true;
  return host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || isUnsafeHostname(url.hostname)) return undefined;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (new Set(["t.co", "x.com", "www.x.com", "twitter.com", "www.twitter.com"]).has(hostname)) return undefined;
    if (url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))) return undefined;
    if (xPostIdFromUrl(value)) return undefined;
    return normalizeDiscoveryUrl(url.toString());
  } catch { return undefined; }
}

interface RawPost { id?: unknown; author_id?: unknown; created_at?: unknown; text?: unknown; entities?: unknown; referenced_tweets?: unknown; edit_history_tweet_ids?: unknown; withheld?: unknown; possibly_sensitive?: unknown; }

function normalizePost(raw: unknown, source: ApprovedXSource, cycleStartedAt: Date): { record?: XInboxRecord; filtered?: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new XRequestError("X post shape was invalid.", "malformed_response");
  const post = raw as RawPost;
  if (typeof post.id !== "string" || !decimalId.test(post.id) || post.author_id !== source.userId) throw new XRequestError("X post identity was invalid.", "malformed_response");
  if (typeof post.created_at !== "string" || typeof post.text !== "string" || post.text.length > MAX_POST_TEXT_LENGTH) throw new XRequestError("X post fields were invalid.", "malformed_response");
  const created = new Date(post.created_at);
  const lower = cycleStartedAt.getTime() - 7 * 86_400_000;
  if (Number.isNaN(created.getTime()) || created.toISOString() !== post.created_at || created.getTime() < lower || created.getTime() > cycleStartedAt.getTime()) throw new XRequestError("X post timestamp was outside the approved interval.", "malformed_response");
  const refs = post.referenced_tweets === undefined ? [] : post.referenced_tweets;
  if (!Array.isArray(refs)) throw new XRequestError("X post references were invalid.", "malformed_response");
  if (refs.some((ref) => ref && typeof ref === "object" && ["replied_to", "retweeted", "quoted"].includes(String((ref as Record<string, unknown>).type)))) return { filtered: true };
  if (post.withheld !== undefined || post.possibly_sensitive === true || !post.text.trim()) return { filtered: true };
  const editIds = post.edit_history_tweet_ids;
  if (!Array.isArray(editIds) || editIds.length === 0
      || !editIds.every((id) => typeof id === "string" && decimalId.test(id))
      || new Set(editIds).size !== editIds.length
      || !editIds.includes(post.id)) {
    throw new XRequestError("X edit history was invalid.", "malformed_response");
  }
  const identity = editIds[0] as string;
  const urls = post.entities && typeof post.entities === "object" && !Array.isArray(post.entities)
    ? (post.entities as Record<string, unknown>).urls : undefined;
  const destinations = new Set<string>();
  if (urls !== undefined) {
    if (!Array.isArray(urls) || urls.length > 20) throw new XRequestError("X URL entities were invalid.", "malformed_response");
    for (const item of urls) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const candidate = safeExternalUrl(entry.unwound_url) ?? safeExternalUrl(entry.expanded_url);
      if (candidate) destinations.add(candidate);
      else if ([entry.unwound_url, entry.expanded_url, entry.url].some((value) =>
        typeof value === "string" && /^(?:https?:\/\/)?(?:t\.co|x\.com|twitter\.com)\//i.test(value))) return { filtered: true };
    }
  }
  if (destinations.size > 1) return { filtered: true };
  const canonical = canonicalPostUrl(identity);
  const storyUrl = destinations.values().next().value as string | undefined ?? canonical;
  const normalized: XNormalizedPost = { postId: identity, authorId: source.userId, createdAt: created.toISOString(), text: post.text.trim(), storyUrl, canonicalPostUrl: canonical, label: source.label, approvedHandle: source.approvedHandle, editIds: [...editIds] as string[] };
  return { record: { postId: identity, authorId: source.userId, storyUrl, createdAt: normalized.createdAt, payload: normalized, state: "pending", editIds: normalized.editIds } };
}

function candidateFromRecord(record: XInboxRecord): XDiscoveryCandidate | undefined {
  const post = record.payload;
  if (!post) return undefined;
  return {
    result: { title: `X announcement — ${post.label}`, url: post.storyUrl, snippet: `Untrusted X announcement from ${post.label}: ${post.text.slice(0, 800)}`, publishedAt: post.createdAt, source: "X" },
    storyUrl: post.storyUrl,
    provenance: { kind: "x", postId: post.postId, authorId: post.authorId, postUrl: post.canonicalPostUrl, label: post.label },
  };
}

export interface CollectXDiscoveryDependencies {
  store: XStore;
  environment: Record<string, string | undefined>;
  now?: Date;
  read?: (request: Parameters<typeof readAccountPosts>[0]) => Promise<XTimelineResponse>;
  sources?: readonly ApprovedXSource[];
}

/** Polls each approved account once at most and returns durable pending candidates. */
export async function collectXDiscoveries(dependencies: CollectXDiscoveryDependencies): Promise<XDiscoveryResult> {
  let enabled: boolean;
  try { enabled = isXDiscoveryEnabled(dependencies.environment); } catch { return emptyResult("config"); }
  if (!enabled) return emptyResult("disabled");
  const token = dependencies.environment.X_BEARER_TOKEN?.trim();
  if (!token) return emptyResult("config");
  const now = dependencies.now ?? new Date();
  if (Number.isNaN(now.getTime())) return emptyResult("config");
  if (now.getTime() >= new Date(X_PRICE_EXPIRES_AT).getTime()) return emptyResult("price_expired");
  const sources = dependencies.sources ?? APPROVED_X_SOURCES;
  try { validateXSourceRegistry(sources); } catch { return emptyResult("config"); }
  const result = emptyResult();
  try { if (await dependencies.store.getGlobalDisabledReason()) return emptyResult("auth"); }
  catch { return emptyResult("state_unavailable"); }
  const read = dependencies.read ?? ((request) => readAccountPosts(request));
  const start = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  let reservations = 0;
  for (const [index, source] of sources.entries()) {
    let state: Awaited<ReturnType<XStore["getPollState"]>>;
    try { state = await dependencies.store.getPollState(source.userId); }
    catch { result.blockedReason = "state_unavailable"; break; }
    if (state.disabledReason) { result.accountsFailed += 1; result.failures.push({ accountOrdinal: index + 1, reason: "account_unavailable" }); continue; }
    const reservation = await reserveXRequest(dependencies.store, source.userId, now, reservations);
    if (!reservation.allowed || reservation.reservationId === undefined) { result.blockedReason = reservation.reason === "budget" ? "budget" : "state_unavailable"; break; }
    reservations += 1; result.requestsAttempted += 1;
    try {
      const page = await read({ userId: source.userId, sinceId: state.sinceId, startTime: start, endTime: now.toISOString(), bearerToken: token });
      result.postsReceived += page.data.length; result.truncated ||= page.truncated;
      const records: XInboxRecord[] = [];
      let highWater = state.sinceId;
      for (const raw of page.data) {
        const normalized = normalizePost(raw, source, now);
        const rawId = (raw as Record<string, unknown>).id;
        if (typeof rawId === "string" && decimalId.test(rawId) && (!highWater || BigInt(rawId) > BigInt(highWater))) highWater = rawId;
        if (normalized.record) records.push(normalized.record);
      }
      await dependencies.store.commitPage(source.userId, highWater, records, now);
      await dependencies.store.settleRequest(reservation.reservationId, "success");
    } catch (error) {
      await dependencies.store.settleRequest(reservation.reservationId, error instanceof XRequestError ? "error" : "unknown").catch(() => undefined);
      const reason = error instanceof XRequestError ? error.reason : "state_unavailable";
      result.accountsFailed += 1; result.failures.push({ accountOrdinal: index + 1, reason: reason === "contract_drift" ? "contract_drift" : reason === "malformed_response" ? "malformed_response" : reason === "auth" ? "auth" : reason === "rate_limit" ? "rate_limit" : reason === "account_unavailable" ? "account_unavailable" : reason === "timeout" ? "timeout" : reason === "provider_error" ? "provider_error" : "state_unavailable" });
      if (reason === "auth") { result.blockedReason = "auth"; await dependencies.store.setDisabledReason(undefined, "auth").catch(() => undefined); break; }
      if (reason === "rate_limit") { result.blockedReason = "rate_limit"; break; }
      if (reason === "contract_drift") { result.blockedReason = "contract_drift"; break; }
      if (reason === "account_unavailable") await dependencies.store.setDisabledReason(source.userId, "account_unavailable").catch(() => undefined);
    }
  }
  try {
    const pending = await dependencies.store.listPending(now, MAX_PENDING);
    result.truncated ||= pending.truncated;
    const seenStories = new Set<string>();
    const sourceOrder = new Map(sources.map((source, index) => [source.userId, index]));
    const orderedPending = [...pending.records].sort((left, right) =>
      (sourceOrder.get(left.authorId) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(right.authorId) ?? Number.MAX_SAFE_INTEGER)
      || right.createdAt.localeCompare(left.createdAt)
      || (BigInt(left.postId) < BigInt(right.postId) ? -1 : BigInt(left.postId) > BigInt(right.postId) ? 1 : 0));
    for (const record of orderedPending) {
      result.postStoryUrls.set(record.postId, record.storyUrl);
      for (const id of record.editIds) result.postStoryUrls.set(id, record.storyUrl);
      const candidate = candidateFromRecord(record);
      if (!candidate) continue;
      if (seenStories.has(candidate.storyUrl)) { result.duplicates += 1; continue; }
      seenStories.add(candidate.storyUrl); result.candidates.push(candidate);
    }
    result.candidatesAdmitted = result.candidates.length;
  } catch { result.candidates = []; result.candidatesAdmitted = 0; result.blockedReason = "state_unavailable"; }
  return result;
}
