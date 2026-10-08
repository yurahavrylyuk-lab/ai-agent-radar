import {
  geminiAccountingStatusOf,
  isGeminiUsageRecord,
  type GeminiAmbiguityReason,
  type GeminiAmbiguityRetirementExpectation,
  type GeminiAmbiguityRetirementResult,
  type GeminiReservedReconciliationExpectation,
  type GeminiReservedReconciliationResult,
  type GeminiUsageAdmission,
  type GeminiUsageData,
  type GeminiUsageRecord,
  type GeminiUsageReservation,
  type GeminiUsageSettlement,
  type GeminiUsageStore,
} from "./geminiUsageTracker.js";
import type { ApprovedGeminiModel } from "../config/geminiModels.js";

interface GeminiUsageRow {
  id: number;
  timestamp: string;
  provider: string;
  operation: string;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  model: string | null;
  accounting_status: GeminiUsageRecord["accountingStatus"];
  ambiguity_reason: GeminiUsageRecord["ambiguityReason"];
  accounting_through: string | null;
  settled_at: string | null;
  retired_at: string | null;
}

interface GeminiUsageStateRow { usage_unknown: number; }

const SELECT_COLUMNS = "id, timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, ambiguity_reason, accounting_through, settled_at, retired_at";

function recordFromRow(row: GeminiUsageRow): GeminiUsageRecord {
  const record: GeminiUsageRecord = {
    id: row.id,
    timestamp: row.timestamp,
    provider: row.provider as "gemini",
    operation: row.operation,
    requestCount: row.request_count as 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    model: row.model,
    accountingStatus: row.accounting_status,
    ambiguityReason: row.ambiguity_reason,
    accountingThrough: row.accounting_through,
    settledAt: row.settled_at,
    retiredAt: row.retired_at,
  };
  if (!isGeminiUsageRecord(record)) throw new Error("D1 Gemini usage contains an invalid record.");
  return record;
}

function reservationId(id: string): number {
  const match = /^d1:(\d+)$/.exec(id);
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Gemini usage reservation has an invalid identifier.");
  return value;
}

function matchesReservationIdentity(record: GeminiUsageRecord | null, reservation: GeminiUsageReservation): record is GeminiUsageRecord {
  return record !== null && record.id === reservation.record.id && record.timestamp === reservation.record.timestamp &&
    record.provider === reservation.record.provider && record.operation === reservation.record.operation &&
    record.requestCount === reservation.record.requestCount && record.model === reservation.record.model;
}

/** D1 implementation of the Gemini request and token-usage persistence boundary. */
export class D1GeminiUsageStore implements GeminiUsageStore {
  constructor(private readonly database: D1Database) {}

  async getUsageData(): Promise<GeminiUsageData> {
    const [state, records] = await Promise.all([
      this.database.prepare("SELECT usage_unknown FROM gemini_usage_state WHERE id = 1").first<GeminiUsageStateRow>(),
      this.database.prepare(`SELECT ${SELECT_COLUMNS} FROM gemini_usage ORDER BY id ASC`).all<GeminiUsageRow>(),
    ]);
    if (!state || (state.usage_unknown !== 0 && state.usage_unknown !== 1)) {
      throw new Error("D1 Gemini usage state has an invalid format.");
    }
    const parsed = (records.results ?? []).map(recordFromRow);
    const unresolved = parsed.filter((record) => ["reserved", "transport_ambiguous"].includes(geminiAccountingStatusOf(record)));
    if (unresolved.length > 1) throw new Error("D1 Gemini usage contains conflicting unresolved reservations.");
    return { records: parsed.map((record) => ({ ...record })), usageUnknown: state.usage_unknown === 1 };
  }

  async recordRequest(record: GeminiUsageRecord): Promise<void> {
    if (!isGeminiUsageRecord(record) || geminiAccountingStatusOf(record) !== "legacy") {
      throw new Error("Gemini usage record has an invalid format.");
    }
    await this.database.prepare(
      "INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, ambiguity_reason, accounting_through, settled_at, retired_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
    ).bind(
      record.timestamp, record.provider, record.operation, record.requestCount,
      record.inputTokens, record.outputTokens, record.totalTokens, record.model ?? null,
      geminiAccountingStatusOf(record), record.ambiguityReason ?? null,
      record.accountingThrough ?? record.timestamp, record.settledAt ?? null, record.retiredAt ?? null,
    ).run();
  }

  async markUsageUnknown(): Promise<void> {
    const result = await this.database.prepare("UPDATE gemini_usage_state SET usage_unknown = 1 WHERE id = 1").run();
    if (result.meta.changes !== 1) throw new Error("D1 Gemini usage state could not be updated safely.");
  }

  async reserveRequest(
    record: GeminiUsageRecord & { model: ApprovedGeminiModel },
    admission: GeminiUsageAdmission,
  ): Promise<GeminiUsageReservation> {
    if (!isGeminiUsageRecord({ ...record, accountingStatus: "reserved", accountingThrough: record.timestamp }) ||
      record.inputTokens !== 0 || record.outputTokens !== 0 || record.totalTokens !== 0 ||
      !Number.isSafeInteger(admission.cycleRequestsRemaining) || admission.cycleRequestsRemaining <= 0) {
      throw new Error("Gemini usage reservation has an invalid format.");
    }
    const databaseNow = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    const dayStart = "strftime('%Y-%m-%dT00:00:00.000Z', 'now')";
    const weekStart = "strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-' || ((CAST(strftime('%w', 'now') AS INTEGER) + 6) % 7) || ' days')";
    const monthStart = "strftime('%Y-%m-01T00:00:00.000Z', 'now')";
    const nextDay = "strftime('%Y-%m-%dT00:00:00.000Z', 'now', '+1 day')";
    const nextWeek = "strftime('%Y-%m-%dT00:00:00.000Z', 'now', '+' || (7 - ((CAST(strftime('%w', 'now') AS INTEGER) + 6) % 7)) || ' days')";
    const nextMonth = "strftime('%Y-%m-01T00:00:00.000Z', 'now', '+1 month')";
    const sql =
      "INSERT INTO gemini_usage (timestamp, provider, operation, request_count, input_tokens, output_tokens, total_tokens, model, accounting_status, accounting_through) " +
      `SELECT ${databaseNow}, ?1, ?2, 1, 0, 0, 0, ?3, 'reserved', ${databaseNow} ` +
      "WHERE ?4 > 0 " +
      "AND EXISTS (SELECT 1 FROM gemini_usage_state WHERE id = 1 AND usage_unknown = 0) " +
      "AND NOT EXISTS (SELECT 1 FROM gemini_usage WHERE accounting_status IN ('reserved', 'transport_ambiguous')) " +
      "AND NOT EXISTS (SELECT 1 FROM gemini_usage WHERE strftime('%s', timestamp) IS NULL " +
        "OR (settled_at IS NOT NULL AND (strftime('%s', settled_at) IS NULL OR settled_at < timestamp)) " +
        "OR (retired_at IS NOT NULL AND (strftime('%s', retired_at) IS NULL OR retired_at < timestamp))) " +
      `AND NOT EXISTS (SELECT 1 FROM gemini_usage WHERE timestamp > ${databaseNow}) ` +
      "AND NOT EXISTS (SELECT 1 FROM gemini_usage WHERE accounting_status = 'retired_outside_accounting_windows' " +
        `AND (accounting_through >= ${dayStart} OR accounting_through >= ${weekStart} OR accounting_through >= ${monthStart})) ` +
      `AND (SELECT COALESCE(SUM(request_count), 0) FROM gemini_usage WHERE timestamp < ${nextDay} AND COALESCE(accounting_through, timestamp) >= ${dayStart}) < ?5 ` +
      `AND (SELECT COALESCE(SUM(request_count), 0) FROM gemini_usage WHERE timestamp < ${nextWeek} AND COALESCE(accounting_through, timestamp) >= ${weekStart}) < ?6 ` +
      `AND (SELECT COALESCE(SUM(request_count), 0) FROM gemini_usage WHERE timestamp < ${nextMonth} AND COALESCE(accounting_through, timestamp) >= ${monthStart}) < ?7 ` +
      `AND (SELECT COALESCE(SUM(total_tokens), 0) FROM gemini_usage WHERE timestamp < ${nextDay} AND COALESCE(accounting_through, timestamp) >= ${dayStart}) < ?8 ` +
      `AND (SELECT COALESCE(SUM(total_tokens), 0) FROM gemini_usage WHERE timestamp < ${nextWeek} AND COALESCE(accounting_through, timestamp) >= ${weekStart}) < ?9 ` +
      `AND (SELECT COALESCE(SUM(total_tokens), 0) FROM gemini_usage WHERE timestamp < ${nextMonth} AND COALESCE(accounting_through, timestamp) >= ${monthStart}) < ?10 ` +
      "RETURNING id, timestamp";
    const statement = this.database.prepare(sql).bind(
      record.provider, record.operation, record.model, admission.cycleRequestsRemaining,
      admission.limits.dailyRequests, admission.limits.weeklyRequests, admission.limits.monthlyRequests,
      admission.limits.dailyTokens, admission.limits.weeklyTokens, admission.limits.monthlyTokens,
    );
    let inserted: { id: number; timestamp: string } | null;
    try {
      inserted = await statement.first<{ id: number; timestamp: string }>();
    } catch (error) {
      const unresolved = await this.findUnresolved().catch(() => null);
      if (unresolved && unresolved.model === record.model && unresolved.operation === record.operation) {
        throw new Error("Gemini usage reservation outcome is uncertain; the durable reservation was retained and must not be dispatched.");
      }
      throw error;
    }
    if (!inserted || !Number.isSafeInteger(inserted.id) || inserted.id <= 0 || !inserted.timestamp) {
      throw new Error("Gemini usage reservation could not be admitted safely.");
    }
    return { id: `d1:${inserted.id}`, record: { ...record, id: inserted.id, timestamp: inserted.timestamp, accountingThrough: inserted.timestamp, accountingStatus: "reserved" } };
  }

  async settleRequest(reservation: GeminiUsageReservation, usage: GeminiUsageSettlement): Promise<void> {
    const validationSettledAt = new Date(Math.max(Date.now(), new Date(reservation.record.timestamp).getTime())).toISOString();
    if (!isGeminiUsageRecord({ ...reservation.record, ...usage, accountingStatus: "exact",
      settledAt: validationSettledAt, accountingThrough: validationSettledAt })) {
      throw new Error("Gemini usage settlement has an invalid format.");
    }
    const id = reservationId(reservation.id);
    const row = await this.database.prepare(
      "UPDATE gemini_usage SET input_tokens = ?1, output_tokens = ?2, total_tokens = ?3, accounting_status = 'exact', " +
      "settled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), accounting_through = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
      "WHERE id = ?4 AND timestamp = ?5 AND provider = ?6 AND operation = ?7 AND request_count = ?8 AND model = ?9 AND accounting_status = 'reserved' " +
      "AND input_tokens = 0 AND output_tokens = 0 AND total_tokens = 0 RETURNING id",
    ).bind(
      usage.inputTokens, usage.outputTokens, usage.totalTokens, id, reservation.record.timestamp,
      reservation.record.provider, reservation.record.operation, reservation.record.requestCount, reservation.record.model,
    )
      .first<{ id: number }>().catch(() => null);
    if (row?.id === id) return;
    const authoritative = await this.getRecord(id);
    if (matchesReservationIdentity(authoritative, reservation) && authoritative.accountingStatus === "exact" && authoritative.inputTokens === usage.inputTokens &&
      authoritative.outputTokens === usage.outputTokens && authoritative.totalTokens === usage.totalTokens) return;
    throw new Error("Gemini usage reservation could not be settled safely.");
  }

  async confirmZeroRequest(reservation: GeminiUsageReservation): Promise<void> {
    const id = reservationId(reservation.id);
    const row = await this.database.prepare(
      "UPDATE gemini_usage SET accounting_status = 'confirmed_zero', settled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), " +
      "accounting_through = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
      "WHERE id = ?1 AND timestamp = ?2 AND provider = ?3 AND operation = ?4 AND request_count = ?5 AND model = ?6 AND accounting_status = 'reserved' " +
      "AND input_tokens = 0 AND output_tokens = 0 AND total_tokens = 0 RETURNING id",
    ).bind(
      id, reservation.record.timestamp, reservation.record.provider, reservation.record.operation,
      reservation.record.requestCount, reservation.record.model,
    )
      .first<{ id: number }>().catch(() => null);
    if (row?.id === id) return;
    const authoritative = await this.getRecord(id);
    if (matchesReservationIdentity(authoritative, reservation) && authoritative.accountingStatus === "confirmed_zero" &&
      authoritative.inputTokens === 0 && authoritative.outputTokens === 0 && authoritative.totalTokens === 0) return;
    throw new Error("Gemini zero-usage response could not be recorded safely.");
  }

  async markRequestAmbiguous(reservation: GeminiUsageReservation, reason: GeminiAmbiguityReason): Promise<void> {
    const id = reservationId(reservation.id);
    const row = await this.database.prepare(
      "UPDATE gemini_usage SET accounting_status = 'transport_ambiguous', ambiguity_reason = ?1, " +
      "accounting_through = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
      "WHERE id = ?2 AND timestamp = ?3 AND provider = ?4 AND operation = ?5 AND request_count = ?6 AND model = ?7 AND accounting_status = 'reserved' " +
      "AND input_tokens = 0 AND output_tokens = 0 AND total_tokens = 0 RETURNING id",
    ).bind(
      reason, id, reservation.record.timestamp, reservation.record.provider, reservation.record.operation,
      reservation.record.requestCount, reservation.record.model,
    )
      .first<{ id: number }>().catch(() => null);
    if (row?.id === id) return;
    const authoritative = await this.getRecord(id);
    if (matchesReservationIdentity(authoritative, reservation) && authoritative.accountingStatus === "transport_ambiguous" &&
      authoritative.ambiguityReason === reason && authoritative.inputTokens === 0 &&
      authoritative.outputTokens === 0 && authoritative.totalTokens === 0) return;
    throw new Error("Gemini ambiguous outcome could not be recorded safely.");
  }

  async reconcileAbandonedReservation(
    expectation: GeminiReservedReconciliationExpectation,
  ): Promise<GeminiReservedReconciliationResult> {
    const row = await this.database.prepare(
      "UPDATE gemini_usage SET accounting_status = 'transport_ambiguous', ambiguity_reason = 'abandoned_reservation', " +
      "accounting_through = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
      "WHERE id = ?1 AND timestamp = ?2 AND provider = 'gemini' AND operation = ?3 AND request_count = 1 AND model = ?4 " +
      "AND accounting_status = 'reserved' AND input_tokens = 0 AND output_tokens = 0 AND total_tokens = 0 " +
      "AND EXISTS (SELECT 1 FROM gemini_usage_state WHERE id = 1 AND usage_unknown = 0) " +
      "AND NOT EXISTS (SELECT 1 FROM gemini_usage other WHERE other.id <> gemini_usage.id " +
        "AND other.accounting_status IN ('reserved', 'transport_ambiguous')) RETURNING id",
    ).bind(expectation.id, expectation.timestamp, expectation.operation, expectation.model)
      .first<{ id: number }>().catch(() => null);
    if (row?.id === expectation.id) return "reconciled";
    const authoritative = await this.getRecord(expectation.id);
    if (authoritative?.id === expectation.id && authoritative.timestamp === expectation.timestamp &&
      authoritative.provider === "gemini" && authoritative.operation === expectation.operation &&
      authoritative.requestCount === 1 && authoritative.model === expectation.model &&
      authoritative.accountingStatus === "transport_ambiguous" &&
      authoritative.ambiguityReason === "abandoned_reservation" && authoritative.inputTokens === 0 &&
      authoritative.outputTokens === 0 && authoritative.totalTokens === 0) {
      const data = await this.getUsageData();
      const unresolved = data.records.filter((record) =>
        ["reserved", "transport_ambiguous"].includes(geminiAccountingStatusOf(record)));
      if (!data.usageUnknown && unresolved.length === 1 && unresolved[0]?.id === expectation.id) return "already_reconciled";
    }
    throw new Error("Gemini reserved reconciliation preconditions were not satisfied.");
  }

  async retireAmbiguousRequest(expectation: GeminiAmbiguityRetirementExpectation): Promise<GeminiAmbiguityRetirementResult> {
    const row = await this.database.prepare(
      "UPDATE gemini_usage SET accounting_status = 'retired_outside_accounting_windows', " +
      "retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') " +
      "WHERE id = ?1 AND timestamp = ?2 AND model = ?3 AND accounting_status = 'transport_ambiguous' " +
      "AND ambiguity_reason = ?4 AND input_tokens = 0 AND output_tokens = 0 AND total_tokens = 0 " +
      "AND accounting_through < strftime('%Y-%m-%dT00:00:00.000Z', 'now') " +
      "AND accounting_through < strftime('%Y-%m-%dT00:00:00.000Z', 'now', '-' || ((CAST(strftime('%w', 'now') AS INTEGER) + 6) % 7) || ' days') " +
      "AND accounting_through < strftime('%Y-%m-01T00:00:00.000Z', 'now') " +
      "AND EXISTS (SELECT 1 FROM gemini_usage_state WHERE id = 1 AND usage_unknown = 0) RETURNING id",
    ).bind(expectation.id, expectation.timestamp, expectation.model, expectation.ambiguityReason)
      .first<{ id: number }>().catch(() => null);
    if (row?.id === expectation.id) return "retired";
    const authoritative = await this.getRecord(expectation.id);
    if (authoritative?.accountingStatus === "retired_outside_accounting_windows" &&
      authoritative.timestamp === expectation.timestamp && authoritative.model === expectation.model &&
      authoritative.ambiguityReason === expectation.ambiguityReason && authoritative.inputTokens === 0 &&
      authoritative.outputTokens === 0 && authoritative.totalTokens === 0) return "already_retired";
    throw new Error("Gemini ambiguity retirement preconditions were not satisfied.");
  }

  private async getRecord(id: number): Promise<GeminiUsageRecord | null> {
    const row = await this.database.prepare(`SELECT ${SELECT_COLUMNS} FROM gemini_usage WHERE id = ?1`)
      .bind(id).first<GeminiUsageRow>();
    return row ? recordFromRow(row) : null;
  }

  private async findUnresolved(): Promise<GeminiUsageRecord | null> {
    const rows = await this.database.prepare(
      `SELECT ${SELECT_COLUMNS} FROM gemini_usage WHERE accounting_status IN ('reserved', 'transport_ambiguous') ORDER BY id ASC LIMIT 2`,
    ).all<GeminiUsageRow>();
    if ((rows.results?.length ?? 0) > 1) throw new Error("D1 Gemini usage contains conflicting unresolved reservations.");
    const row = rows.results?.[0];
    return row ? recordFromRow(row) : null;
  }
}
