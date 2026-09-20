import {
  isGeminiUsageRecord,
  type GeminiUsageData,
  type GeminiUsageRecord,
  type GeminiUsageStore,
} from "./geminiUsageTracker.js";

interface GeminiUsageRow {
  timestamp: string;
  provider: string;
  operation: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface GeminiUsageStateRow {
  usage_unknown: number;
}

function recordFromRow(row: GeminiUsageRow): GeminiUsageRecord {
  const record: GeminiUsageRecord = {
    timestamp: row.timestamp,
    provider: row.provider as "gemini",
    operation: row.operation,
    requestCount: row.request_count as 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
  };
  if (!isGeminiUsageRecord(record)) throw new Error("D1 Gemini usage contains an invalid record.");
  return record;
}

/** D1 implementation of the Gemini request and token-usage persistence boundary. */
export class D1GeminiUsageStore implements GeminiUsageStore {
  constructor(private readonly database: D1Database) {}

  async getUsageData(): Promise<GeminiUsageData> {
    const [state, records] = await Promise.all([
      this.database.prepare("SELECT usage_unknown FROM gemini_usage_state WHERE id = 1").first<GeminiUsageStateRow>(),
      this.database.prepare(
        "SELECT timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens FROM gemini_usage ORDER BY id ASC",
      ).all<GeminiUsageRow>(),
    ]);
    if (!state || (state.usage_unknown !== 0 && state.usage_unknown !== 1)) {
      throw new Error("D1 Gemini usage state has an invalid format.");
    }
    return { records: (records.results ?? []).map(recordFromRow).map((record) => ({ ...record })), usageUnknown: state.usage_unknown === 1 };
  }

  async recordRequest(record: GeminiUsageRecord): Promise<void> {
    if (!isGeminiUsageRecord(record)) throw new Error("Gemini usage record has an invalid format.");
    await this.database.prepare(
      "INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(
      record.timestamp,
      record.provider,
      record.operation,
      record.requestCount,
      record.inputTokens,
      record.outputTokens,
      record.totalTokens,
    ).run();
  }

  async markUsageUnknown(): Promise<void> {
    const result = await this.database.prepare(
      "UPDATE gemini_usage_state SET usage_unknown = 1 WHERE id = 1",
    ).run();
    if (result.meta.changes !== 1) throw new Error("D1 Gemini usage state could not be updated safely.");
  }
}
