import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalJsonXStore } from "../src/services/localJsonXStore.js";
import { reserveXRequest } from "../src/services/xUsageGuard.js";
import type { XUsageReservationLimits } from "../src/services/xStore.js";

const now = new Date("2026-10-08T08:00:00.000Z");

test("local X request reservations survive restart and error settlement never refunds capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radar-x-usage-"));
  const file = join(directory, "x.json");
  const store = new LocalJsonXStore(file);
  for (let index = 0; index < 5; index += 1) {
    const reserved = await reserveXRequest(store, "4398626122", now, index);
    assert.equal(reserved.allowed, true);
    await store.settleRequest(reserved.reservationId!, index === 0 ? "error" : "success");
  }
  const restarted = new LocalJsonXStore(file);
  const blocked = await reserveXRequest(restarted, "4398626122", now, 0);
  assert.deepEqual(blocked, { allowed: false, reason: "budget" });
  const persisted = await readFile(file, "utf8");
  assert.match(persisted, /"outcome": "error"/);
});

test("atomic local admission fails closed under a concurrent reservation race", async () => {
  const directory = await mkdtemp(join(tmpdir(), "radar-x-race-"));
  const store = new LocalJsonXStore(join(directory, "x.json"));
  const limits: XUsageReservationLimits = { cycleRequestsAlreadyReserved: 0, requestsPerCycle: 5, requestsPerDay: 1, requestsPerIsoWeek: 1, requestsPerMonth: 1, reservedPostsPerRequest: 10, reservedPostsPerMonth: 10, reservedMicroUsdPerMonth: 50_000, reservedMicroUsdPerRequest: 50_000 };
  const results = await Promise.all([
    store.reserveRequest("4398626122", now, limits).catch(() => ({ allowed: false as const, reason: "state_unavailable" as const })),
    store.reserveRequest("74286565", now, limits).catch(() => ({ allowed: false as const, reason: "state_unavailable" as const })),
  ]);
  assert.equal(results.filter((result) => result.allowed).length, 1);
});

test("local X admission independently enforces weekly and monthly request bounds", async () => {
  const limits = (requestsPerIsoWeek: number, requestsPerMonth: number): XUsageReservationLimits => ({
    cycleRequestsAlreadyReserved: 0,
    requestsPerCycle: 5,
    requestsPerDay: 5,
    requestsPerIsoWeek,
    requestsPerMonth,
    reservedPostsPerRequest: 10,
    reservedPostsPerMonth: 1_550,
    reservedMicroUsdPerMonth: 8_000_000,
    reservedMicroUsdPerRequest: 50_000,
  });

  const weekly = new LocalJsonXStore(join(await mkdtemp(join(tmpdir(), "radar-x-week-")), "x.json"));
  assert.equal((await weekly.reserveRequest("4398626122", new Date("2026-10-05T08:00:00.000Z"), limits(2, 10))).allowed, true);
  assert.equal((await weekly.reserveRequest("74286565", new Date("2026-10-06T08:00:00.000Z"), limits(2, 10))).allowed, true);
  assert.deepEqual(await weekly.reserveRequest("13334762", new Date("2026-10-07T08:00:00.000Z"), limits(2, 10)), { allowed: false, reason: "budget" });

  const monthly = new LocalJsonXStore(join(await mkdtemp(join(tmpdir(), "radar-x-month-")), "x.json"));
  assert.equal((await monthly.reserveRequest("4398626122", new Date("2026-10-01T08:00:00.000Z"), limits(10, 2))).allowed, true);
  assert.equal((await monthly.reserveRequest("74286565", new Date("2026-10-08T08:00:00.000Z"), limits(10, 2))).allowed, true);
  assert.deepEqual(await monthly.reserveRequest("13334762", new Date("2026-10-15T08:00:00.000Z"), limits(10, 2)), { allowed: false, reason: "budget" });
});

test("local X admission enforces monthly reserved-post and logical-cost ceilings", async () => {
  const store = new LocalJsonXStore(join(await mkdtemp(join(tmpdir(), "radar-x-cost-")), "x.json"));
  const limits: XUsageReservationLimits = {
    cycleRequestsAlreadyReserved: 0,
    requestsPerCycle: 5,
    requestsPerDay: 5,
    requestsPerIsoWeek: 35,
    requestsPerMonth: 155,
    reservedPostsPerRequest: 10,
    reservedPostsPerMonth: 20,
    reservedMicroUsdPerMonth: 100_000,
    reservedMicroUsdPerRequest: 50_000,
  };
  assert.equal((await store.reserveRequest("4398626122", now, limits)).allowed, true);
  assert.equal((await store.reserveRequest("74286565", now, limits)).allowed, true);
  assert.deepEqual(await store.reserveRequest("13334762", now, limits), { allowed: false, reason: "budget" });
});

test("direct guard enforces cycle and approved-price expiry before store access", async () => {
  let calls = 0;
  const store = new LocalJsonXStore(join(await mkdtemp(join(tmpdir(), "radar-x-expiry-")), "x.json"));
  const original = store.reserveRequest.bind(store);
  store.reserveRequest = async (...args) => { calls += 1; return original(...args); };
  assert.deepEqual(await reserveXRequest(store, "4398626122", now, 5), { allowed: false, reason: "budget" });
  assert.equal(calls, 1, "cycle limit is atomically rechecked by the store");
  calls = 0;
  assert.deepEqual(await reserveXRequest(store, "4398626122", new Date("2026-11-08T00:00:00.000Z"), 0), { allowed: false, reason: "budget" });
  assert.equal(calls, 0, "expired pricing must block before persistence or network admission");
});

test("migration 0004 is additive and declares the three bounded X tables", async () => {
  const sql = await readFile(new URL("../migrations/0004_x_discovery.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE x_poll_state/);
  assert.match(sql, /CREATE TABLE x_inbox/);
  assert.match(sql, /CREATE TABLE x_request_usage/);
  assert.match(sql, /CHECK \(reserved_posts = 10\)/);
  assert.doesNotMatch(sql, /\b(?:DROP|DELETE|ALTER)\b/i);
});
