import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  isGeminiUsageRecord,
  type GeminiUsageData,
  type GeminiUsageRecord,
  type GeminiUsageReservation,
  type GeminiUsageSettlement,
  type GeminiUsageStore,
} from "./geminiUsageTracker.js";
import type { ApprovedGeminiModel } from "../config/geminiModels.js";

function copyRecord(record: GeminiUsageRecord): GeminiUsageRecord {
  return { ...record };
}

/** Local, atomic JSON implementation of the Gemini usage persistence boundary. */
export class LocalJsonGeminiUsageStore implements GeminiUsageStore {
  private readonly reservationLocks = new Map<string, FileHandle>();

  constructor(private readonly filePath = resolve(process.cwd(), "data", "gemini-usage.json")) {}

  async getUsageData(): Promise<GeminiUsageData> {
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!data || typeof data !== "object") throw new Error("Gemini usage file has an invalid format.");
      const value = data as Record<string, unknown>;
      if (!Array.isArray(value.records) || !value.records.every(isGeminiUsageRecord) || typeof value.usageUnknown !== "boolean") {
        throw new Error("Gemini usage file has an invalid format.");
      }
      return { records: value.records.map(copyRecord), usageUnknown: value.usageUnknown };
    } catch (error) {
      if (isMissingFileError(error)) return { records: [], usageUnknown: false };
      throw error;
    }
  }

  async recordRequest(record: GeminiUsageRecord): Promise<void> {
    if (!isGeminiUsageRecord(record)) throw new Error("Gemini usage record has an invalid format.");
    const data = await this.getUsageData();
    await this.write({ ...data, records: [...data.records, copyRecord(record)] });
  }

  async markUsageUnknown(): Promise<void> {
    const data = await this.getUsageData();
    await this.write({ ...data, usageUnknown: true });
  }

  async reserveRequest(record: GeminiUsageRecord & { model: ApprovedGeminiModel }): Promise<GeminiUsageReservation> {
    if (!isGeminiUsageRecord(record) || record.inputTokens !== 0 || record.outputTokens !== 0 || record.totalTokens !== 0) {
      throw new Error("Gemini usage reservation has an invalid format.");
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const lock = await open(`${this.filePath}.reservation.lock`, "wx", 0o600).catch(() => {
      throw new Error("Gemini usage reservation could not acquire exclusive local admission.");
    });
    try {
      const data = await this.getUsageData();
      if (data.usageUnknown) throw new Error("Gemini usage state is unavailable for reservation.");
      const index = data.records.length;
      const reservation = { id: `local:${index}:${record.timestamp}`, record: copyRecord(record) as GeminiUsageRecord & { model: ApprovedGeminiModel } };
      await this.write({ records: [...data.records, copyRecord(record)], usageUnknown: true });
      this.reservationLocks.set(reservation.id, lock);
      return reservation;
    } catch (error) {
      await lock.close().catch(() => undefined);
      await unlink(`${this.filePath}.reservation.lock`).catch(() => undefined);
      throw error;
    }
  }

  async settleRequest(reservation: GeminiUsageReservation, usage: GeminiUsageSettlement): Promise<void> {
    const match = /^local:(\d+):(.+)$/.exec(reservation.id);
    if (!match || !isGeminiUsageRecord({ ...reservation.record, ...usage })) {
      throw new Error("Gemini usage settlement has an invalid format.");
    }
    const data = await this.getUsageData();
    const lock = this.reservationLocks.get(reservation.id);
    const index = Number(match[1]);
    const record = data.records[index];
    if (!lock || !data.usageUnknown || !record || match[2] !== reservation.record.timestamp ||
      record.timestamp !== reservation.record.timestamp || record.model !== reservation.record.model ||
      record.inputTokens !== 0 || record.outputTokens !== 0 || record.totalTokens !== 0) {
      throw new Error("Gemini usage reservation could not be settled safely.");
    }
    const records = data.records.map((item, itemIndex) => itemIndex === index ? { ...item, ...usage } : item);
    await this.write({ records, usageUnknown: false });
    await lock.close();
    await unlink(`${this.filePath}.reservation.lock`);
    this.reservationLocks.delete(reservation.id);
  }

  private async write(data: GeminiUsageData): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
