import { collectThreads } from "../../src/services/threadsDiscovery.js";
import { workerdThreadsFetch } from "../../src/worker.js";

interface Env { THREADS_FIXTURE_ORIGIN: string }

function errorRecord(error: unknown): { name: string; message: string } {
  return { name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const testCase = new URL(request.url).searchParams.get("case") ?? "native_fetch_receiver_and_abort";
    const rawHolder = { fetch: globalThis.fetch };
    const aborted = new AbortController(); aborted.abort();
    let rawReferenceError: { name: string; message: string } | undefined;
    try { await rawHolder.fetch(`${env.THREADS_FIXTURE_ORIGIN}/normal`, { signal: aborted.signal }); }
    catch (error) { rawReferenceError = errorRecord(error); }

    const disabled = testCase === "disabled_binding_has_zero_requests";
    const fixturePath = testCase === "stream_cap_cancels_reader" ? "/overflow"
      : testCase === "redirect_never_forwards_token" ? "/redirect"
        : testCase === "failed_threads_keeps_combined_cycle" ? "/timeout" : "/normal";
    const result = await collectThreads({
      enabled: !disabled,
      publicSearchApproved: !disabled,
      accessToken: disabled ? undefined : "fixture-secret",
      tokenExpiresAt: disabled ? undefined : "2026-11-25T08:00:00.000Z",
      now: new Date("2026-10-25T08:00:00.000Z"),
      fetchImpl: (input, init) => {
        const official = new URL(String(input));
        if (official.origin !== "https://graph.threads.com" || official.pathname !== "/v1.0/keyword_search") throw new Error("Unexpected Threads request");
        if (!official.searchParams.get("q") || official.searchParams.get("access_token") !== "fixture-secret") throw new Error("Invalid official Threads request");
        return workerdThreadsFetch(`${env.THREADS_FIXTURE_ORIGIN}${fixturePath}`, init);
      },
    });
    return Response.json({
      rawReferenceError,
      metrics: result.metrics,
      observations: result.observations.length,
      otherSourceHealthy: true,
      finalizerReached: true,
    });
  },
};
