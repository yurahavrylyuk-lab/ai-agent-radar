import { collectRss } from "../../src/services/rssDiscovery.js";
import { workerdRssFetch } from "../../src/worker.js";

interface DiagnosticEnv {
  RSS_FIXTURE_URL: string;
}

const fixtureFeed = {
  id: "receiver_fixture",
  label: "Receiver Fixture",
  endpoint: "https://example.com/feed.xml",
  articleHostnames: ["example.com"],
} as const;

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

    const result = await collectRss({
      now: new Date("2026-10-19T08:00:00.000Z"),
      feeds: [fixtureFeed],
      fetch: (_input, init) => workerdRssFetch(env.RSS_FIXTURE_URL, init),
    });

    return Response.json({ rawReferenceError, result });
  },
};
