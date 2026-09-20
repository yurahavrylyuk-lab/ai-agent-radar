import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeDiscoveryUrl } from "./discoveryHistoryCore.js";
import { notificationChannels, type NotificationChannel, type NotificationRecord } from "../types/index.js";
import { NotificationHistoryError, type NotificationHistory } from "./notificationHistoryCore.js";
export { NotificationHistoryError, type NotificationHistory } from "./notificationHistoryCore.js";

interface NotificationHistoryData {
  records: NotificationRecord[];
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function validRecord(value: unknown): value is NotificationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.normalizedUrl !== "string" ||
    typeof record.channel !== "string" || !notificationChannels.includes(record.channel as NotificationChannel) ||
    !validTimestamp(record.sentAt) ||
    (record.providerMessageId !== undefined && (typeof record.providerMessageId !== "string" || !record.providerMessageId.trim()))) {
    return false;
  }

  try {
    return record.normalizedUrl === normalizeDiscoveryUrl(record.normalizedUrl);
  } catch {
    return false;
  }
}

function keyFor(record: Pick<NotificationRecord, "normalizedUrl" | "channel">): string {
  return `${record.normalizedUrl}\u0000${record.channel}`;
}

function validHistory(value: unknown): value is NotificationHistoryData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const records = (value as Record<string, unknown>).records;
  return Array.isArray(records) && records.every(validRecord) && new Set(records.map(keyFor)).size === records.length;
}

function copy(record: NotificationRecord): NotificationRecord {
  return { ...record };
}

export class JsonNotificationHistory implements NotificationHistory {
  constructor(private readonly filePath = resolve(process.cwd(), "data", "notification-history.json")) {}

  async listNotificationRecords(): Promise<NotificationRecord[]> {
    return (await this.read()).records.map(copy);
  }

  async getNotificationRecord(url: string, channel: NotificationChannel): Promise<NotificationRecord | undefined> {
    const normalizedUrl = normalizeDiscoveryUrl(url);
    this.requireChannel(channel);
    const record = (await this.read()).records.find((item) => item.normalizedUrl === normalizedUrl && item.channel === channel);
    return record ? copy(record) : undefined;
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
    this.requireChannel(channel);
    if (providerMessageId !== undefined && !providerMessageId.trim()) throw new NotificationHistoryError("Provider message ID must be a non-empty string when supplied.");
    if (Number.isNaN(sentAt.getTime())) throw new NotificationHistoryError("Notification timestamp is invalid.");

    const data = await this.read();
    const existing = data.records.find((item) => item.normalizedUrl === normalizedUrl && item.channel === channel);
    if (existing) return copy(existing);

    const record: NotificationRecord = { normalizedUrl, channel, sentAt: sentAt.toISOString(), ...(providerMessageId === undefined ? {} : { providerMessageId }) };
    await this.write({ records: [...data.records, record] });
    return copy(record);
  }

  private requireChannel(channel: NotificationChannel): void {
    if (!notificationChannels.includes(channel)) throw new NotificationHistoryError("Notification channel is not supported.");
  }

  private async read(): Promise<NotificationHistoryData> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!validHistory(value)) throw new NotificationHistoryError("Notification history file has an invalid format.");
      return value;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { records: [] };
      if (error instanceof SyntaxError) throw new NotificationHistoryError("Notification history file contains invalid JSON.");
      if (error instanceof NotificationHistoryError) throw error;
      throw new NotificationHistoryError("Notification history file could not be read safely.");
    }
  }

  private async write(data: NotificationHistoryData): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
