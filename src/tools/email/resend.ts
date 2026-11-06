import type { DiscoveryEmailContent, EmailSendResult } from "../../types/index.js";
import type { RuntimeEnvironment } from "../../services/radarRuntimeConfiguration.js";
import type { DeliveryKey, ResendOutcome } from "../../services/emailDeliveryLedger.js";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 30_000;
export const RESEND_ONBOARDING_SENDER = "AI Agent Radar <onboarding@resend.dev>";

export interface ResendDependencies {
  environment?: RuntimeEnvironment;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

export class ResendPreDispatchError extends Error {
  constructor() { super("Resend request was rejected before dispatch."); this.name = "ResendPreDispatchError"; }
}

const frozenKey = /^daily-digest\/\d{4}-\d{2}-\d{2}$/;
const responseBytes = 8 * 1024;

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
      ]);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > responseBytes) { void reader.cancel().catch(() => undefined); return null; }
      chunks.push(result.value);
    }
  } catch { throw new DOMException("aborted", "AbortError"); }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(joined); } catch { return null; }
}

function structuredName(body: string | null): string | null {
  if (body === null) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const name = (parsed as Record<string, unknown>).name;
    return typeof name === "string" && name.length <= 64 ? name : null;
  } catch { return null; }
}

function rejection(status: number, name: string | null): ResendOutcome | null {
  if (status === 400 && ["validation_error", "invalid_idempotency_key"].includes(name ?? "")) return { kind: "rejected", rejection: "validation" };
  if (status === 401 && ["missing_api_key", "invalid_api_key"].includes(name ?? "")) return { kind: "rejected", rejection: "authentication" };
  if (status === 403 && ["restricted_api_key", "domain_not_verified"].includes(name ?? "")) return { kind: "rejected", rejection: "permission" };
  if (status === 422 && name === "validation_error") return { kind: "rejected", rejection: "validation" };
  if (status === 429 && name === "rate_limit_exceeded") return { kind: "rejected", rejection: "quota" };
  return null;
}

/** Sends already-verified canonical bytes exactly once for scheduled delivery. */
export async function sendFrozenWithResend(
  body: string,
  key: DeliveryKey,
  dependencies: ResendDependencies = {},
): Promise<ResendOutcome> {
  const environment = dependencies.environment ?? process.env;
  const apiKey = environment.RESEND_API_KEY?.trim();
  if (!apiKey || !frozenKey.test(key) || !body || new TextEncoder().encode(body).byteLength > 280 * 1024) {
    throw new ResendPreDispatchError();
  }
  try { JSON.parse(body); } catch { throw new ResendPreDispatchError(); }
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? RESEND_TIMEOUT_MS);
  const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  try {
    let response: Response;
    try {
      response = await Promise.race([fetchImplementation(RESEND_EMAILS_URL, {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body,
        signal: controller.signal,
      }), aborted]);
    } catch {
      return { kind: "ambiguous", reason: controller.signal.aborted ? "timeout" : "transport" };
    }
    let responseBody: string | null;
    try { responseBody = await readBoundedResponse(response, controller.signal); }
    catch { return { kind: "ambiguous", reason: controller.signal.aborted ? "timeout" : "transport" }; }
    if (response.status >= 300 && response.status < 400) return { kind: "ambiguous", reason: "http" };
    const name = structuredName(responseBody);
    if (response.status === 409 && name === "invalid_idempotent_request") return { kind: "payload_conflict" };
    if (response.status === 409 && name === "concurrent_idempotent_requests") return { kind: "ambiguous", reason: "concurrent" };
    if (!response.ok) return rejection(response.status, name) ?? { kind: "ambiguous", reason: "http" };
    if (responseBody === null) return { kind: "ambiguous", reason: "invalid_response" };
    try {
      const parsed = JSON.parse(responseBody) as unknown;
      const id = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).id : undefined;
      return typeof id === "string" && id.trim().length > 0 && new TextEncoder().encode(id).byteLength <= 256
        ? { kind: "accepted", id }
        : { kind: "ambiguous", reason: "invalid_response" };
    } catch { return { kind: "ambiguous", reason: "invalid_response" }; }
  } finally { clearTimeout(timeout); }
}

function required(name: "RESEND_API_KEY" | "NOTIFICATION_EMAIL", environment: RuntimeEnvironment): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is not configured. Add it to your .env file.`);
  return value;
}

function safeMessage(value: unknown, secrets: string[]): string {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "Unknown Resend API error";
  return secrets.reduce((safe, secret) => safe.replaceAll(secret, "[REDACTED]"), message);
}

async function safeErrorMessage(response: Response, secrets: string[]): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { message?: unknown; name?: unknown };
    const message = parsed.message ?? parsed.name;
    if (typeof message === "string" && message) return safeMessage(message, secrets);
  } catch {
    // Fall through to a safely bounded raw response body.
  }
  return safeMessage(body.slice(0, 1_000) || "No response body returned.", secrets);
}

export async function sendWithResend(
  content: DiscoveryEmailContent,
  dependencies: ResendDependencies = {},
): Promise<EmailSendResult> {
  const environment = dependencies.environment ?? process.env;
  const apiKey = required("RESEND_API_KEY", environment);
  const recipient = required("NOTIFICATION_EMAIL", environment);
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const secrets = [apiKey, recipient];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? RESEND_TIMEOUT_MS);
  let response: Response;
  const abortPromise = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Resend email request timed out after 30 seconds.")), { once: true }));

  try {
    response = await Promise.race([fetchImplementation(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_ONBOARDING_SENDER,
        to: [recipient],
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
      signal: controller.signal,
    }), abortPromise]);
    if (!response.ok) {
      const message = await Promise.race([safeErrorMessage(response, secrets), abortPromise]);
      throw new Error(`Resend email request failed: HTTP ${response.status} ${response.statusText}: ${message}`);
    }
    let data: unknown;
    try {
      data = await Promise.race([response.json(), abortPromise]);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error("Resend API returned invalid JSON.");
    }
    const emailId = data && typeof data === "object" ? (data as Record<string, unknown>).id : undefined;
    if (typeof emailId !== "string" || !emailId.trim()) throw new Error("Resend API returned an unexpected success response.");
    return { id: emailId };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Resend email request timed out after 30 seconds.");
    throw new Error(`Resend email request failed: ${safeMessage(error, secrets)}`);
  } finally {
    clearTimeout(timeout);
  }
}
