import { formatDiscoveryEmail } from "./discoveryEmailFormatter.js";
import { isNotificationEligible } from "./notificationEligibility.js";
import { JsonNotificationHistory, type NotificationHistory } from "./notificationHistory.js";
import { sendWithResend } from "../tools/email/resend.js";
import type { DiscoveryEmailContent, DiscoveryProcessingResult, EmailSendResult, NotificationRecord, NotificationResult, StoredDiscovery } from "../types/index.js";

type EligibilityCheck = (result: DiscoveryProcessingResult) => boolean;
type DiscoveryEmailFormatter = (discovery: StoredDiscovery) => DiscoveryEmailContent;
type EmailSender = (content: DiscoveryEmailContent) => Promise<EmailSendResult>;

export interface NotificationOrchestratorDependencies {
  history?: NotificationHistory;
  isEligible?: EligibilityCheck;
  formatEmail?: DiscoveryEmailFormatter;
  sendEmail?: EmailSender;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function notifyDiscovery(
  result: DiscoveryProcessingResult,
  dependencies: NotificationOrchestratorDependencies = {},
): Promise<NotificationResult> {
  const isEligible = dependencies.isEligible ?? isNotificationEligible;
  if (!isEligible(result)) return { status: "not_eligible" };

  const history = dependencies.history ?? new JsonNotificationHistory();
  const sourceUrl = result.discovery.analysis.sourceUrl;
  if (await history.hasNotificationBeenSent(sourceUrl, "email")) {
    const record = await history.getNotificationRecord(sourceUrl, "email");
    if (!record) throw new Error("Known notification could not be retrieved safely.");
    return { status: "already_sent", record };
  }

  const formatEmail = dependencies.formatEmail ?? formatDiscoveryEmail;
  const sendEmail = dependencies.sendEmail ?? sendWithResend;
  const emailResult = await sendEmail(formatEmail(result.discovery));

  let record: NotificationRecord;
  try {
    record = await history.recordNotificationSent(sourceUrl, "email", emailResult.id);
  } catch (error) {
    throw new Error(`Email was accepted, but notification delivery could not be persisted: ${messageOf(error)}`);
  }

  return { status: "sent", record };
}
