import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isUsageRecord, type BraveUsageStore, type UsageRecord } from "./usageTracker.js";

interface UsageData {
  records: UsageRecord[];
}

/** Local, atomic JSON implementation of the Brave usage persistence boundary. */
export class LocalJsonBraveUsageStore implements BraveUsageStore {
  constructor(private readonly filePath = resolve(process.cwd(), "data", "brave-usage.json")) {}

  async getRecords(): Promise<UsageRecord[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const data = JSON.parse(contents) as UsageData;
      if (!Array.isArray(data.records) || !data.records.every(isUsageRecord)) {
        throw new Error("Usage file has an invalid format.");
      }
      return data.records.map((record) => ({ ...record }));
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  }

  async recordRequest(record: UsageRecord): Promise<void> {
    if (!isUsageRecord(record)) throw new Error("Usage record has an invalid format.");
    const records = await this.getRecords();
    await this.write({ records: [...records, { ...record }] });
  }

  private async write(data: UsageData): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
