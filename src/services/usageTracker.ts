export interface UsageRecord {
  timestamp: string;
  provider: string;
  operation: string;
  requestCount: number;
}

/** Persistence boundary for Brave request-usage state. */
export interface BraveUsageStore {
  getRecords(): Promise<UsageRecord[]>;
  recordRequest(record: UsageRecord): Promise<void>;
}

/** @deprecated Use BraveUsageStore for new integrations. */
export type UsageTracker = BraveUsageStore;

export function isUsageRecord(value: unknown): value is UsageRecord {
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
