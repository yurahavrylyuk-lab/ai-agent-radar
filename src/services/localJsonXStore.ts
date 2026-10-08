import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { XSourceProvenance } from "../types/index.js";
import { isoWeekStart, utcDayStart, utcMonthStart, type XInboxRecord, type XRequestReservation, type XReservationResult, type XStore, type XUsageReservationLimits, type XUsageOutcome } from "./xStore.js";

interface XLocalData {
  pollState: Record<string, { sinceId?: string; lastSuccessAt?: string; disabledReason?: string }>;
  globalDisabledReason?: string;
  inbox: XInboxRecord[];
  usage: XRequestReservation[];
  nextUsageId: number;
}

const emptyData = (): XLocalData => ({ pollState: {}, inbox: [], usage: [], nextUsageId: 1 });
const copyRecord = (record: XInboxRecord): XInboxRecord => ({ ...record, editIds: [...record.editIds], payload: record.payload ? { ...record.payload, editIds: [...record.payload.editIds] } : undefined });

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
    await this.withExclusiveWrite(async (data) => {
      for (const post of posts) {
        const existing = data.inbox.find((item) => item.postId === post.postId || item.editIds.some((id) => post.editIds.includes(id)));
        if (!existing) data.inbox.push(copyRecord(post));
      }
      const state = data.pollState[authorId] ?? {};
      data.pollState[authorId] = { ...state, ...(sinceId ? { sinceId } : {}), lastSuccessAt: lastSuccessAt.toISOString() };
      return [undefined, data];
    });
  }

  async listPending(now: Date, limit: number) {
    await this.withExclusiveWrite(async (data) => {
      for (const row of data.inbox) {
        if (row.state === "pending" && new Date(row.createdAt).getTime() + 7 * 86_400_000 < now.getTime()) {
          row.state = "expired"; row.payload = undefined;
        }
      }
      return [undefined, data];
    });
    let truncated = false;
    await this.withExclusiveWrite(async (data) => {
      const pending = data.inbox.filter((row) => row.state === "pending")
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
          || (BigInt(a.postId) < BigInt(b.postId) ? -1 : BigInt(a.postId) > BigInt(b.postId) ? 1 : 0));
      const overflow = Math.max(0, pending.length - limit);
      truncated = overflow > 0;
      for (const row of pending.slice(0, overflow)) { row.state = "expired"; row.payload = undefined; }
      return [undefined, data];
    });
    const pending = (await this.read()).inbox.filter((row) => row.state === "pending");
    return { records: pending.map(copyRecord), truncated };
  }

  async markStoryProcessed(storyUrl: string): Promise<void> {
    await this.withExclusiveWrite(async (data) => {
      for (const row of data.inbox) if (row.storyUrl === storyUrl && row.state === "pending") { row.state = "processed"; row.payload = undefined; }
      return [undefined, data];
    });
  }

  async getStoryByPostId(postId: string): Promise<{ storyUrl: string; provenance?: XSourceProvenance } | undefined> {
    const row = (await this.read()).inbox.find((item) => item.postId === postId || item.editIds.includes(postId));
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
