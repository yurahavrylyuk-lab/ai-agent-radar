import { formatDiscoveryEmail, formatDigestEmail, formatBatchDigestEmail, formatDailyDigestEmail, type DigestEmailOptions } from "./discoveryEmailFormatter.js";
import { batchAliasKey, isBatchNewsUrl } from "./batchCandidates.js";
import { normalizeDiscoveryUrl } from "./discoveryHistoryCore.js";
import { compareDiscoveryPriority } from "./discoveryPriority.js";
import { isNotificationEligible } from "./notificationEligibility.js";
import { isTrustedFallbackSource } from "./sourceTrust.js";
import { NotificationHistoryError, type NotificationHistory } from "./notificationHistoryCore.js";
import { sendWithResend } from "../tools/email/resend.js";
import type { BatchCandidate, BatchDeliveryCandidate, DailyDigestInput, DailyDigestItem, DailyEmailContext, DailyEmailOutcome, DeliveryCandidate, DiscoveryEmailContent, DiscoveryProcessingResult, EmailSendResult, NotificationRecord, NotificationResult, PreparedDailyDigest, StoredDiscovery } from "../types/index.js";

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

function replayDeliveryEligible(candidate: BatchDeliveryCandidate): boolean {
  return candidate.origin !== "replay" || candidate.discovery.analysis.relevanceScore >= 7
    || candidate.discovery.batchSelectionProvenance?.kind === "batch";
}

type PreparedGroup = { item?: DailyDigestItem; index: number; aliases: Set<string> };

/** Selects one bounded daily payload without formatting, sending, or persistence. */
export async function prepareDailyDigest(input: DailyDigestInput, history: NotificationHistory): Promise<PreparedDailyDigest> {
  const status = (reason: DailyDigestInput["reason"]): PreparedDailyDigest => ({
    mode: "status_only", reason, cycleDate: input.cycleDate, items: [],
  });
  const makeGroups = (items: readonly DailyDigestItem[]): PreparedGroup[] => {
    const groups = new Map<string, PreparedGroup>();
    for (const [index, item] of items.entries()) {
      const url = item.kind === "raw" ? item.candidate.normalizedUrl : item.candidate.discovery.normalizedUrl;
      const key = batchAliasKey(url);
      const eligible = item.kind === "raw" ? true : replayDeliveryEligible(item.candidate);
      let group = groups.get(key);
      if (!group) {
        group = { item: eligible ? item : undefined, index, aliases: new Set() };
        groups.set(key, group);
      } else if (eligible && !group.item) {
        group.item = item;
        group.index = index;
      }
      const aliases = item.candidate.aliases;
      for (const alias of [url, ...aliases, ...(input.observedAliases.get(key) ?? [])]) {
        group.aliases.add(normalizeDiscoveryUrl(alias));
      }
    }
    return [...groups.values()];
  };
  const excludeNotified = async (groups: readonly PreparedGroup[]): Promise<PreparedGroup[]> => {
    const result: PreparedGroup[] = [];
    for (const group of groups) {
      let notified = false;
      for (const alias of group.aliases) {
        if (await history.hasNotificationBeenSent(alias, "email")) {
          const record = await history.getNotificationRecord(alias, "email");
          if (!record) throw new NotificationHistoryError("Known notification could not be retrieved safely.");
          notified = true;
        }
      }
      if (!notified && group.item) result.push(group);
    }
    return result;
  };

  const eligibleReplay = input.replay.filter(replayDeliveryEligible);
  let ordered: DailyDigestItem[];
  let mode: PreparedDailyDigest["mode"];
  if (input.fresh.length > 0) {
    ordered = [...input.fresh, ...eligibleReplay].map(candidate => ({ kind: "analyzed" as const, candidate }));
    mode = "normal";
  } else if (input.allowRawFallback && input.rawCandidates.length > 0) {
    ordered = [
      ...input.rawCandidates.map(candidate => ({ kind: "raw" as const, candidate })),
      ...eligibleReplay.map(candidate => ({ kind: "analyzed" as const, candidate })),
    ];
    mode = "degraded";
  } else {
    ordered = eligibleReplay.map(candidate => ({ kind: "analyzed" as const, candidate }));
    mode = ordered.length > 0 ? "normal" : "status_only";
  }
  if (mode === "status_only") return status(input.reason === "selected" ? "no_eligible_stories" : input.reason);
  try {
    const first = await excludeNotified(makeGroups(ordered));
    const second = await excludeNotified(first);
    const items = second.sort((left, right) => left.index - right.index).slice(0, 4).map(group => {
      const item = group.item!;
      const aliases = [...group.aliases];
      return item.kind === "raw"
        ? { kind: "raw" as const, candidate: { ...item.candidate, aliases } satisfies BatchCandidate }
        : { kind: "analyzed" as const, candidate: { ...item.candidate, aliases } satisfies BatchDeliveryCandidate };
    });
    return items.length > 0 ? { mode, reason: input.reason, cycleDate: input.cycleDate, items } : status("no_eligible_stories");
  } catch {
    return status("history_unavailable");
  }
}

export function createDailyEmailContext(): DailyEmailContext { return { emailAttempted: false }; }

/** Owns the single mail-transport attempt for one scheduled invocation. */
export async function finalizeDailyDigest(
  digest: PreparedDailyDigest,
  dependencies: { context: DailyEmailContext; history?: NotificationHistory; sendEmail: EmailSender; onAccepted?: () => void },
): Promise<DailyEmailOutcome> {
  if (dependencies.context.emailAttempted) {
    return { emailAttempts: 0, emailOutcome: "not_attempted", historyOutcome: "not_required", finalizationReached: true };
  }
  dependencies.context.emailAttempted = true;
  let content: DiscoveryEmailContent;
  try {
    content = formatDailyDigestEmail(digest);
  } catch {
    content = formatDailyDigestEmail({ mode: "status_only", reason: "preparation_unavailable", cycleDate: digest.cycleDate, items: [] });
  }
  let accepted: EmailSendResult;
  try {
    accepted = await dependencies.sendEmail(content);
  } catch {
    return { emailAttempts: 1, emailOutcome: "failed", historyOutcome: "not_required", finalizationReached: true };
  }
  dependencies.onAccepted?.();
  if (digest.items.length === 0) {
    return { emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "not_required", finalizationReached: true };
  }
  if (!dependencies.history) {
    return { emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "unavailable", finalizationReached: true };
  }
  try {
    for (const item of digest.items) {
      const aliases = item.candidate.aliases;
      for (const alias of new Set(aliases)) await dependencies.history.recordNotificationSent(alias, "email", accepted.id);
    }
    return { emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "recorded", finalizationReached: true };
  } catch {
    return { emailAttempts: 1, emailOutcome: "accepted", historyOutcome: "persistence_failed", finalizationReached: true };
  }
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
    ? unsentCandidates.filter((candidate) => candidate.discovery.sourceProvenance?.kind !== "x"
      && isTrustedFallbackSource(candidate.discovery.analysis.sourceUrl))
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

  const sentCandidates = await recordDigestDelivery(digest, history, emailResult, notificationMap);
  return {
    notifications: notificationMap,
    eligibleCandidates: [...eligibleCandidates],
    sentCandidates,
    mode: fallback ? "fallback" : "normal",
  };
}

async function recordDigestDelivery(
  digest: readonly DeliveryCandidate[],
  history: NotificationHistory,
  emailResult: EmailSendResult,
  notificationMap: Map<string, NotificationResult>,
): Promise<DeliveryCandidate[]> {
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

  return sentCandidates;
}

/** Delivery of an already-bounded, persisted fresh/replay Batch selection. */
export async function notifyBatchDeliveryDigest(
  candidates: readonly BatchDeliveryCandidate[],
  dependencies: NotificationOrchestratorDependencies & {
    /** Reports the exact externally accepted digest before notification-record writes. */
    onAccepted?: (candidates: readonly BatchDeliveryCandidate[]) => void;
  },
): Promise<DigestDeliveryResult> {
  const history = dependencies.history;
  if (!history) throw new Error("Notification history is required.");
  const notifications = new Map<string, NotificationResult>();
  type Group = { candidate?: BatchDeliveryCandidate; index: number; aliases: Set<string>; urls: Set<string> };
  type EligibleGroup = Group & { candidate: BatchDeliveryCandidate };
  const groups = new Map<string, Group>();
  for (const [index, candidate] of candidates.entries()) {
    const url = candidate.discovery.analysis.sourceUrl;
    notifications.set(url, { status: "not_eligible" });
    if (!isBatchNewsUrl(url)) continue;
    const deliveryEligible = replayDeliveryEligible(candidate);
    const key = batchAliasKey(candidate.discovery.normalizedUrl);
    let group = groups.get(key);
    if (!group) {
      group = { candidate: deliveryEligible ? candidate : undefined, index, aliases: new Set(), urls: new Set() };
      groups.set(key, group);
    } else if (deliveryEligible && (!group.candidate || (group.candidate.origin === "replay" && candidate.origin === "fresh"))) {
      group.candidate = candidate;
      group.index = index;
    }
    // Collect all evidence before choosing a representative, including aliases
    // contributed by duplicate candidates.
    group.urls.add(url);
    for (const alias of [url, candidate.discovery.normalizedUrl, ...candidate.aliases]) {
      group.aliases.add(normalizeDiscoveryUrl(alias));
    }
  }

  const excludeNotified = async (pool: EligibleGroup[]): Promise<EligibleGroup[]> => {
    const unsent: EligibleGroup[] = [];
    for (const group of pool) {
      let notification: NotificationRecord | undefined;
      try {
        for (const alias of group.aliases) {
          if (await history.hasNotificationBeenSent(alias, "email")) {
            const record = await history.getNotificationRecord(alias, "email");
            if (!record) throw new NotificationHistoryError("Known notification could not be retrieved safely.");
            notification ??= record;
          }
        }
      } catch (error) {
        if (error instanceof NotificationHistoryError) throw error;
        throw new NotificationHistoryError(`Notification history could not be read safely: ${messageOf(error)}`);
      }
      if (notification) {
        for (const url of group.urls) notifications.set(url, { status: "already_sent", record: notification });
      } else {
        unsent.push(group);
      }
    }
    return unsent;
  };

  const eligibleGroups = [...groups.values()].filter((group): group is EligibleGroup => group.candidate !== undefined);
  const initiallyUnsent = await excludeNotified(eligibleGroups);
  const ranked = initiallyUnsent.sort((left, right) => {
      const a = left.candidate;
      const b = right.candidate;
      if (a.origin !== b.origin) return a.origin === "fresh" ? -1 : 1;
      if (a.origin === "fresh") return left.index - right.index;
      return b.discovery.analysis.relevanceScore - a.discovery.analysis.relevanceScore
        || Date.parse(b.discovery.firstSeenAt) - Date.parse(a.discovery.firstSeenAt)
        || (a.discovery.normalizedUrl < b.discovery.normalizedUrl ? -1 : a.discovery.normalizedUrl > b.discovery.normalizedUrl ? 1 : 0);
    });
  // Recheck the full bounded eligible pool before the final cap so a newly
  // notified lead is replaced without scanning more history or re-analyzing.
  const eligibleCandidates = (await excludeNotified(ranked)).map(group => ({
    ...group.candidate, aliases: [...group.aliases],
  }));
  const digest = eligibleCandidates.slice(0, 4);
  if (digest.length === 0) return { notifications, eligibleCandidates, sentCandidates: [] };
  const sendEmail = dependencies.sendEmail ?? sendWithResend;
  const emailResult = await sendEmail(formatBatchDigestEmail(digest.map(candidate => candidate.discovery)));
  dependencies.onAccepted?.(digest);
  const sentCandidates = await recordDigestDelivery(digest, history, emailResult, notifications);
  return { notifications, eligibleCandidates, sentCandidates, mode: "normal" };
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
