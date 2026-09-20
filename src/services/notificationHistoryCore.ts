import { type NotificationChannel, type NotificationRecord } from "../types/index.js";

export class NotificationHistoryError extends Error {}
export interface NotificationHistory {
  getNotificationRecord(url: string, channel: NotificationChannel): Promise<NotificationRecord | undefined>;
  hasNotificationBeenSent(url: string, channel: NotificationChannel): Promise<boolean>;
  recordNotificationSent(url: string, channel: NotificationChannel, providerMessageId?: string, sentAt?: Date): Promise<NotificationRecord>;
}
