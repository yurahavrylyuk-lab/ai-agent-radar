import type { DiscoveryEmailContent, EmailSendResult } from "../../types/index.js";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 30_000;
export const RESEND_ONBOARDING_SENDER = "AI Agent Radar <onboarding@resend.dev>";

interface ResendDependencies {
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

function required(name: "RESEND_API_KEY" | "NOTIFICATION_EMAIL", environment: NodeJS.ProcessEnv): string {
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

  try {
    response = await fetchImplementation(RESEND_EMAILS_URL, {
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
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Resend email request timed out after 30 seconds.");
    throw new Error(`Resend email request failed: ${safeMessage(error, secrets)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const message = await safeErrorMessage(response, secrets);
    throw new Error(`Resend email request failed: HTTP ${response.status} ${response.statusText}: ${message}`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Resend API returned invalid JSON.");
  }

  const emailId = data && typeof data === "object" ? (data as Record<string, unknown>).id : undefined;
  if (typeof emailId !== "string" || !emailId.trim()) {
    throw new Error("Resend API returned an unexpected success response.");
  }

  return { id: emailId };
}
