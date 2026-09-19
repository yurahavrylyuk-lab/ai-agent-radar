import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface UsageRecord {
  timestamp: string;
  provider: string;
  operation: string;
  requestCount: number;
}

interface UsageData {
  records: UsageRecord[];
}

export interface UsageTracker {
  getRecords(): Promise<UsageRecord[]>;
  recordRequest(record: UsageRecord): Promise<void>;
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.timestamp === "string" &&
    typeof record.provider === "string" &&
    typeof record.operation === "string" &&
    typeof record.requestCount === "number" &&
    Number.isInteger(record.requestCount) &&
    record.requestCount > 0
  );
}

export class JsonUsageTracker implements UsageTracker {
  private readonly filePath: string;

  constructor(filePath = resolve(process.cwd(), "data", "brave-usage.json")) {
    this.filePath = filePath;
  }

  async getRecords(): Promise<UsageRecord[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const data = JSON.parse(contents) as UsageData;

      if (!Array.isArray(data.records) || !data.records.every(isUsageRecord)) {
        throw new Error("Usage file has an invalid format.");
      }

      return data.records;
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }

      throw error;
    }
  }

  async recordRequest(record: UsageRecord): Promise<void> {
    const records = await this.getRecords();
    const data: UsageData = { records: [...records, record] };
    const temporaryPath = `${this.filePath}.tmp`;

    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
