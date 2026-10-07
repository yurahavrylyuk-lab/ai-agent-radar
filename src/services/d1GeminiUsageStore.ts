import {
  isGeminiUsageRecord,
  type GeminiUsageData,
  type GeminiUsageRecord,
  type GeminiUsageReservation,
  type GeminiUsageSettlement,
  type GeminiUsageStore,
} from "./geminiUsageTracker.js";
import type { ApprovedGeminiModel } from "../config/geminiModels.js";

interface GeminiUsageRow {
  timestamp: string;
  provider: string;
  operation: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  model: string | null;
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
    model: row.model,
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
        "SELECT timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model FROM gemini_usage ORDER BY id ASC",
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
      "INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).bind(
      record.timestamp,
      record.provider,
      record.operation,
      record.requestCount,
      record.inputTokens,
      record.outputTokens,
      record.totalTokens,
      record.model ?? null,
    ).run();
  }

  async markUsageUnknown(): Promise<void> {
    const result = await this.database.prepare(
      "UPDATE gemini_usage_state SET usage_unknown = 1 WHERE id = 1",
    ).run();
    if (result.meta.changes !== 1) throw new Error("D1 Gemini usage state could not be updated safely.");
  }

  async reserveRequest(record: GeminiUsageRecord & { model: ApprovedGeminiModel }): Promise<GeminiUsageReservation> {
    if (!isGeminiUsageRecord(record) || record.inputTokens !== 0 || record.outputTokens !== 0 || record.totalTokens !== 0) {
      throw new Error("Gemini usage reservation has an invalid format.");
    }
    const results = await this.database.batch([
      this.database.prepare(
        "UPDATE gemini_usage_state SET usage_unknown = 1 WHERE id = 1 AND usage_unknown = 0",
      ),
      this.database.prepare(
        "INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model) " +
        "SELECT ?1, ?2, ?3, ?4, 0, 0, 0, ?5 WHERE changes() = 1 RETURNING id",
      ).bind(record.timestamp, record.provider, record.operation, record.requestCount, record.model),
    ]);
    const id = (results[1]?.results?.[0] as { id?: unknown } | undefined)?.id;
    if (results[0]?.meta.changes !== 1 || !Number.isSafeInteger(id) || Number(id) <= 0) {
      throw new Error("Gemini usage reservation could not be acquired safely.");
    }
    return { id: `d1:${String(id)}`, record: { ...record } };
  }

  async settleRequest(reservation: GeminiUsageReservation, usage: GeminiUsageSettlement): Promise<void> {
    const match = /^d1:(\d+)$/.exec(reservation.id);
    if (!match || !isGeminiUsageRecord({ ...reservation.record, ...usage })) {
      throw new Error("Gemini usage settlement has an invalid format.");
    }
    const id = Number(match[1]);
    const results = await this.database.batch([
      this.database.prepare(
        "UPDATE gemini_usage SET input_tokens = ?1, output_tokens = ?2, total_tokens = ?3 " +
        "WHERE id = ?4 AND timestamp = ?5 AND model = ?6 AND input_tokens = 0 AND output_tokens = 0 AND total_tokens = 0",
      ).bind(usage.inputTokens, usage.outputTokens, usage.totalTokens, id, reservation.record.timestamp, reservation.record.model),
      this.database.prepare(
        "UPDATE gemini_usage_state SET usage_unknown = 0 WHERE id = 1 AND usage_unknown = 1 AND changes() = 1",
      ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new Error("Gemini usage reservation could not be settled safely.");
    }
  }
}
