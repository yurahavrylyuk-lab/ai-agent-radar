import { formatDiscoveryEmail, formatDigestEmail } from "./discoveryEmailFormatter.js";
import { compareDiscoveryPriority } from "./discoveryPriority.js";
import { isNotificationEligible } from "./notificationEligibility.js";
import type { NotificationHistory } from "./notificationHistoryCore.js";
import { sendWithResend } from "../tools/email/resend.js";
import type { DiscoveryEmailContent, DiscoveryProcessingResult, EmailSendResult, NotificationRecord, NotificationResult, StoredDiscovery } from "../types/index.js";

type EligibilityCheck = (result: DiscoveryProcessingResult) => boolean;
type DiscoveryEmailFormatter = (discovery: StoredDiscovery) => DiscoveryEmailContent;
type DigestEmailFormatter = (stories: StoredDiscovery[]) => DiscoveryEmailContent;
type EmailSender = (content: DiscoveryEmailContent) => Promise<EmailSendResult>;

export interface NotificationOrchestratorDependencies {
  history?: NotificationHistory;
  isEligible?: EligibilityCheck;
  /** Used by notifyDiscovery for a single-story email. */
  formatEmail?: DiscoveryEmailFormatter;
  /** Used by notifyDigest for a multi-story digest email. */
  formatDigest?: DigestEmailFormatter;
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

  const history = dependencies.history;
  if (!history) throw new Error("Notification history is required.");
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

/**
 * Sends one digest email containing up to four eligible stories ranked by the
 * bounded P3 priority score and then by original relevance.
 * Returns a map of sourceUrl → NotificationResult for every result in the input.
 *
 * Accepted trade-off (consistent with notifyDiscovery): the email is sent before
 * notification records are written. If persistence fails, affected stories remain
 * eligible on the next cycle. The try-all recording loop narrows the inconsistency
 * window by attempting every story before surfacing errors.
 */
export async function notifyDigest(
  results: DiscoveryProcessingResult[],
  dependencies: NotificationOrchestratorDependencies = {},
): Promise<Map<string, NotificationResult>> {
  const history = dependencies.history;
  if (!history) throw new Error("Notification history is required.");
  const isEligible = dependencies.isEligible ?? isNotificationEligible;

  const notificationMap = new Map<string, NotificationResult>();

  // Partition into eligible and ineligible.
  const eligibleResults: DiscoveryProcessingResult[] = [];
  for (const result of results) {
    if (!isEligible(result)) {
      notificationMap.set(result.discovery.analysis.sourceUrl, { status: "not_eligible" });
    } else {
      eligibleResults.push(result);
    }
  }

  if (eligibleResults.length === 0) return notificationMap;

  // Deduplicate eligible stories by source URL (first occurrence wins).
  const seenUrls = new Set<string>();
  const deduped: DiscoveryProcessingResult[] = [];
  for (const result of eligibleResults) {
    const url = result.discovery.analysis.sourceUrl;
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      deduped.push(result);
    }
  }

  // Separate already-notified stories from unsent ones.
  const unsentResults: DiscoveryProcessingResult[] = [];
  for (const result of deduped) {
    const url = result.discovery.analysis.sourceUrl;
    if (await history.hasNotificationBeenSent(url, "email")) {
      const record = await history.getNotificationRecord(url, "email");
      if (!record) throw new Error("Known notification could not be retrieved safely.");
      notificationMap.set(url, { status: "already_sent", record });
    } else {
      unsentResults.push(result);
    }
  }

  if (unsentResults.length === 0) return notificationMap;

  // Apply bounded post-eligibility priority, then cap at four stories.
  const digest = [...unsentResults]
    .sort((a, b) => compareDiscoveryPriority(a.discovery, b.discovery))
    .slice(0, 4);

  // Format and send one digest email.
  const formatDigest = dependencies.formatDigest ?? formatDigestEmail;
  const sendEmail = dependencies.sendEmail ?? sendWithResend;
  const emailResult = await sendEmail(formatDigest(digest.map((r) => r.discovery)));

  // Record a notification entry for every story in the digest.
  // Attempt all recordings before throwing so a single write failure does not
  // leave subsequent stories permanently unrecorded.
  const recordErrors: string[] = [];
  for (const result of digest) {
    const url = result.discovery.analysis.sourceUrl;
    try {
      const record = await history.recordNotificationSent(url, "email", emailResult.id);
      notificationMap.set(url, { status: "sent", record });
    } catch (error) {
      recordErrors.push(messageOf(error));
    }
  }
  if (recordErrors.length > 0) {
    throw new Error(
      `Digest email was accepted, but ${recordErrors.length} notification record(s) could not be persisted: ${recordErrors.join("; ")}`,
    );
  }

  return notificationMap;
}
