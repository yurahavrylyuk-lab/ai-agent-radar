import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface OpenAIUsageRecord {
  timestamp: string;
  provider: "openai";
  operation: string;
  requestCount: 1;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface OpenAIUsageData {
  records: OpenAIUsageRecord[];
  usageUnknown: boolean;
}

export interface OpenAIUsageTracker {
  getUsageData(): Promise<OpenAIUsageData>;
  recordRequest(record: OpenAIUsageRecord): Promise<void>;
  markUsageUnknown(): Promise<void>;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOpenAIUsageRecord(value: unknown): value is OpenAIUsageRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.timestamp === "string" &&
    record.provider === "openai" &&
    typeof record.operation === "string" &&
    record.requestCount === 1 &&
    isNonNegativeInteger(record.inputTokens) &&
    isNonNegativeInteger(record.outputTokens) &&
    isNonNegativeInteger(record.totalTokens) &&
    record.totalTokens === record.inputTokens + record.outputTokens
  );
}

function isUsageData(value: unknown): value is OpenAIUsageData {
  if (!value || typeof value !== "object") {
    return false;
  }

  const data = value as Record<string, unknown>;
  return Array.isArray(data.records) && data.records.every(isOpenAIUsageRecord) && typeof data.usageUnknown === "boolean";
}

export class JsonOpenAIUsageTracker implements OpenAIUsageTracker {
  private readonly filePath: string;

  constructor(filePath = resolve(process.cwd(), "data", "openai-usage.json")) {
    this.filePath = filePath;
  }

  async getUsageData(): Promise<OpenAIUsageData> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const data = JSON.parse(contents) as unknown;

      if (!isUsageData(data)) {
        throw new Error("OpenAI usage file has an invalid format.");
      }

      return data;
    } catch (error) {
      if (isMissingFileError(error)) {
        return { records: [], usageUnknown: false };
      }

      throw error;
    }
  }

  async recordRequest(record: OpenAIUsageRecord): Promise<void> {
    const data = await this.getUsageData();
    await this.writeUsageData({ ...data, records: [...data.records, record] });
  }

  async markUsageUnknown(): Promise<void> {
    const data = await this.getUsageData();
    await this.writeUsageData({ ...data, usageUnknown: true });
  }

  private async writeUsageData(data: OpenAIUsageData): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
