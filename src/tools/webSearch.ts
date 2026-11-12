import type { BraveSearchPage, SearchResult } from "../types/index.js";
import { checkBraveSearchUsage } from "../services/usageGuard.js";
import type { BraveUsageStore } from "../services/usageTracker.js";
import type { RuntimeEnvironment } from "../services/radarRuntimeConfiguration.js";

const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export const BRAVE_REQUEST_TIMEOUT_MS = 5_000;
export const BRAVE_SUCCESS_BODY_LIMIT_BYTES = 262_144;
export const BRAVE_ERROR_BODY_LIMIT_BYTES = 16_384;

export type BraveRequestFailureReason =
  | "timeout"
  | "redirect"
  | "body_limit"
  | "transport"
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_response"
  | "http"
  | "accounting";

const braveRequestMessages: Record<Exclude<BraveRequestFailureReason, "http">, string> = {
  timeout: "Brave Search request timed out.",
  redirect: "Brave Search API returned a redirect.",
  body_limit: "Brave Search API response exceeded its byte limit.",
  transport: "Brave Search transport failed.",
  invalid_utf8: "Brave Search API returned invalid UTF-8.",
  invalid_json: "Brave Search API returned invalid JSON.",
  invalid_response: "Brave Search API returned an invalid response format.",
  accounting: "Brave search succeeded, but its usage could not be recorded safely.",
};

/** Fixed, content-free Brave transport failure safe for bounded monitoring output. */
export class BraveRequestError extends Error {
  constructor(
    public readonly reason: BraveRequestFailureReason,
    public readonly httpStatus?: number,
  ) {
    super(reason === "http" && httpStatus !== undefined
      ? `Brave Search API returned ${httpStatus}.`
      : reason === "http" ? "Brave Search API returned an HTTP error." : braveRequestMessages[reason]);
    this.name = "BraveRequestError";
  }
}

export interface BraveDeadlineScheduler {
  readonly now: () => number;
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const defaultDeadlineScheduler: BraveDeadlineScheduler = {
  now: () => performance.now(),
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  void response.body.cancel().catch(() => undefined);
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pendingRead?: Promise<ReadableStreamReadResult<Uint8Array>>,
): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never replace the bounded failure.
  }
  const release = (): void => {
    try { reader.releaseLock(); } catch { /* A pending read still owns the lock. */ }
  };
  if (pendingRead) void pendingRead.catch(() => undefined).finally(release);
  else release();
}

function validateContentLength(response: Response, limit: number): void {
  if (!response.headers.has("content-length")) return;
  const value = response.headers.get("content-length") ?? "";
  if (!/^\d+$/.test(value)) throw new BraveRequestError("body_limit");
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > limit) {
    throw new BraveRequestError("body_limit");
  }
}

class BraveDeadline {
  readonly controller = new AbortController();
  private readonly startedAt: number;
  private readonly timer: unknown;
  private readonly failurePromise: Promise<never>;
  private rejectFailure!: (error: BraveRequestError) => void;
  private failure: BraveRequestError | undefined;
  private closed = false;

  constructor(private readonly scheduler: BraveDeadlineScheduler) {
    this.startedAt = scheduler.now();
    this.failurePromise = new Promise<never>((_resolve, reject) => {
      this.rejectFailure = reject;
    });
    this.timer = scheduler.set(() => this.expire(), BRAVE_REQUEST_TIMEOUT_MS);
  }

  private expire(): void {
    this.fail(new BraveRequestError("timeout"));
  }

  private fail(error: BraveRequestError): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.controller.abort();
    this.rejectFailure(error);
  }

  ensureActive(): void {
    if (this.failure) throw this.failure;
    if (this.scheduler.now() - this.startedAt >= BRAVE_REQUEST_TIMEOUT_MS) {
      this.expire();
      throw new BraveRequestError("timeout");
    }
  }

  abort(): void {
    this.fail(new BraveRequestError("transport"));
  }

  async wait<T>(promise: Promise<T>, onLateValue?: (value: T) => void): Promise<T> {
    void promise.then(value => {
      if (this.failure) onLateValue?.(value);
    }, () => undefined);
    return Promise.race([promise, this.failurePromise]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.scheduler.clear(this.timer);
  }
}

async function readBoundedBody(
  response: Response,
  limit: number,
  deadline: BraveDeadline,
): Promise<Uint8Array> {
  try {
    validateContentLength(response, limit);
  } catch (error) {
    cancelResponseBody(response);
    throw error;
  }
  deadline.ensureActive();
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  try {
    while (true) {
      deadline.ensureActive();
      pendingRead = reader.read();
      const result = await deadline.wait(pendingRead);
      pendingRead = undefined;
      deadline.ensureActive();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new BraveRequestError("transport");
      total += result.value.byteLength;
      if (total > limit) throw new BraveRequestError("body_limit");
      chunks.push(result.value);
    }

    reader.releaseLock();
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch (error) {
    cancelReader(reader, pendingRead);
    if (error instanceof BraveRequestError) throw error;
    throw new BraveRequestError("transport");
  }
}

function parseSuccessBody(body: Uint8Array, deadline: BraveDeadline): unknown {
  deadline.ensureActive();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new BraveRequestError("invalid_utf8");
  }
  deadline.ensureActive();
  try {
    const parsed: unknown = JSON.parse(text);
    deadline.ensureActive();
    return parsed;
  } catch (error) {
    if (error instanceof BraveRequestError) throw error;
    throw new BraveRequestError("invalid_json");
  }
}

export interface SearchWebDependencies {
  usageTracker?: BraveUsageStore;
  environment?: RuntimeEnvironment;
  fetchImplementation?: typeof fetch;
  /** Optional documented Brave freshness filter for bounded monitoring calls. */
  freshness?: "pw";
  /** Deterministic offline-test seam; production always uses the fixed 5-second deadline. */
  deadlineScheduler?: BraveDeadlineScheduler;
}

/** Signals that the existing Brave usage guard denied a request. */
export class BraveUsageGuardDeniedError extends Error {
  constructor() {
    super("Brave search request blocked by usage guard.");
    this.name = "BraveUsageGuardDeniedError";
  }
}

function getSourceName(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function toSearchResult(value: unknown): SearchResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (typeof result.title !== "string" || !result.title.trim()
      || typeof result.url !== "string" || !result.url.trim()) {
    return null;
  }

  return {
    title: result.title,
    url: result.url,
    ...(typeof result.description === "string" ? { snippet: result.description } : {}),
    ...(typeof result.page_age === "string" ? { publishedAt: result.page_age } : {}),
    source: getSourceName(result.url)
  };
}

/** Retains the first five provider positions, including unusable source fields. */
export async function searchWebPage(
  query: string,
  dependencies: SearchWebDependencies = {}
): Promise<BraveSearchPage> {
  const environment = dependencies.environment ?? process.env;
  const apiKey = environment.BRAVE_SEARCH_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is not configured. Add it to your .env file.");
  }

  if (!query.trim()) {
    throw new Error("A non-empty search query is required.");
  }

  const usageTracker = dependencies.usageTracker;
  if (!usageTracker) throw new Error("Brave usage tracker is required.");
  const usageCheck = await checkBraveSearchUsage(usageTracker, environment);
  if (!usageCheck.allowed) {
    throw new BraveUsageGuardDeniedError();
  }

  const fetchImplementation = dependencies.fetchImplementation
    ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const deadline = new BraveDeadline(dependencies.deadlineScheduler ?? defaultDeadlineScheduler);

  let response: Response;
  try {
    const fetchPromise = fetchImplementation(BRAVE_WEB_SEARCH_URL, {
      method: "POST",
      redirect: "manual",
      signal: deadline.controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Subscription-Token": apiKey
      },
      body: JSON.stringify({
        q: query.trim(),
        count: 5,
        ...(dependencies.freshness === undefined ? {} : { freshness: dependencies.freshness }),
      })
    });
    response = await deadline.wait(fetchPromise, cancelResponseBody);
    deadline.ensureActive();

    if (response.status >= 300 && response.status <= 399) {
      cancelResponseBody(response);
      throw new BraveRequestError("redirect", response.status);
    }
    if (!response.ok) {
      await readBoundedBody(response, BRAVE_ERROR_BODY_LIMIT_BYTES, deadline);
      throw new BraveRequestError("http", response.status);
    }

    const accountingPromise = usageTracker.recordRequest({
      timestamp: new Date().toISOString(),
      provider: "brave",
      operation: "web-search",
      requestCount: 1
    }).catch(() => {
      deadline.abort();
      cancelResponseBody(response);
      throw new BraveRequestError("accounting");
    });
    const dataPromise = readBoundedBody(response, BRAVE_SUCCESS_BODY_LIMIT_BYTES, deadline)
      .then(body => parseSuccessBody(body, deadline));
    const [accounting, body] = await Promise.allSettled([accountingPromise, dataPromise]);
    if (accounting.status === "rejected") throw accounting.reason;
    if (body.status === "rejected") throw body.reason;
    const data: unknown = body.value;

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new BraveRequestError("invalid_response");
    }
    const web = (data as Record<string, unknown>).web;
    if (web !== undefined && (!web || typeof web !== "object" || Array.isArray(web))) {
      throw new BraveRequestError("invalid_response");
    }
    const rawResults = web === undefined ? undefined : (web as Record<string, unknown>).results;
    if (rawResults !== undefined && !Array.isArray(rawResults)) {
      throw new BraveRequestError("invalid_response");
    }
    const results = rawResults ?? [];
    return {
      rawCount: results.length,
      positions: results.slice(0, 5).map((result, index) => ({ resultOrdinal: index + 1, result: toSearchResult(result) })),
    };
  } catch (error) {
    deadline.abort();
    if (error instanceof BraveRequestError) throw error;
    throw new BraveRequestError("transport");
  } finally {
    deadline.close();
  }
}

/** Projects usable source records from the same single bounded page request. */
export async function searchWeb(
  query: string,
  dependencies: SearchWebDependencies = {},
): Promise<SearchResult[]> {
  const page = await searchWebPage(query, dependencies);
  return page.positions.flatMap(({ result }) => result === null ? [] : [result]);
}
