import { BraveRequestError, searchWebPage } from "../../src/tools/webSearch.js";
import type { UsageRecord, UsageTracker } from "../../src/services/usageTracker.js";

interface HarnessEnvironment {
  BRAVE_FIXTURE_ORIGIN: string;
}

const paths = new Map([
  ["valid", "/valid"],
  ["malformed", "/malformed"],
  ["oversized", "/oversized"],
  ["error", "/error"],
  ["redirect", "/redirect"],
  ["delayed-headers", "/delayed-headers"],
  ["delayed-body", "/delayed-body"],
]);

export default {
  async fetch(request: Request, env: HarnessEnvironment): Promise<Response> {
    const mode = new URL(request.url).searchParams.get("mode") ?? "valid";
    const path = paths.get(mode);
    if (!path) return new Response("unknown fixture", { status: 400 });

    const records: UsageRecord[] = [];
    const usageTracker: UsageTracker = {
      getRecords: async () => records,
      recordRequest: async record => { records.push(record); },
    };
    const startedAt = Date.now();
    try {
      const page = await searchWebPage("workerd bounded request", {
        usageTracker,
        environment: {
          BRAVE_SEARCH_API_KEY: "offline-fixture-key",
          BRAVE_DAILY_SEARCH_LIMIT: "10",
          BRAVE_WEEKLY_SEARCH_LIMIT: "100",
          BRAVE_MONTHLY_SEARCH_LIMIT: "350",
        },
        fetchImplementation: (_input, init) => globalThis.fetch(`${env.BRAVE_FIXTURE_ORIGIN}${path}`, init),
      });
      return Response.json({ ok: true, rawCount: page.rawCount, records: records.length, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      return Response.json({
        ok: false,
        reason: error instanceof BraveRequestError ? error.reason : "unexpected",
        status: error instanceof BraveRequestError ? error.httpStatus : undefined,
        records: records.length,
        elapsedMs: Date.now() - startedAt,
      });
    }
  },
};
