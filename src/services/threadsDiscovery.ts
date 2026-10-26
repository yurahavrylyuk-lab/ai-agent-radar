import { THREADS_ENDPOINT, THREADS_LIMITS, THREADS_QUERIES } from "../config/threadsSources.js";
import type {
  BatchObservation,
  SearchResult,
  ThreadsCycleMetrics,
  ThreadsDiscoveryResult,
  ThreadsQueryId,
  ThreadsQueryOutcome,
  ThreadsReason,
} from "../types/index.js";
import { truncateUtf8, utf8Length } from "./batchPrompt.js";

export interface ThreadsCollectorOptions {
  enabled: boolean;
  publicSearchApproved: boolean;
  accessToken?: string;
  tokenExpiresAt?: string;
  now: Date;
  fetchImpl: typeof fetch;
  monotonicNow?: () => number;
}

class ThreadsFailure extends Error {
  constructor(readonly reason: ThreadsReason, readonly terminal = false, readonly bodyTruncated = false) {
    super(`Threads ${reason}`);
  }
}

function baseMetrics(enabled: boolean, configured: boolean, approved: boolean, health: ThreadsCycleMetrics["health"], reason: ThreadsReason, rotationDue = false): ThreadsCycleMetrics {
  return {
    enabled, configured, publicApprovalAttested: approved, health, reason,
    authentication: "unknown", rotationDue,
    attemptedQueries: 0, succeededQueries: 0, failedQueries: 0, skippedQueries: 0,
    observedPositions: 0, validObservations: 0, rejectedPositions: 0, outcomes: [],
  };
}

function gateResult(enabled: boolean, configured: boolean, approved: boolean, reason: ThreadsReason, rotationDue = false): ThreadsDiscoveryResult {
  const health = enabled ? "unavailable" : "disabled";
  const metrics = baseMetrics(enabled, configured, approved, health, reason, rotationDue);
  if (enabled) {
    metrics.skippedQueries = THREADS_QUERIES.length;
    metrics.outcomes = THREADS_QUERIES.map(({ id }) => ({
      queryId: id, reason: "skipped", httpStatus: null, elapsedMs: 0,
      observedPositions: 0, itemTruncated: false, pagingIgnored: false, bodyTruncated: false,
    }));
  }
  return { observations: [], metrics };
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Timed out", "AbortError");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("Timed out", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

async function boundedBody(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new ThreadsFailure("body_limit", false, true);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new ThreadsFailure("body_limit", false, true);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    try { void reader.cancel().catch(() => {}); } catch {}
    throw error;
  } finally { reader.releaseLock(); }
}

function graphFailure(payload: unknown): ThreadsFailure | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const code = (error as Record<string, unknown>).code;
  if (code === 102 || code === 190) return new ThreadsFailure("auth", true);
  if (code === 10 || code === 368 || (typeof code === "number" && code >= 200 && code <= 299)) return new ThreadsFailure("permission_or_policy", true);
  if (code === 4 || code === 17 || code === 341) return new ThreadsFailure("rate_limit", true);
  return new ThreadsFailure("api_error", true);
}

function validPermalink(value: unknown): string | undefined {
  if (typeof value !== "string" || utf8Length(value) > THREADS_LIMITS.urlBytes || /[\u0000-\u001f\u007f]/u.test(value) || /%2f|%5c/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (!["threads.com", "www.threads.com", "threads.net", "www.threads.net"].includes(url.hostname.toLowerCase())) return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 3 || !/^@[A-Za-z0-9._]+$/.test(segments[0]!) || segments[1] !== "post" || !/^[A-Za-z0-9_-]+$/.test(segments[2]!)) return undefined;
    return url.toString();
  } catch { return undefined; }
}

function validTimestamp(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]! || hour > 23 || minute > 59 || second > 59) return undefined;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(-2));
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp : undefined;
}

function validPost(value: unknown, sinceMs: number, untilMs: number): { result: SearchResult; postId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const post = value as Record<string, unknown>;
  if (typeof post.id !== "string" || !/^\d{1,64}$/.test(post.id)) return undefined;
  if (typeof post.text !== "string" || utf8Length(post.text) > THREADS_LIMITS.textBytes) return undefined;
  const text = post.text.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().replace(/\s+/gu, " ");
  if (!text) return undefined;
  const url = validPermalink(post.permalink);
  if (!url || typeof post.timestamp !== "string") return undefined;
  const timestamp = validTimestamp(post.timestamp);
  if (!timestamp) return undefined;
  const time = timestamp.getTime();
  if (time < sinceMs || time > untilMs) return undefined;
  return {
    postId: post.id,
    result: {
      title: truncateUtf8(text, THREADS_LIMITS.titleBytes),
      snippet: truncateUtf8(text, THREADS_LIMITS.snippetBytes),
      url,
      publishedAt: timestamp.toISOString(),
      source: "Threads",
    },
  };
}

function outcome(queryId: ThreadsQueryId, reason: ThreadsReason, elapsedMs: number, httpStatus: number | null, extras: Partial<ThreadsQueryOutcome> = {}): ThreadsQueryOutcome {
  return {
    queryId, reason, httpStatus, elapsedMs: Math.max(0, Math.min(THREADS_LIMITS.collectorBudgetMs, Math.round(elapsedMs))),
    observedPositions: 0, itemTruncated: false, pagingIgnored: false, bodyTruncated: false,
    ...extras,
  };
}

/** Collects the three approved public keyword queries sequentially under fixed bounds. */
export async function collectThreads(options: ThreadsCollectorOptions): Promise<ThreadsDiscoveryResult> {
  const nowMs = options.now instanceof Date ? options.now.getTime() : Number.NaN;
  if (!options.enabled) return gateResult(false, false, false, "disabled");
  const token = options.accessToken?.trim();
  const expiryMs = typeof options.tokenExpiresAt === "string" ? new Date(options.tokenExpiresAt).getTime() : Number.NaN;
  if (!token || !Number.isFinite(nowMs) || !Number.isFinite(expiryMs)) return gateResult(true, false, options.publicSearchApproved === true, "configuration");
  if (expiryMs <= nowMs) return gateResult(true, false, options.publicSearchApproved === true, "expired");
  const rotationDue = expiryMs - nowMs <= THREADS_LIMITS.rotationWarningMs;
  if (options.publicSearchApproved !== true) return gateResult(true, true, false, "public_permission_unapproved", rotationDue);

  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const collectionStarted = monotonicNow();
  const until = Math.floor(nowMs / 1000);
  const since = until - THREADS_LIMITS.freshnessSeconds;
  const metrics = baseMetrics(true, true, true, "unavailable", "ok", rotationDue);
  const observations: BatchObservation[] = [];
  let stop = false;

  for (const query of THREADS_QUERIES) {
    const elapsedBefore = monotonicNow() - collectionStarted;
    if (stop || elapsedBefore >= THREADS_LIMITS.collectorBudgetMs) {
      metrics.skippedQueries += 1;
      metrics.outcomes.push(outcome(query.id, stop ? "skipped" : "budget", elapsedBefore, null));
      continue;
    }
    const requestStarted = monotonicNow();
    const remaining = THREADS_LIMITS.collectorBudgetMs - elapsedBefore;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(THREADS_LIMITS.requestTimeoutMs, remaining));
    metrics.attemptedQueries += 1;
    let httpStatus: number | null = null;
    try {
      const url = new URL(THREADS_ENDPOINT);
      url.searchParams.set("q", query.query);
      url.searchParams.set("search_type", "RECENT");
      url.searchParams.set("search_mode", "KEYWORD");
      url.searchParams.set("limit", String(THREADS_LIMITS.positionsPerQuery));
      url.searchParams.set("fields", "id,text,permalink,timestamp");
      url.searchParams.set("since", String(since));
      url.searchParams.set("until", String(until));
      url.searchParams.set("access_token", token);
      const response = await withAbort(options.fetchImpl(url.toString(), { method: "GET", redirect: "manual", signal: controller.signal }), controller.signal);
      httpStatus = response.status;
      if ((response.status >= 300 && response.status <= 399) || response.redirected) throw new ThreadsFailure("redirect");
      const body = await boundedBody(response, response.ok ? THREADS_LIMITS.successBodyBytes : THREADS_LIMITS.errorBodyBytes, controller.signal);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { throw new ThreadsFailure("malformed"); }
      const providerFailure = graphFailure(payload);
      if (providerFailure) throw providerFailure;
      if (response.status === 401) throw new ThreadsFailure("auth", true);
      if (response.status === 403) throw new ThreadsFailure("permission_or_policy", true);
      if (response.status === 429) throw new ThreadsFailure("rate_limit", true);
      if (!response.ok) throw new ThreadsFailure("http");
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray((payload as Record<string, unknown>).data)) throw new ThreadsFailure("malformed");
      const data = (payload as { data: unknown[] }).data;
      const positions = data.slice(0, THREADS_LIMITS.positionsPerQuery);
      for (let index = 0; index < positions.length; index += 1) {
        const parsed = validPost(positions[index], since * 1000, until * 1000);
        observations.push({
          result: parsed?.result ?? null,
          provenance: { kind: "threads", queryId: query.id, postId: parsed?.postId ?? null, resultOrdinal: index + 1 },
        });
        metrics.observedPositions += 1;
        if (parsed) metrics.validObservations += 1;
        else metrics.rejectedPositions += 1;
      }
      const elapsed = monotonicNow() - requestStarted;
      if (elapsed > Math.min(THREADS_LIMITS.requestTimeoutMs, remaining)) throw new ThreadsFailure("timeout");
      metrics.succeededQueries += 1;
      metrics.authentication = "accepted";
      metrics.outcomes.push(outcome(query.id, "ok", elapsed, httpStatus, {
        observedPositions: positions.length,
        itemTruncated: data.length > THREADS_LIMITS.positionsPerQuery,
        pagingIgnored: "paging" in (payload as Record<string, unknown>),
      }));
    } catch (error) {
      const failure = controller.signal.aborted
        ? new ThreadsFailure("timeout")
        : error instanceof ThreadsFailure ? error : new ThreadsFailure("transport");
      metrics.failedQueries += 1;
      if (failure.reason === "auth") metrics.authentication = "rejected";
      metrics.outcomes.push(outcome(query.id, failure.reason, monotonicNow() - requestStarted, httpStatus, { bodyTruncated: failure.bodyTruncated }));
      if (failure.terminal) stop = true;
    } finally { clearTimeout(timer); }
  }

  metrics.health = metrics.succeededQueries === THREADS_QUERIES.length ? "healthy" : metrics.succeededQueries > 0 ? "degraded" : "unavailable";
  metrics.reason = metrics.outcomes.find(item => item.reason !== "ok" && item.reason !== "skipped")?.reason ?? "ok";
  return { observations: observations.slice(0, THREADS_LIMITS.observationsPerCycle), metrics };
}
