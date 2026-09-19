import assert from "node:assert/strict";
import test from "node:test";
import { RESEND_ONBOARDING_SENDER, sendWithResend } from "../src/tools/email/resend.js";
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
