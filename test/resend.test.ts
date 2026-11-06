import assert from "node:assert/strict";
import test from "node:test";
import { RESEND_ONBOARDING_SENDER, ResendPreDispatchError, sendFrozenWithResend, sendWithResend } from "../src/tools/email/resend.js";
import type { DiscoveryEmailContent } from "../src/types/index.js";

const environment = { RESEND_API_KEY: "test-resend-secret", NOTIFICATION_EMAIL: "recipient@example.com" };
const content: DiscoveryEmailContent = { subject: "AI Agent Radar: Test", text: "Plain text", html: "<p>HTML</p>" };

test("sends formatted content to Resend with the configured sender and recipient", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const result = await sendWithResend(content, {
    environment,
    fetchImplementation: (async (url, init) => {
      requestedUrl = String(url);
      requestedInit = init;
      return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
    }) as typeof fetch,
  });

  assert.deepEqual(result, { id: "email_123" });
  assert.equal(requestedUrl, "https://api.resend.com/emails");
  assert.equal(requestedInit?.method, "POST");
  assert.deepEqual(requestedInit?.headers, { Authorization: "Bearer test-resend-secret", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    from: RESEND_ONBOARDING_SENDER,
    to: [environment.NOTIFICATION_EMAIL],
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
});

test("missing Resend API key blocks fetch", async () => {
  let called = false;
  await assert.rejects(sendWithResend(content, {
    environment: { NOTIFICATION_EMAIL: environment.NOTIFICATION_EMAIL },
    fetchImplementation: (async () => { called = true; return new Response(); }) as typeof fetch,
  }), /RESEND_API_KEY is not configured/);
  assert.equal(called, false);
});

test("missing notification email blocks fetch", async () => {
  let called = false;
  await assert.rejects(sendWithResend(content, {
    environment: { RESEND_API_KEY: environment.RESEND_API_KEY },
    fetchImplementation: (async () => { called = true; return new Response(); }) as typeof fetch,
  }), /NOTIFICATION_EMAIL is not configured/);
  assert.equal(called, false);
});

test("non-2xx responses are useful and redact secrets", async () => {
  await assert.rejects(sendWithResend(content, {
    environment,
    fetchImplementation: (async () => new Response(JSON.stringify({ message: `Rejected ${environment.RESEND_API_KEY} ${environment.NOTIFICATION_EMAIL}` }), { status: 403, statusText: "Forbidden" })) as typeof fetch,
  }), (error: Error) => {
    assert.match(error.message, /HTTP 403 Forbidden/);
    assert.doesNotMatch(error.message, /test-resend-secret|recipient@example\.com/);
    return true;
  });
});

test("network failures are redacted", async () => {
  await assert.rejects(sendWithResend(content, {
    environment,
    fetchImplementation: (async () => { throw new Error(`Network failure for ${environment.RESEND_API_KEY}`); }) as typeof fetch,
  }), (error: Error) => {
    assert.match(error.message, /Resend email request failed/);
    assert.doesNotMatch(error.message, /test-resend-secret/);
    return true;
  });
});

test("aborted requests report a timeout without sending a retry", async () => {
  await assert.rejects(sendWithResend(content, {
    environment,
    timeoutMs: 1,
    fetchImplementation: (async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
      throw new Error("unreachable");
    }) as typeof fetch,
  }), /Resend email request timed out after 30 seconds/);
});

test("malformed or unexpected success responses are rejected", async () => {
  await assert.rejects(sendWithResend(content, {
    environment,
    fetchImplementation: (async () => new Response("not JSON", { status: 200 })) as typeof fetch,
  }), /Resend API returned invalid JSON/);
  await assert.rejects(sendWithResend(content, {
    environment,
    fetchImplementation: (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch,
  }), /unexpected success response/);
});

test("the 30-second deadline covers response-body parsing", async () => {
  await assert.rejects(sendWithResend(content, {
    environment, timeoutMs: 5,
    fetchImplementation: (async () => ({ ok: true, status: 200, statusText: "OK", json: () => new Promise(() => {}) }) as Response) as typeof fetch,
  }), /timed out after 30 seconds/);
});

const frozenBody = JSON.stringify({ from: RESEND_ONBOARDING_SENDER, to: [environment.NOTIFICATION_EMAIL], subject: content.subject, text: content.text, html: content.html });

test("frozen sender posts exact bytes and daily Idempotency-Key once", async () => {
  let calls = 0;
  let request: RequestInit | undefined;
  const outcome = await sendFrozenWithResend(frozenBody, "daily-digest/2026-11-04", {
    environment,
    fetchImplementation: (async (_url, init) => { calls++; request = init; return new Response(JSON.stringify({ id: "email_frozen" }), { status: 200 }); }) as typeof fetch,
  });
  assert.deepEqual(outcome, { kind: "accepted", id: "email_frozen" });
  assert.equal(calls, 1);
  assert.equal(request?.body, frozenBody);
  assert.equal((request?.headers as Record<string, string>)["Idempotency-Key"], "daily-digest/2026-11-04");
  assert.equal(request?.redirect, "manual");
});

for (const fixture of [
  { status: 400, name: "validation_error", rejection: "validation" },
  { status: 401, name: "invalid_api_key", rejection: "authentication" },
  { status: 403, name: "restricted_api_key", rejection: "permission" },
  { status: 429, name: "rate_limit_exceeded", rejection: "quota" },
] as const) test(`frozen sender classifies documented ${fixture.status} rejection`, async () => {
  const outcome = await sendFrozenWithResend(frozenBody, "daily-digest/2026-11-04", {
    environment, fetchImplementation: (async () => new Response(JSON.stringify({ name: fixture.name, message: "private provider text" }), { status: fixture.status })) as typeof fetch,
  });
  assert.deepEqual(outcome, { kind: "rejected", rejection: fixture.rejection });
  assert.equal(JSON.stringify(outcome).includes("private provider text"), false);
});

test("frozen sender keeps conflicts, timeout, transport and invalid responses bounded", async () => {
  const response = async (status: number, body: unknown) => sendFrozenWithResend(frozenBody, "daily-digest/2026-11-04", {
    environment, fetchImplementation: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
  });
  assert.deepEqual(await response(409, { name: "concurrent_idempotent_requests" }), { kind: "ambiguous", reason: "concurrent" });
  assert.deepEqual(await response(409, { name: "invalid_idempotent_request" }), { kind: "payload_conflict" });
  assert.deepEqual(await response(503, { message: "secret provider body" }), { kind: "ambiguous", reason: "http" });
  assert.deepEqual(await sendFrozenWithResend(frozenBody, "daily-digest/2026-11-04", {
    environment, fetchImplementation: (async () => { throw new Error("network private text"); }) as typeof fetch,
  }), { kind: "ambiguous", reason: "transport" });
  assert.deepEqual(await sendFrozenWithResend(frozenBody, "daily-digest/2026-11-04", {
    environment, timeoutMs: 1, fetchImplementation: (async () => new Promise<Response>(() => {})) as typeof fetch,
  }), { kind: "ambiguous", reason: "timeout" });
  assert.deepEqual(await response(200, {}), { kind: "ambiguous", reason: "invalid_response" });
});

test("frozen sender rejects invalid local inputs before fetch", async () => {
  let calls = 0;
  await assert.rejects(sendFrozenWithResend(frozenBody, "bad-key" as `daily-digest/${string}`, {
    environment, fetchImplementation: (async () => { calls++; return new Response(); }) as typeof fetch,
  }), (error: unknown) => error instanceof ResendPreDispatchError);
  assert.equal(calls, 0);
});
