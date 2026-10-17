export interface RssFeedDefinition {
  readonly id: string;
  readonly label: string;
  readonly endpoint: string;
  readonly articleHostnames: readonly string[];
}

/** Human-approved first-party feed registry, approved 2026-10-16. */
export const RSS_FEEDS: readonly RssFeedDefinition[] = [
  { id: "openai_news", label: "OpenAI News", endpoint: "https://openai.com/news/rss.xml", articleHostnames: ["openai.com"] },
  { id: "github_changelog", label: "GitHub Changelog", endpoint: "https://github.blog/changelog/feed/", articleHostnames: ["github.blog"] },
  { id: "cloudflare_ai", label: "Cloudflare AI", endpoint: "https://blog.cloudflare.com/tag/ai/rss/", articleHostnames: ["blog.cloudflare.com"] },
  { id: "chrome_developers", label: "Chrome for Developers", endpoint: "https://developer.chrome.com/static/blog/feed.xml", articleHostnames: ["developer.chrome.com"] },
] as const;

export const RSS_LIMITS = Object.freeze({
  feeds: 5,
  itemsPerFeed: 5,
  timeoutMs: 5000,
  bodyBytes: 262144,
  depth: 32,
  elements: 10000,
  fieldBytes: 8192,
  titleBytes: 256,
  snippetBytes: 768,
  urlBytes: 2048,
  ageMs: 604800000,
});

const publicHostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("RSS endpoint is invalid."); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || endpoint.hash) {
    throw new Error("RSS endpoint is not an approved HTTPS endpoint.");
  }
  if (!publicHostname.test(endpoint.hostname) || endpoint.hostname === "localhost" || endpoint.hostname.endsWith(".internal") || endpoint.hostname.endsWith(".local")) {
    throw new Error("RSS endpoint hostname is not public.");
  }
  return endpoint;
}

export function validateRssFeeds(feeds: readonly RssFeedDefinition[]): void {
  if (feeds.length > RSS_LIMITS.feeds) throw new Error("RSS feed limit exceeded.");
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  for (const feed of feeds) {
    if (!feed || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(feed.id) || ids.has(feed.id)) throw new Error("RSS feed ID is invalid or duplicated.");
    if (typeof feed.label !== "string" || !feed.label.trim()) throw new Error("RSS feed label is invalid.");
    const endpoint = parseEndpoint(feed.endpoint).toString();
    if (endpoints.has(endpoint)) throw new Error("RSS endpoint is duplicated.");
    if (!Array.isArray(feed.articleHostnames) || feed.articleHostnames.length === 0) throw new Error("RSS article hostnames are required.");
    const hosts = new Set<string>();
    for (const hostname of feed.articleHostnames) {
      if (typeof hostname !== "string" || hostname !== hostname.toLowerCase() || !publicHostname.test(hostname) || hosts.has(hostname)) {
        throw new Error("RSS article hostname is invalid or duplicated.");
      }
      hosts.add(hostname);
    }
    ids.add(feed.id); endpoints.add(endpoint);
  }
}

export function isApprovedRssArticleUrl(value: string, feed: RssFeedDefinition): boolean {
  if (new TextEncoder().encode(value).byteLength > RSS_LIMITS.urlBytes) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && !url.username && !url.password && !url.port
      && url.pathname !== "/" && feed.articleHostnames.includes(url.hostname);
  } catch { return false; }
}

validateRssFeeds(RSS_FEEDS);
