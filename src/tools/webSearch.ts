import type { SearchResult } from "../types/index.js";
import { checkBraveSearchUsage } from "../services/usageGuard.js";
import { LocalJsonBraveUsageStore } from "../services/localJsonBraveUsageStore.js";
import type { BraveUsageStore } from "../services/usageTracker.js";

const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
}

interface SearchWebDependencies {
  usageTracker?: BraveUsageStore;
  fetchImplementation?: typeof fetch;
}

function getSourceName(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function toSearchResult(result: BraveWebResult): SearchResult | undefined {
  if (!result.title || !result.url) {
    return undefined;
  }

  return {
    title: result.title,
    url: result.url,
    snippet: result.description,
    publishedAt: result.page_age,
    source: getSourceName(result.url)
  };
}

/** Retrieves normalized web results without interpreting their contents. */
export async function searchWeb(
  query: string,
  dependencies: SearchWebDependencies = {}
): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("BRAVE_SEARCH_API_KEY is not configured. Add it to your .env file.");
  }

  if (!query.trim()) {
    throw new Error("A non-empty search query is required.");
  }

  const usageTracker = dependencies.usageTracker ?? new LocalJsonBraveUsageStore();
  const usageCheck = await checkBraveSearchUsage(usageTracker);
  if (!usageCheck.allowed) {
    throw new Error("Brave search request blocked by usage guard.");
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
      body: JSON.stringify({ q: query.trim(), count: 5 })
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

  let data: BraveSearchResponse;
  try {
    data = (await response.json()) as BraveSearchResponse;
  } catch {
    throw new Error("Brave Search API returned invalid JSON.");
  }

  return (data.web?.results ?? [])
    .map(toSearchResult)
    .filter((result): result is SearchResult => result !== undefined);
}
