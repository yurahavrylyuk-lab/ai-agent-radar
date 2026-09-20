import { normalizeDiscoveryUrl } from "./discoveryHistory.js";
import { NotificationHistoryError, type NotificationHistory } from "./notificationHistory.js";
import { notificationChannels, type NotificationChannel, type NotificationRecord } from "../types/index.js";

interface NotificationRow {
  normalized_url: string;
  channel: string;
  sent_at: string;
  provider_message_id: string | null;
}

function isTimestamp(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function requireChannel(channel: NotificationChannel): void {
  if (!notificationChannels.includes(channel)) throw new NotificationHistoryError("Notification channel is not supported.");
}

function recordFromRow(row: NotificationRow): NotificationRecord {
  if (!notificationChannels.includes(row.channel as NotificationChannel) || !isTimestamp(row.sent_at)) {
    throw new NotificationHistoryError("D1 notification history contains an invalid record.");
  }
  if (row.provider_message_id !== null && !row.provider_message_id.trim()) {
    throw new NotificationHistoryError("D1 notification history contains an invalid record.");
  }

  try {
    if (row.normalized_url !== normalizeDiscoveryUrl(row.normalized_url)) {
      throw new NotificationHistoryError("D1 notification history contains an invalid record.");
    }
  } catch (error) {
    if (error instanceof NotificationHistoryError) throw error;
    throw new NotificationHistoryError("D1 notification history contains an invalid record.");
  }

  return {
    normalizedUrl: row.normalized_url,
    channel: row.channel as NotificationChannel,
    sentAt: row.sent_at,
    ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
  };
}

/** D1 implementation of the notification-history persistence boundary. */
export class D1NotificationHistory implements NotificationHistory {
  constructor(private readonly database: D1Database) {}

  async listNotificationRecords(): Promise<NotificationRecord[]> {
    try {
      const result = await this.database.prepare(
        "SELECT normalized_url, channel, sent_at, provider_message_id FROM notifications ORDER BY sent_at ASC",
      ).all<NotificationRow>();
      return (result.results ?? []).map(recordFromRow).map((record) => ({ ...record }));
    } catch (error) {
      if (error instanceof NotificationHistoryError) throw error;
      throw new NotificationHistoryError("D1 notification history could not be read safely.");
    }
  }

  async getNotificationRecord(url: string, channel: NotificationChannel): Promise<NotificationRecord | undefined> {
    const normalizedUrl = normalizeDiscoveryUrl(url);
    requireChannel(channel);
    try {
      const row = await this.database.prepare(
        "SELECT normalized_url, channel, sent_at, provider_message_id FROM notifications WHERE normalized_url = ?1 AND channel = ?2",
      ).bind(normalizedUrl, channel).first<NotificationRow>();
      return row ? { ...recordFromRow(row) } : undefined;
    } catch (error) {
      if (error instanceof NotificationHistoryError) throw error;
      throw new NotificationHistoryError("D1 notification history could not be read safely.");
    }
  }

  async hasNotificationBeenSent(url: string, channel: NotificationChannel): Promise<boolean> {
    return (await this.getNotificationRecord(url, channel)) !== undefined;
  }

  async recordNotificationSent(
    url: string,
    channel: NotificationChannel,
    providerMessageId?: string,
    sentAt = new Date(),
  ): Promise<NotificationRecord> {
    const normalizedUrl = normalizeDiscoveryUrl(url);
    requireChannel(channel);
    if (providerMessageId !== undefined && !providerMessageId.trim()) {
      throw new NotificationHistoryError("Provider message ID must be a non-empty string when supplied.");
    }
    if (Number.isNaN(sentAt.getTime())) throw new NotificationHistoryError("Notification timestamp is invalid.");

    try {
      await this.database.prepare(
        "INSERT OR IGNORE INTO notifications (normalized_url, channel, sent_at, provider_message_id) VALUES (?1, ?2, ?3, ?4)",
      ).bind(normalizedUrl, channel, sentAt.toISOString(), providerMessageId ?? null).run();
      const record = await this.getNotificationRecord(normalizedUrl, channel);
      if (!record) throw new NotificationHistoryError("Recorded D1 notification could not be retrieved safely.");
      return record;
    } catch (error) {
      if (error instanceof NotificationHistoryError) throw error;
      throw new NotificationHistoryError("D1 notification history could not be written safely.");
    }
  }
}
