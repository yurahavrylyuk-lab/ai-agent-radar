import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getGeminiUsageCounts, reachedGeminiBlockedReason } from "./geminiUsageGuard.js";
import { isGeminiTimestampInAnyActiveWindow } from "./geminiAccountingWindows.js";
import {
  geminiAccountingStatusOf,
  isGeminiUsageRecord,
  type GeminiAmbiguityReason,
  type GeminiAmbiguityRetirementExpectation,
  type GeminiAmbiguityRetirementResult,
  type GeminiUsageAdmission,
  type GeminiUsageData,
  type GeminiUsageRecord,
  type GeminiUsageReservation,
  type GeminiUsageSettlement,
  type GeminiUsageStore,
} from "./geminiUsageTracker.js";
import type { ApprovedGeminiModel } from "../config/geminiModels.js";

function copyRecord(record: GeminiUsageRecord): GeminiUsageRecord { return { ...record }; }

/** Local, atomic JSON implementation of the Gemini usage persistence boundary. */
export class LocalJsonGeminiUsageStore implements GeminiUsageStore {
  constructor(private readonly filePath = resolve(process.cwd(), "data", "gemini-usage.json")) {}

  async getUsageData(): Promise<GeminiUsageData> {
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!data || typeof data !== "object") throw new Error("Gemini usage file has an invalid format.");
      const value = data as Record<string, unknown>;
      if (!Array.isArray(value.records) || !value.records.every(isGeminiUsageRecord) || typeof value.usageUnknown !== "boolean") {
        throw new Error("Gemini usage file has an invalid format.");
      }
      const records = value.records.map(copyRecord);
      if (records.filter((record) => ["reserved", "transport_ambiguous"].includes(geminiAccountingStatusOf(record))).length > 1) {
        throw new Error("Gemini usage file contains conflicting unresolved reservations.");
      }
      return { records, usageUnknown: value.usageUnknown };
    } catch (error) {
      if (isMissingFileError(error)) return { records: [], usageUnknown: false };
      throw error;
    }
  }

  async recordRequest(record: GeminiUsageRecord): Promise<void> {
    if (!isGeminiUsageRecord(record) || geminiAccountingStatusOf(record) !== "legacy") {
      throw new Error("Gemini usage record has an invalid format.");
    }
    await this.withExclusiveMutation(async () => {
      const data = await this.getUsageData();
      await this.write({ ...data, records: [...data.records, copyRecord(record)] });
    });
  }

  async markUsageUnknown(): Promise<void> {
    await this.withExclusiveMutation(async () => {
      const data = await this.getUsageData();
      await this.write({ ...data, usageUnknown: true });
    });
  }

  async reserveRequest(
    record: GeminiUsageRecord & { model: ApprovedGeminiModel },
    admission: GeminiUsageAdmission,
  ): Promise<GeminiUsageReservation> {
    if (!isGeminiUsageRecord({ ...record, accountingStatus: "reserved" }) ||
      record.inputTokens !== 0 || record.outputTokens !== 0 || record.totalTokens !== 0 ||
      !Number.isSafeInteger(admission.cycleRequestsRemaining) || admission.cycleRequestsRemaining <= 0) {
      throw new Error("Gemini usage reservation has an invalid format.");
    }
    let reservation: GeminiUsageReservation | undefined;
    await this.withExclusiveMutation(async () => {
      const data = await this.getUsageData();
      if (data.usageUnknown) throw new Error("Gemini usage state is unavailable for reservation.");
      if (data.records.some((item) => ["reserved", "transport_ambiguous"].includes(geminiAccountingStatusOf(item)))) {
        throw new Error("Gemini usage reservation conflicts with an unresolved request.");
      }
      if (data.records.some((item) => geminiAccountingStatusOf(item) === "retired_outside_accounting_windows" &&
        isGeminiTimestampInAnyActiveWindow(item.timestamp, new Date(record.timestamp)))) {
        throw new Error("Gemini retired ambiguity is active after a clock rollback.");
      }
      const counts = getGeminiUsageCounts(data.records, new Date(record.timestamp));
      if (reachedGeminiBlockedReason(counts, admission.limits)) {
        throw new Error("Gemini usage reservation was blocked by an atomic limit check.");
      }
      const index = data.records.length;
      const nextId = data.records.reduce((maximum, item) => Math.max(maximum, item.id ?? 0), 0) + 1;
      const stored = { ...record, id: nextId, accountingStatus: "reserved" as const };
      reservation = { id: `local:${index}:${record.timestamp}`, record: copyRecord(stored) as GeminiUsageRecord & { model: ApprovedGeminiModel } };
      await this.write({ records: [...data.records, stored], usageUnknown: false });
    });
    if (!reservation) throw new Error("Gemini usage reservation outcome is uncertain; no dispatch is allowed.");
    return reservation;
  }

  async settleRequest(reservation: GeminiUsageReservation, usage: GeminiUsageSettlement): Promise<void> {
    const index = this.localReservationIndex(reservation);
    await this.withExclusiveMutation(async () => {
      const data = await this.getUsageData();
      const record = data.records[index];
      if (this.matchesReservationIdentity(record, reservation) && record.accountingStatus === "exact" && record.inputTokens === usage.inputTokens &&
        record.outputTokens === usage.outputTokens && record.totalTokens === usage.totalTokens) return;
      this.assertOwnedReserved(record, reservation);
      const settled = { ...record, ...usage, accountingStatus: "exact" as const, settledAt: new Date().toISOString() };
      if (!isGeminiUsageRecord(settled)) throw new Error("Gemini usage settlement has an invalid format.");
      await this.write({ ...data, records: data.records.map((item, itemIndex) => itemIndex === index ? settled : item) });
    });
  }

  async confirmZeroRequest(reservation: GeminiUsageReservation): Promise<void> {
    const index = this.localReservationIndex(reservation);
    await this.withExclusiveMutation(async () => {
      const data = await this.getUsageData();
      const record = data.records[index];
      if (this.matchesReservationIdentity(record, reservation) && record.accountingStatus === "confirmed_zero") return;
      this.assertOwnedReserved(record, reservation);
      const settled = { ...record, accountingStatus: "confirmed_zero" as const, settledAt: new Date().toISOString() };
      await this.write({ ...data, records: data.records.map((item, itemIndex) => itemIndex === index ? settled : item) });
    });
  }

  async markRequestAmbiguous(reservation: GeminiUsageReservation, reason: GeminiAmbiguityReason): Promise<void> {
    const index = this.localReservationIndex(reservation);
    await this.withExclusiveMutation(async () => {
      const data = await this.getUsageData();
      const record = data.records[index];
      if (this.matchesReservationIdentity(record, reservation) && record.accountingStatus === "transport_ambiguous" && record.ambiguityReason === reason) return;
      this.assertOwnedReserved(record, reservation);
      const ambiguous = { ...record, accountingStatus: "transport_ambiguous" as const, ambiguityReason: reason };
      await this.write({ ...data, records: data.records.map((item, itemIndex) => itemIndex === index ? ambiguous : item) });
    });
  }

  async retireAmbiguousRequest(expectation: GeminiAmbiguityRetirementExpectation): Promise<GeminiAmbiguityRetirementResult> {
    let result: GeminiAmbiguityRetirementResult | undefined;
    await this.withExclusiveMutation(async () => {
      const data = await this.getUsageData();
      if (data.usageUnknown) throw new Error("Gemini legacy usage state blocks structured retirement.");
      const index = data.records.findIndex((record) => record.id === expectation.id);
      const record = data.records[index];
      if (record?.accountingStatus === "retired_outside_accounting_windows" && this.matchesRetirement(record, expectation)) {
        result = "already_retired";
        return;
      }
      if (!record || record.accountingStatus !== "transport_ambiguous" || !this.matchesRetirement(record, expectation) ||
        record.inputTokens !== 0 || record.outputTokens !== 0 || record.totalTokens !== 0 ||
        isGeminiTimestampInAnyActiveWindow(record.timestamp, new Date())) {
        throw new Error("Gemini ambiguity retirement preconditions were not satisfied.");
      }
      const retired = { ...record, accountingStatus: "retired_outside_accounting_windows" as const, retiredAt: new Date().toISOString() };
      await this.write({ ...data, records: data.records.map((item, itemIndex) => itemIndex === index ? retired : item) });
      result = "retired";
    });
    if (!result) throw new Error("Gemini ambiguity retirement outcome is uncertain; authoritative reread is required.");
    return result;
  }

  private localReservationIndex(reservation: GeminiUsageReservation): number {
    const match = /^local:(\d+):(.+)$/.exec(reservation.id);
    if (!match || match[2] !== reservation.record.timestamp) throw new Error("Gemini usage reservation has an invalid identifier.");
    return Number(match[1]);
  }

  private assertOwnedReserved(record: GeminiUsageRecord | undefined, reservation: GeminiUsageReservation): asserts record is GeminiUsageRecord {
    if (!this.matchesReservationIdentity(record, reservation) || record.accountingStatus !== "reserved" ||
      record.inputTokens !== 0 || record.outputTokens !== 0 || record.totalTokens !== 0) {
      throw new Error("Gemini usage reservation could not be updated safely.");
    }
  }

  private matchesReservationIdentity(record: GeminiUsageRecord | undefined, reservation: GeminiUsageReservation): record is GeminiUsageRecord {
    return record !== undefined && record.id === reservation.record.id && record.timestamp === reservation.record.timestamp &&
      record.provider === reservation.record.provider && record.operation === reservation.record.operation &&
      record.requestCount === reservation.record.requestCount && record.model === reservation.record.model;
  }

  private matchesRetirement(record: GeminiUsageRecord, expectation: GeminiAmbiguityRetirementExpectation): boolean {
    return record.id === expectation.id && record.timestamp === expectation.timestamp && record.model === expectation.model &&
      record.ambiguityReason === expectation.ambiguityReason;
  }

  private async withExclusiveMutation<T>(callback: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    let lock: FileHandle | undefined;
    try {
      lock = await open(`${this.filePath}.reservation.lock`, "wx", 0o600);
      return await callback();
    } catch (error) {
      if (!lock) throw new Error("Gemini usage mutation could not acquire exclusive local admission.");
      throw error;
    } finally {
      if (lock) {
        await lock.close().catch(() => undefined);
        await unlink(`${this.filePath}.reservation.lock`).catch(() => undefined);
      }
    }
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
