import { isUsageRecord, type BraveUsageStore, type UsageRecord } from "./usageTracker.js";

interface BraveUsageRow {
  timestamp: string;
  provider: string;
  operation: string;
  request_count: number;
}

function recordFromRow(row: BraveUsageRow): UsageRecord {
  const record: UsageRecord = {
    timestamp: row.timestamp,
    provider: row.provider,
    operation: row.operation,
    requestCount: row.request_count,
  };
  if (!isUsageRecord(record)) throw new Error("D1 Brave usage contains an invalid record.");
  return record;
}

/** D1 implementation of the Brave request-usage persistence boundary. */
export class D1BraveUsageStore implements BraveUsageStore {
  constructor(private readonly database: D1Database) {}

  async getRecords(): Promise<UsageRecord[]> {
    const result = await this.database.prepare(
      "SELECT timestamp, provider, operation, request_count FROM brave_usage ORDER BY id ASC",
    ).all<BraveUsageRow>();
    return (result.results ?? []).map(recordFromRow).map((record) => ({ ...record }));
  }

  async recordRequest(record: UsageRecord): Promise<void> {
    if (!isUsageRecord(record)) throw new Error("Brave usage record has an invalid format.");
    await this.database.prepare(
      "INSERT INTO brave_usage (timestamp, provider, operation, request_count) VALUES (?1, ?2, ?3, ?4)",
    ).bind(record.timestamp, record.provider, record.operation, record.requestCount).run();
  }
}
