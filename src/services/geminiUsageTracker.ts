import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface GeminiUsageRecord {
  timestamp: string;
  provider: "gemini";
  operation: string;
  requestCount: 1;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GeminiUsageData { records: GeminiUsageRecord[]; usageUnknown: boolean; }
export interface GeminiUsageTracker {
  getUsageData(): Promise<GeminiUsageData>;
  recordRequest(record: GeminiUsageRecord): Promise<void>;
  markUsageUnknown(): Promise<void>;
}

function validRecord(value: unknown): value is GeminiUsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.timestamp === "string" && record.provider === "gemini" && typeof record.operation === "string" && record.requestCount === 1 &&
    [record.inputTokens, record.outputTokens, record.totalTokens].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0) &&
    (record.totalTokens as number) >= (record.inputTokens as number) + (record.outputTokens as number);
}

export class JsonGeminiUsageTracker implements GeminiUsageTracker {
  constructor(private readonly filePath = resolve(process.cwd(), "data", "gemini-usage.json")) {}

  async getUsageData(): Promise<GeminiUsageData> {
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!data || typeof data !== "object") throw new Error("Gemini usage file has an invalid format.");
      const value = data as Record<string, unknown>;
      if (!Array.isArray(value.records) || !value.records.every(validRecord) || typeof value.usageUnknown !== "boolean") throw new Error("Gemini usage file has an invalid format.");
      return { records: value.records, usageUnknown: value.usageUnknown };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { records: [], usageUnknown: false };
      throw error;
    }
  }

  async recordRequest(record: GeminiUsageRecord): Promise<void> {
    const data = await this.getUsageData();
    await this.write({ ...data, records: [...data.records, record] });
  }
  async markUsageUnknown(): Promise<void> { await this.write({ ...(await this.getUsageData()), usageUnknown: true }); }
  private async write(data: GeminiUsageData): Promise<void> {
    const temp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temp, this.filePath);
  }
}
