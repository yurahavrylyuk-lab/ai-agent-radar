export const X_API_ORIGIN = "https://api.x.com";
export const X_RESPONSE_BODY_LIMIT = 256 * 1024;
export const X_REQUEST_TIMEOUT_MS = 10_000;

export interface XTimelineRequest {
  userId: string;
  sinceId?: string;
  startTime: string;
  endTime: string;
  bearerToken: string;
}

export interface XTimelineResponse {
  data: unknown[];
  truncated: boolean;
}

export class XRequestError extends Error {
  constructor(
    message: string,
    readonly reason: "auth" | "rate_limit" | "account_unavailable" | "timeout" | "provider_error" | "malformed_response" | "contract_drift",
  ) { super(message); }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > X_RESPONSE_BODY_LIMIT) { await reader.cancel(); throw new XRequestError("X response exceeded the allowed body size.", "contract_drift"); }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

/** Performs one exact, non-retrying selected-account timeline request. */
export async function readAccountPosts(
  request: XTimelineRequest,
  dependencies: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<XTimelineResponse> {
  if (!/^[1-9]\d{0,24}$/.test(request.userId) || !request.bearerToken.trim()) throw new XRequestError("X request configuration is invalid.", "auth");
  const url = new URL(`/2/users/${request.userId}/tweets`, X_API_ORIGIN);
  url.searchParams.set("max_results", "10");
  url.searchParams.set("exclude", "replies,retweets");
  url.searchParams.set("start_time", request.startTime);
  url.searchParams.set("end_time", request.endTime);
  if (request.sinceId) url.searchParams.set("since_id", request.sinceId);
  url.searchParams.set("post.fields", "id,author_id,created_at,text,entities,referenced_tweets,edit_history_tweet_ids");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? X_REQUEST_TIMEOUT_MS);
  try {
    const response = await (dependencies.fetch ?? fetch)(url, {
      method: "GET",
      headers: { authorization: `Bearer ${request.bearerToken}`, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readBoundedBody(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new XRequestError("X authentication or permission was denied.", "auth");
      if (response.status === 404) throw new XRequestError("Approved X account is unavailable.", "account_unavailable");
      if (response.status === 429) throw new XRequestError("X rate or credit limit was reached.", "rate_limit");
      throw new XRequestError("X timeline request failed.", "provider_error");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new XRequestError("X response was not valid JSON.", "malformed_response"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new XRequestError("X response envelope was invalid.", "malformed_response");
    const envelope = parsed as { data?: unknown; meta?: unknown; includes?: unknown };
    if (envelope.includes !== undefined) throw new XRequestError("X response included unrequested expansions.", "contract_drift");
    const data = envelope.data === undefined ? [] : envelope.data;
    if (!Array.isArray(data)) throw new XRequestError("X response data was invalid.", "malformed_response");
    if (data.length > 10) throw new XRequestError("X response exceeded the approved resource count.", "contract_drift");
    const meta = envelope.meta && typeof envelope.meta === "object" && !Array.isArray(envelope.meta) ? envelope.meta as Record<string, unknown> : {};
    return { data, truncated: typeof meta.next_token === "string" && meta.next_token.length > 0 };
  } catch (error) {
    if (error instanceof XRequestError) throw error;
    if (controller.signal.aborted) throw new XRequestError("X timeline request timed out.", "timeout");
    throw new XRequestError("X timeline request failed.", "provider_error");
  } finally { clearTimeout(timer); }
}
