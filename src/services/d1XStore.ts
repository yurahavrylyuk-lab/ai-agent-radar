import type { XSourceProvenance } from "../types/index.js";
import {
  X_PENDING_PAYLOAD_LIMIT,
  X_PENDING_RETENTION_MS,
  isoWeekStart,
  utcDayStart,
  utcMonthStart,
  validateXInboxPageIdentities,
  validateXInboxRecordIdentity,
  type XInboxRecord,
  type XReservationResult,
  type XStore,
  type XUsageReservationLimits,
  type XUsageOutcome,
} from "./xStore.js";

interface PollRow { since_id: string | null; disabled_reason: string | null; }
interface InboxRow { post_id: string; author_id: string; story_url: string; created_at: string; payload_json: string | null; state: XInboxRecord["state"]; edit_ids_json: string; }

const findOverlappingInboxSql = "WITH incoming(value) AS (SELECT value FROM json_each(?1)) "
  + "SELECT post_id, author_id, story_url, created_at, payload_json, state, edit_ids_json FROM x_inbox "
  + "WHERE post_id IN (SELECT value FROM incoming) OR EXISTS (SELECT 1 FROM json_each(edit_ids_json) WHERE value IN (SELECT value FROM incoming)) "
  + "ORDER BY post_id ASC";

// A conflicting row makes this INSERT collide with its own primary key, aborting the D1 batch.
const abortOnConflictingAliasSql = "WITH args(edit_json, post_id, author_id, story_url) AS (VALUES (?1, ?2, ?3, ?4)), "
  + "incoming(value) AS (SELECT value FROM json_each((SELECT edit_json FROM args))) "
  + "INSERT INTO x_inbox (post_id, author_id, story_url, created_at, payload_json, state, edit_ids_json) "
  + "SELECT existing.post_id, existing.author_id, existing.story_url, existing.created_at, existing.payload_json, existing.state, existing.edit_ids_json "
  + "FROM x_inbox AS existing WHERE (existing.post_id <> (SELECT post_id FROM args) AND (existing.post_id IN (SELECT value FROM incoming) "
  + "OR EXISTS (SELECT 1 FROM json_each(existing.edit_ids_json) WHERE value IN (SELECT value FROM incoming)))) "
  + "OR (existing.post_id = (SELECT post_id FROM args) AND (existing.author_id <> (SELECT author_id FROM args) "
  + "OR existing.story_url <> (SELECT story_url FROM args))) LIMIT 1";

const expireOldPendingSql = "UPDATE x_inbox SET state = 'expired', payload_json = NULL WHERE state = 'pending' AND created_at < ?1";
const evictPendingOverflowSql = "WITH overflow(value) AS (SELECT MAX(COUNT(*) - ?1, 0) FROM x_inbox WHERE state = 'pending') "
  + "UPDATE x_inbox SET state = 'expired', payload_json = NULL WHERE post_id IN (SELECT post_id FROM x_inbox WHERE state = 'pending' "
  + "ORDER BY created_at ASC, post_id ASC LIMIT (SELECT value FROM overflow))";

function fromRow(row: InboxRow): XInboxRecord {
  return { postId: row.post_id, authorId: row.author_id, storyUrl: row.story_url, createdAt: row.created_at, payload: row.payload_json ? JSON.parse(row.payload_json) : undefined, state: row.state, editIds: JSON.parse(row.edit_ids_json) };
}

export class D1XStore implements XStore {
  constructor(private readonly database: D1Database) {}
  async getPollState(authorId: string) {
    const row = await this.database.prepare("SELECT since_id, disabled_reason FROM x_poll_state WHERE author_id = ?1").bind(authorId).first<PollRow>();
    return { ...(row?.since_id ? { sinceId: row.since_id } : {}), ...(row?.disabled_reason ? { disabledReason: row.disabled_reason } : {}) };
  }
  async getGlobalDisabledReason() { return (await this.getPollState("__global__")).disabledReason; }
  async reserveRequest(authorId: string, now: Date, limits: XUsageReservationLimits): Promise<XReservationResult> {
    if (limits.cycleRequestsAlreadyReserved >= limits.requestsPerCycle) return { allowed: false, reason: "budget" };
    const result = await this.database.prepare(
      "INSERT INTO x_request_usage (reserved_at, author_id, reserved_posts, reserved_micro_usd, outcome) "
      + "SELECT ?, ?, ?, ?, 'reserved' WHERE "
      + "(SELECT COUNT(*) FROM x_request_usage WHERE reserved_at >= ?) < ? AND "
      + "(SELECT COUNT(*) FROM x_request_usage WHERE reserved_at >= ?) < ? AND "
      + "(SELECT COUNT(*) FROM x_request_usage WHERE reserved_at >= ?) < ? AND "
      + "(SELECT COALESCE(SUM(reserved_posts), 0) FROM x_request_usage WHERE reserved_at >= ?) + ? <= ? AND "
      + "(SELECT COALESCE(SUM(reserved_micro_usd), 0) FROM x_request_usage WHERE reserved_at >= ?) + ? <= ?",
    ).bind(now.toISOString(), authorId, limits.reservedPostsPerRequest, limits.reservedMicroUsdPerRequest,
      utcDayStart(now).toISOString(), limits.requestsPerDay,
      isoWeekStart(now).toISOString(), limits.requestsPerIsoWeek,
      utcMonthStart(now).toISOString(), limits.requestsPerMonth,
      utcMonthStart(now).toISOString(), limits.reservedPostsPerRequest, limits.reservedPostsPerMonth,
      utcMonthStart(now).toISOString(), limits.reservedMicroUsdPerRequest, limits.reservedMicroUsdPerMonth).run();
    const changes = Number(result.meta?.changes ?? 0);
    if (changes !== 1) return { allowed: false, reason: "budget" };
    const id = Number(result.meta?.last_row_id);
    return Number.isSafeInteger(id) ? { allowed: true, reservationId: id } : { allowed: false, reason: "state_unavailable" };
  }
  async settleRequest(id: number, outcome: Exclude<XUsageOutcome, "reserved">) {
    const result = await this.database.prepare("UPDATE x_request_usage SET outcome = ?1 WHERE id = ?2 AND outcome = 'reserved'").bind(outcome, id).run();
    if (Number(result.meta?.changes ?? 0) !== 1) throw new Error("X request reservation could not be settled safely.");
  }
  async commitPage(authorId: string, sinceId: string | undefined, posts: XInboxRecord[], lastSuccessAt: Date) {
    validateXInboxPageIdentities(posts);
    if (Number.isNaN(lastSuccessAt.getTime())) throw new Error("X page commit requires a valid timestamp.");
    const statements: D1PreparedStatement[] = [];
    for (const post of posts) {
      const overlap = await this.database.prepare(findOverlappingInboxSql).bind(JSON.stringify(post.editIds)).all<InboxRow>();
      const rows = overlap.results ?? [];
      if (rows.length > 1) throw new Error("X inbox identity state is ambiguous.");
      const existing = rows[0] ? fromRow(rows[0]) : undefined;
      if (existing) validateXInboxRecordIdentity(existing);
      if (existing && (existing.postId !== post.postId || existing.authorId !== post.authorId || existing.storyUrl !== post.storyUrl)) {
        throw new Error("X inbox edit identity conflicts with a frozen story.");
      }
      const mergedEditIds = existing
        ? [...existing.editIds, ...post.editIds.filter((id) => !existing.editIds.includes(id))]
        : post.editIds;
      statements.push(this.database.prepare(abortOnConflictingAliasSql).bind(JSON.stringify(mergedEditIds), post.postId, post.authorId, post.storyUrl));
      statements.push(this.database.prepare(
        "INSERT OR IGNORE INTO x_inbox (post_id, author_id, story_url, created_at, payload_json, state, edit_ids_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).bind(post.postId, post.authorId, post.storyUrl, post.createdAt, post.payload ? JSON.stringify(post.payload) : null, post.state, JSON.stringify(mergedEditIds)));
      if (existing && mergedEditIds.length !== existing.editIds.length) {
        statements.push(this.database.prepare("UPDATE x_inbox SET edit_ids_json = ?1 WHERE post_id = ?2").bind(JSON.stringify(mergedEditIds), post.postId));
      }
    }
    statements.push(this.database.prepare(expireOldPendingSql).bind(new Date(lastSuccessAt.getTime() - X_PENDING_RETENTION_MS).toISOString()));
    statements.push(this.database.prepare(evictPendingOverflowSql).bind(X_PENDING_PAYLOAD_LIMIT));
    statements.push(this.database.prepare(
      "INSERT INTO x_poll_state (author_id, since_id, last_success_at, disabled_reason) VALUES (?1, ?2, ?3, NULL) "
      + "ON CONFLICT(author_id) DO UPDATE SET since_id = COALESCE(excluded.since_id, x_poll_state.since_id), last_success_at = excluded.last_success_at",
    ).bind(authorId, sinceId ?? null, lastSuccessAt.toISOString()));
    await this.database.batch(statements);
  }
  async listPending(now: Date, limit: number) {
    if (Number.isNaN(now.getTime())) throw new Error("X pending lookup requires a valid timestamp.");
    const results = await this.database.batch([
      this.database.prepare(expireOldPendingSql).bind(new Date(now.getTime() - X_PENDING_RETENTION_MS).toISOString()),
      this.database.prepare(evictPendingOverflowSql).bind(limit),
    ]);
    const result = await this.database.prepare("SELECT post_id, author_id, story_url, created_at, payload_json, state, edit_ids_json FROM x_inbox WHERE state = 'pending' ORDER BY created_at DESC, post_id ASC LIMIT ?1").bind(limit).all<InboxRow>();
    const rows = result.results ?? [];
    return { records: rows.map(fromRow), truncated: Number(results[1]?.meta?.changes ?? 0) > 0 };
  }
  async markStoryProcessed(storyUrl: string) { await this.database.prepare("UPDATE x_inbox SET state = 'processed', payload_json = NULL WHERE story_url = ?1 AND state = 'pending'").bind(storyUrl).run(); }
  async getStoryByPostId(postId: string): Promise<{ storyUrl: string; provenance?: XSourceProvenance } | undefined> {
    const result = await this.database.prepare("WITH requested(value) AS (VALUES (?1)) SELECT post_id, author_id, story_url, created_at, payload_json, state, edit_ids_json FROM x_inbox WHERE post_id = (SELECT value FROM requested) OR EXISTS (SELECT 1 FROM json_each(edit_ids_json) WHERE value = (SELECT value FROM requested)) ORDER BY post_id ASC").bind(postId).all<InboxRow>();
    const rows = result.results ?? [];
    if (rows.length > 1) throw new Error("X inbox identity state is ambiguous.");
    if (!rows[0]) return undefined;
    const record = fromRow(rows[0]);
    validateXInboxRecordIdentity(record);
    return { storyUrl: record.storyUrl, ...(record.payload ? { provenance: { kind: "x", postId: record.postId, authorId: record.authorId, postUrl: record.payload.canonicalPostUrl, label: record.payload.label } as const } : {}) };
  }
  async setDisabledReason(authorId: string | undefined, reason: string) {
    await this.database.prepare("INSERT INTO x_poll_state (author_id, since_id, last_success_at, disabled_reason) VALUES (?1, NULL, NULL, ?2) ON CONFLICT(author_id) DO UPDATE SET disabled_reason = excluded.disabled_reason").bind(authorId ?? "__global__", reason).run();
  }
}
