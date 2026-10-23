import { collectRss } from "../../src/services/rssDiscovery.js";
import { workerdRssFetch } from "../../src/worker.js";

interface DiagnosticEnv {
  RSS_FIXTURE_URL: string;
  RSS_FIXTURE_MODE?: "single" | "sequential";
}

const fixtureFeed = {
  id: "receiver_fixture",
  label: "Receiver Fixture",
  endpoint: "https://example.com/feed.xml",
  articleHostnames: ["example.com"],
} as const;

const sequentialFeeds = [
  { id: "fixture_a", label: "Fixture A", endpoint: "https://fixture-a.example/feed.xml", articleHostnames: ["fixture-a.example"] },
  { id: "fixture_overflow", label: "Fixture Overflow", endpoint: "https://fixture-overflow.example/feed.xml", articleHostnames: ["fixture-overflow.example"] },
  { id: "fixture_b", label: "Fixture B", endpoint: "https://fixture-b.example/feed.xml", articleHostnames: ["fixture-b.example"] },
  { id: "fixture_c", label: "Fixture C", endpoint: "https://fixture-c.example/feed.xml", articleHostnames: ["fixture-c.example"] },
] as const;

const sequentialPaths = new Map([
  [sequentialFeeds[0].endpoint, "/large-a.xml"],
  [sequentialFeeds[1].endpoint, "/overflow.xml"],
  [sequentialFeeds[2].endpoint, "/large-b.xml"],
  [sequentialFeeds[3].endpoint, "/large-c.xml"],
]);

function errorRecord(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
}

export default {
  async fetch(_request: Request, env: DiagnosticEnv): Promise<Response> {
    const rawHolder = { fetch: globalThis.fetch };
    const aborted = new AbortController();
    aborted.abort();
    let rawReferenceError: { name: string; message: string } | undefined;
    try {
      await rawHolder.fetch(env.RSS_FIXTURE_URL, { signal: aborted.signal });
    } catch (error) {
      rawReferenceError = errorRecord(error);
    }

    const sequential = env.RSS_FIXTURE_MODE === "sequential";
    const fixtureOrigin = new URL(env.RSS_FIXTURE_URL).origin;
    const result = await collectRss({
      now: new Date("2026-10-19T08:00:00.000Z"),
      feeds: sequential ? sequentialFeeds : [fixtureFeed],
      fetch: (input, init) => {
        if (!sequential) return workerdRssFetch(env.RSS_FIXTURE_URL, init);
        const path = sequentialPaths.get(String(input));
        if (!path) throw new Error("Unexpected RSS fixture request");
        return workerdRssFetch(`${fixtureOrigin}${path}`, init);
      },
    });

    return Response.json({ rawReferenceError, result });
  },
};
