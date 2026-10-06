import { formatDiscoveryEmail, formatDigestEmail, type DigestEmailOptions } from "./discoveryEmailFormatter.js";
import { compareDiscoveryPriority } from "./discoveryPriority.js";
import { isNotificationEligible } from "./notificationEligibility.js";
import { isTrustedFallbackSource } from "./sourceTrust.js";
import { NotificationHistoryError, type NotificationHistory } from "./notificationHistoryCore.js";
import { sendWithResend } from "../tools/email/resend.js";
import type { DeliveryCandidate, DiscoveryEmailContent, DiscoveryProcessingResult, EmailSendResult, NotificationRecord, NotificationResult, StoredDiscovery } from "../types/index.js";

type EligibilityCheck = (result: DiscoveryProcessingResult) => boolean;
type DiscoveryEmailFormatter = (discovery: StoredDiscovery) => DiscoveryEmailContent;
type DigestEmailFormatter = (stories: StoredDiscovery[], options?: DigestEmailOptions) => DiscoveryEmailContent;
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

export interface DigestDeliveryResult {
  notifications: Map<string, NotificationResult>;
  eligibleCandidates: DeliveryCandidate[];
  sentCandidates: DeliveryCandidate[];
  mode?: DigestEmailOptions["mode"];
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
 * Sends one digest email containing up to four fresh or replay stories ranked
 * by the bounded P3 priority score and then by original relevance.
 *
 * Accepted trade-off (consistent with notifyDiscovery): the email is sent before
 * notification records are written. If persistence fails, affected stories remain
 * eligible on the next cycle. The try-all recording loop narrows the inconsistency
 * window by attempting every story before surfacing errors.
 */
export async function notifyDeliveryDigest(
  candidates: DeliveryCandidate[],
  dependencies: NotificationOrchestratorDependencies = {},
): Promise<DigestDeliveryResult> {
  const history = dependencies.history;
  if (!history) throw new Error("Notification history is required.");
  const isEligible = dependencies.isEligible ?? isNotificationEligible;

  const notificationMap = new Map<string, NotificationResult>();
  const dedupedByUrl = new Map<string, DeliveryCandidate>();
  for (const candidate of candidates) {
    const existing = dedupedByUrl.get(candidate.discovery.normalizedUrl);
    if (!existing || (existing.origin === "replay" && candidate.origin === "fresh")) {
      dedupedByUrl.set(candidate.discovery.normalizedUrl, candidate);
    }
  }
  const deduped = [...dedupedByUrl.values()];

  // Separate already-notified stories from unsent ones.
  const unsentCandidates: DeliveryCandidate[] = [];
  for (const candidate of deduped) {
    const url = candidate.discovery.analysis.sourceUrl;
    try {
      if (await history.hasNotificationBeenSent(url, "email")) {
        const record = await history.getNotificationRecord(url, "email");
        if (!record) throw new NotificationHistoryError("Known notification could not be retrieved safely.");
        notificationMap.set(url, { status: "already_sent", record });
      } else {
        unsentCandidates.push(candidate);
      }
    } catch (error) {
      if (error instanceof NotificationHistoryError) throw error;
      throw new NotificationHistoryError(`Notification history could not be read safely: ${messageOf(error)}`);
    }
  }

  if (unsentCandidates.length === 0) {
    return { notifications: notificationMap, eligibleCandidates: [], sentCandidates: [] };
  }

  // Default every unsent discovery to not eligible; selected digest stories are
  // replaced with sent records below.
  for (const candidate of unsentCandidates) {
    notificationMap.set(candidate.discovery.analysis.sourceUrl, { status: "not_eligible" });
  }

  const normalCandidates = unsentCandidates.filter((candidate) =>
    isEligible({ status: "new", discovery: candidate.discovery })
  );
  const fallback = normalCandidates.length === 0;
  const eligibleCandidates = fallback
    ? unsentCandidates.filter((candidate) => isTrustedFallbackSource(candidate.discovery.analysis.sourceUrl))
    : normalCandidates;

  if (eligibleCandidates.length === 0) {
    return { notifications: notificationMap, eligibleCandidates: [], sentCandidates: [] };
  }

  // Apply existing bounded P3 ordering, then cap either path at four stories.
  const digest = [...eligibleCandidates]
    .sort((a, b) => compareDiscoveryPriority(a.discovery, b.discovery))
    .slice(0, 4);

  // Format and send one digest email.
  const formatDigest = dependencies.formatDigest ?? formatDigestEmail;
  const sendEmail = dependencies.sendEmail ?? sendWithResend;
  const emailResult = await sendEmail(formatDigest(
    digest.map((candidate) => candidate.discovery),
    { mode: fallback ? "fallback" : "normal" },
  ));

  // Record a notification entry for every story in the digest.
  // Attempt all recordings before throwing so a single write failure does not
  // leave subsequent stories permanently unrecorded.
  const recordErrors: string[] = [];
  const sentCandidates: DeliveryCandidate[] = [];
  for (const candidate of digest) {
    const url = candidate.discovery.analysis.sourceUrl;
    try {
      const record = await history.recordNotificationSent(url, "email", emailResult.id);
      notificationMap.set(url, { status: "sent", record });
      sentCandidates.push(candidate);
    } catch (error) {
      recordErrors.push(messageOf(error));
    }
  }
  if (recordErrors.length > 0) {
    throw new Error(
      `Digest email was accepted, but ${recordErrors.length} notification record(s) could not be persisted: ${recordErrors.join("; ")}`,
    );
  }

  return {
    notifications: notificationMap,
    eligibleCandidates: [...eligibleCandidates],
    sentCandidates,
    mode: fallback ? "fallback" : "normal",
  };
}

export async function notifyDigest(
  results: DiscoveryProcessingResult[],
  dependencies: NotificationOrchestratorDependencies = {},
): Promise<Map<string, NotificationResult>> {
  const notificationMap = new Map<string, NotificationResult>();
  const candidates: DeliveryCandidate[] = [];
  for (const result of results) {
    if (result.status === "new") {
      candidates.push({ discovery: result.discovery, origin: "fresh" });
    } else {
      notificationMap.set(result.discovery.analysis.sourceUrl, { status: "not_eligible" });
    }
  }

  const delivery = await notifyDeliveryDigest(candidates, dependencies);
  for (const [url, notification] of delivery.notifications) notificationMap.set(url, notification);
  return notificationMap;
}
