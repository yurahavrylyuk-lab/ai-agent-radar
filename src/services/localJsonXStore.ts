import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { XSourceProvenance } from "../types/index.js";
import {
  X_PENDING_PAYLOAD_LIMIT,
  X_PENDING_RETENTION_MS,
  compareOldestXInboxRecord,
  isoWeekStart,
  utcDayStart,
  utcMonthStart,
  validateXInboxPageIdentities,
  validateXInboxRecordIdentity,
  type XInboxRecord,
  type XRequestReservation,
  type XReservationResult,
  type XStore,
  type XUsageReservationLimits,
  type XUsageOutcome,
} from "./xStore.js";

interface XLocalData {
  pollState: Record<string, { sinceId?: string; lastSuccessAt?: string; disabledReason?: string }>;
  globalDisabledReason?: string;
  inbox: XInboxRecord[];
  usage: XRequestReservation[];
  nextUsageId: number;
}

const emptyData = (): XLocalData => ({ pollState: {}, inbox: [], usage: [], nextUsageId: 1 });
const copyRecord = (record: XInboxRecord): XInboxRecord => ({ ...record, editIds: [...record.editIds], payload: record.payload ? { ...record.payload, editIds: [...record.payload.editIds] } : undefined });

function validateStoredInboxIdentities(records: readonly XInboxRecord[]): Map<string, string> {
  const primaryIds = new Set<string>();
  const ownerById = new Map<string, string>();
  for (const record of records) {
    validateXInboxRecordIdentity(record);
    if (primaryIds.has(record.postId)) throw new Error("X inbox identity state is ambiguous.");
    primaryIds.add(record.postId);
    for (const id of record.editIds) {
      const owner = ownerById.get(id);
      if (owner !== undefined && owner !== record.postId) throw new Error("X inbox identity state is ambiguous.");
      ownerById.set(id, record.postId);
    }
  }
  return ownerById;
}

function enforcePendingBounds(data: XLocalData, now: Date, limit: number, retentionMs: number): boolean {
  if (Number.isNaN(now.getTime())) throw new Error("X pending retention requires a valid timestamp.");
  const cutoff = now.getTime() - retentionMs;
  for (const row of data.inbox) {
    const createdAt = Date.parse(row.createdAt);
    if (!Number.isFinite(createdAt)) throw new Error("X inbox contains an invalid createdAt timestamp.");
    if (row.state === "pending" && createdAt < cutoff) { row.state = "expired"; row.payload = undefined; }
  }
  const pending = data.inbox.filter((row) => row.state === "pending").sort(compareOldestXInboxRecord);
  const overflow = Math.max(0, pending.length - limit);
  for (const row of pending.slice(0, overflow)) { row.state = "expired"; row.payload = undefined; }
  return overflow > 0;
}

export class LocalJsonXStore implements XStore {
  constructor(private readonly filePath = resolve(process.cwd(), "data", "x-discovery.json")) {}

  async getPollState(authorId: string) { const data = await this.read(); return { ...data.pollState[authorId] }; }
  async getGlobalDisabledReason() { return (await this.read()).globalDisabledReason; }

  async reserveRequest(authorId: string, now: Date, limits: XUsageReservationLimits): Promise<XReservationResult> {
    return this.withExclusiveWrite<XReservationResult>(async (data) => {
      const time = now.getTime();
      if (Number.isNaN(time)) return [{ allowed: false, reason: "state_unavailable" }, data];
      const countSince = (start: Date) => data.usage.filter((row) => new Date(row.reservedAt) >= start).length;
      const monthRows = data.usage.filter((row) => new Date(row.reservedAt) >= utcMonthStart(now));
      const denied = limits.cycleRequestsAlreadyReserved >= limits.requestsPerCycle
        || countSince(utcDayStart(now)) >= limits.requestsPerDay
        || countSince(isoWeekStart(now)) >= limits.requestsPerIsoWeek
        || monthRows.length >= limits.requestsPerMonth
        || monthRows.reduce((sum, row) => sum + row.reservedPosts, 0) + limits.reservedPostsPerRequest > limits.reservedPostsPerMonth
        || monthRows.reduce((sum, row) => sum + row.reservedMicroUsd, 0) + limits.reservedMicroUsdPerRequest > limits.reservedMicroUsdPerMonth;
      if (denied) return [{ allowed: false, reason: "budget" }, data];
      const id = data.nextUsageId++;
      data.usage.push({ id, reservedAt: now.toISOString(), authorId, reservedPosts: limits.reservedPostsPerRequest, reservedMicroUsd: limits.reservedMicroUsdPerRequest, outcome: "reserved" });
      return [{ allowed: true, reservationId: id }, data];
    });
  }

  async settleRequest(reservationId: number, outcome: Exclude<XUsageOutcome, "reserved">): Promise<void> {
    await this.withExclusiveWrite(async (data) => {
      const row = data.usage.find((item) => item.id === reservationId);
      if (!row || row.outcome !== "reserved") throw new Error("X request reservation could not be settled safely.");
      row.outcome = outcome;
      return [undefined, data];
    });
  }

  async commitPage(authorId: string, sinceId: string | undefined, posts: XInboxRecord[], lastSuccessAt: Date): Promise<void> {
    validateXInboxPageIdentities(posts);
    if (Number.isNaN(lastSuccessAt.getTime())) throw new Error("X page commit requires a valid timestamp.");
    await this.withExclusiveWrite(async (data) => {
      const ownerById = validateStoredInboxIdentities(data.inbox);
      for (const post of posts) {
        const owners = new Set(post.editIds.map((id) => ownerById.get(id)).filter((id): id is string => id !== undefined));
        if (owners.size > 1 || (owners.size === 1 && !owners.has(post.postId))) {
          throw new Error("X inbox edit identity conflicts with a frozen story.");
        }
        const existing = data.inbox.find((item) => item.postId === post.postId);
        if (existing) {
          if (existing.authorId !== post.authorId || existing.storyUrl !== post.storyUrl) {
            throw new Error("X inbox edit identity conflicts with a frozen story.");
          }
          for (const id of post.editIds) if (!existing.editIds.includes(id)) { existing.editIds.push(id); ownerById.set(id, post.postId); }
        } else {
          data.inbox.push(copyRecord(post));
          for (const id of post.editIds) ownerById.set(id, post.postId);
        }
      }
      enforcePendingBounds(data, lastSuccessAt, X_PENDING_PAYLOAD_LIMIT, X_PENDING_RETENTION_MS);
      const state = data.pollState[authorId] ?? {};
      data.pollState[authorId] = { ...state, ...(sinceId ? { sinceId } : {}), lastSuccessAt: lastSuccessAt.toISOString() };
      return [undefined, data];
    });
  }

  async listPending(now: Date, limit: number) {
    return this.withExclusiveWrite(async (data) => {
      validateStoredInboxIdentities(data.inbox);
      const truncated = enforcePendingBounds(data, now, limit, X_PENDING_RETENTION_MS);
      const records = data.inbox.filter((row) => row.state === "pending")
        .sort((left, right) => left.createdAt > right.createdAt ? -1 : left.createdAt < right.createdAt ? 1
          : left.postId < right.postId ? -1 : left.postId > right.postId ? 1 : 0)
        .map(copyRecord);
      return [{ records, truncated }, data];
    });
  }

  async markStoryProcessed(storyUrl: string): Promise<void> {
    await this.withExclusiveWrite(async (data) => {
      for (const row of data.inbox) if (row.storyUrl === storyUrl && row.state === "pending") { row.state = "processed"; row.payload = undefined; }
      return [undefined, data];
    });
  }

  async getStoryByPostId(postId: string): Promise<{ storyUrl: string; provenance?: XSourceProvenance } | undefined> {
    const data = await this.read();
    validateStoredInboxIdentities(data.inbox);
    const rows = data.inbox.filter((item) => item.postId === postId || item.editIds.includes(postId));
    if (rows.length > 1) throw new Error("X inbox identity state is ambiguous.");
    const row = rows[0];
    if (!row) return undefined;
    const payload = row.payload;
    return { storyUrl: row.storyUrl, ...(payload ? { provenance: { kind: "x", postId: row.postId, authorId: row.authorId, postUrl: payload.canonicalPostUrl, label: payload.label } as const } : {}) };
  }

  async setDisabledReason(authorId: string | undefined, reason: string): Promise<void> {
    await this.withExclusiveWrite(async (data) => {
      if (authorId) data.pollState[authorId] = { ...(data.pollState[authorId] ?? {}), disabledReason: reason };
      else data.globalDisabledReason = reason;
      return [undefined, data];
    });
  }

  private async read(): Promise<XLocalData> {
    try { return JSON.parse(await readFile(this.filePath, "utf8")) as XLocalData; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyData(); throw new Error("X local state could not be read safely."); }
  }
  private async write(data: XLocalData) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
  private async withExclusiveWrite<T>(operation: (data: XLocalData) => Promise<[T, XLocalData]>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { throw new Error("X local state is locked or unavailable."); }
    try { const [result, data] = await operation(await this.read()); await this.write(data); return result; }
    finally { await lock.close(); await unlink(lockPath).catch(() => undefined); }
  }
}
