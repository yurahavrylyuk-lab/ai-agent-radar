import { type NotificationChannel, type NotificationRecord } from "../types/index.js";

export class NotificationHistoryError extends Error {}
export interface NotificationHistory {
  getNotificationRecord(url: string, channel: NotificationChannel): Promise<NotificationRecord | undefined>;
  /** Optional bounded bulk path; callers must fall back to point reads when absent. */
  getNotificationRecords?(urls: readonly string[], channel: NotificationChannel): Promise<Map<string, NotificationRecord>>;
  hasNotificationBeenSent(url: string, channel: NotificationChannel): Promise<boolean>;
  recordNotificationSent(url: string, channel: NotificationChannel, providerMessageId?: string, sentAt?: Date): Promise<NotificationRecord>;
}
