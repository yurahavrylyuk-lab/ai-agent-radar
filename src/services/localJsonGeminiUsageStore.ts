import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  isGeminiUsageRecord,
  type GeminiUsageData,
  type GeminiUsageRecord,
  type GeminiUsageStore,
} from "./geminiUsageTracker.js";

function copyRecord(record: GeminiUsageRecord): GeminiUsageRecord {
  return { ...record };
}

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
