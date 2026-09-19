import "dotenv/config";
import { formatDiscoveryEmail } from "./services/discoveryEmailFormatter.js";
import { sendWithResend } from "./tools/email/resend.js";
import type { StoredDiscovery } from "./types/index.js";

const testDiscovery: StoredDiscovery = {
  normalizedUrl: "https://example.com/ai-agent-radar-test",
  firstSeenAt: "2026-09-19T12:00:00.000Z",
  lastSeenAt: "2026-09-19T12:00:00.000Z",
  analysis: {
    name: "AI Agent Radar Email Test",
    category: "developer_tool",
    relevanceScore: 10,
    summary: "This is a controlled delivery test for the AI Agent Monitor notification system.",
    whyItMatters: "Successful delivery confirms that analyzed discoveries can be delivered to the configured inbox.",
    educationalValue: "Demonstrates the notification transport layer independently from search and AI analysis.",
    projectOpportunities: [
      "Connect eligible discoveries to email notifications",
      "Add delivery state and idempotency protection",
      "Schedule automated AI discovery reports",
    ],
    technologies: ["TypeScript", "Node.js", "Resend"],
    sourceTitle: "AI Agent Radar Test Source",
    sourceUrl: "https://example.com/ai-agent-radar-test",
  },
};

try {
  const result = await sendWithResend(formatDiscoveryEmail(testDiscovery));
  console.info(`[INFO] Resend accepted the controlled email. ID: ${result.id}`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[ERROR] Controlled email test failed: ${message}`);
  process.exitCode = 1;
}
