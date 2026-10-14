import type { BraveSearchPage, SearchResult } from "../types/index.js";
import { checkBraveSearchUsage } from "../services/usageGuard.js";
import type { BraveUsageStore } from "../services/usageTracker.js";
import type { RuntimeEnvironment } from "../services/radarRuntimeConfiguration.js";

const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export interface SearchWebDependencies {
  usageTracker?: BraveUsageStore;
  environment?: RuntimeEnvironment;
  fetchImplementation?: typeof fetch;
  /** Optional documented Brave freshness filter for bounded monitoring calls. */
  freshness?: "pw";
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

  const fetchImplementation = dependencies.fetchImplementation ?? fetch;

  let response: Response;
  try {
    response = await fetchImplementation(BRAVE_WEB_SEARCH_URL, {
      method: "POST",
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown network error";
    throw new Error(`Could not reach the Brave Search API: ${message}`);
  }

  if (!response.ok) {
    const responseBody = await response.text();
    const safeBody = responseBody.replaceAll(apiKey, "[REDACTED]").trim();
    const detail = safeBody || "No response body returned.";

    throw new Error(
      `Brave Search API returned ${response.status} ${response.statusText}: ${detail}`
    );
  }

  try {
    await usageTracker.recordRequest({
      timestamp: new Date().toISOString(),
      provider: "brave",
      operation: "web-search",
      requestCount: 1
    });
  } catch {
    throw new Error("Brave search succeeded, but its usage could not be recorded safely.");
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Brave Search API returned invalid JSON.");
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Brave Search API returned an invalid response format.");
  }
  const web = (data as Record<string, unknown>).web;
  if (web !== undefined && (!web || typeof web !== "object" || Array.isArray(web))) {
    throw new Error("Brave Search API returned an invalid response format.");
  }
  const rawResults = web === undefined ? undefined : (web as Record<string, unknown>).results;
  if (rawResults !== undefined && !Array.isArray(rawResults)) {
    throw new Error("Brave Search API returned invalid results format.");
  }
  const results = rawResults ?? [];
  return {
    rawCount: results.length,
    positions: results.slice(0, 5).map((result, index) => ({ resultOrdinal: index + 1, result: toSearchResult(result) })),
  };
}

/** Projects usable source records from the same single bounded page request. */
export async function searchWeb(
  query: string,
  dependencies: SearchWebDependencies = {},
): Promise<SearchResult[]> {
  const page = await searchWebPage(query, dependencies);
  return page.positions.flatMap(({ result }) => result === null ? [] : [result]);
}
