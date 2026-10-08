import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalJsonXStore } from "../src/services/localJsonXStore.js";
import type { XInboxRecord } from "../src/services/xStore.js";

const authorId = "4398626122";
const commitTime = new Date("2026-10-08T08:00:00.000Z");
const opaqueId = (index: number) => (9_007_199_254_740_000_000n + BigInt(index)).toString();

function record(index: number, options: { createdAt?: string; editIds?: string[]; storyUrl?: string } = {}): XInboxRecord {
  const postId = opaqueId(index);
  const createdAt = options.createdAt ?? "2026-10-07T08:00:00.000Z";
  const storyUrl = options.storyUrl ?? `https://example.com/story-${index}`;
  const editIds = options.editIds ?? [postId];
  return {
    postId,
    authorId,
    storyUrl,
    createdAt,
    state: "pending",
    editIds,
    payload: {
      postId,
      authorId,
      createdAt,
      text: `Story ${index}`,
      storyUrl,
      canonicalPostUrl: `https://x.com/i/web/status/${postId}`,
      label: "OpenAI",
      approvedHandle: "OpenAI",
      editIds: [...editIds],
    },
  };
}

test("local X store rejects alias conflicts atomically and preserves exact re-observation", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "radar-x-alias-")), "x.json");
  const store = new LocalJsonXStore(file);
  const sharedAlias = opaqueId(99);
  for (const editIds of [[], [opaqueId(1), opaqueId(1)], [sharedAlias]]) {
    await assert.rejects(store.commitPage(authorId, opaqueId(49), [record(1, { editIds })], commitTime), /edit identity is invalid/);
    assert.deepEqual(await store.getPollState(authorId), {});
  }
  await assert.rejects(store.commitPage(authorId, opaqueId(50), [
    record(1, { editIds: [opaqueId(1), sharedAlias] }),
    record(2, { editIds: [opaqueId(2), sharedAlias] }),
  ], commitTime), /conflicting edit alias/);
  assert.deepEqual(await store.getPollState(authorId), {});
  assert.equal((await store.listPending(commitTime, 350)).records.length, 0);

  const original = record(1, { editIds: [opaqueId(1), sharedAlias] });
  await store.commitPage(authorId, opaqueId(51), [original], commitTime);
  await store.commitPage(authorId, opaqueId(52), [original], commitTime);
  assert.equal((await store.listPending(commitTime, 350)).records.length, 1);
  assert.equal((await store.getStoryByPostId(sharedAlias))?.storyUrl, original.storyUrl);
  assert.equal(typeof (await store.listPending(commitTime, 350)).records[0].postId, "string");

  await assert.rejects(store.commitPage(authorId, opaqueId(53), [
    record(2, { editIds: [opaqueId(2), sharedAlias] }),
  ], commitTime), /conflicts with a frozen story/);
  assert.equal((await store.getPollState(authorId)).sinceId, opaqueId(52));
  assert.equal((await store.listPending(commitTime, 350)).records.length, 1);
});

test("local X store enforces expiry and deterministic 350-record cap during commit and after restart", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "radar-x-cap-")), "x.json");
  const store = new LocalJsonXStore(file);
  await store.commitPage(authorId, opaqueId(699), [
    record(999, { createdAt: "2026-09-30T08:00:00.000Z" }),
    ...Array.from({ length: 349 }, (_, index) => record(index + 1, { createdAt: "2026-10-07T06:00:00.000Z" })),
  ], new Date("2026-10-07T07:00:00.000Z"));
  await store.commitPage(authorId, opaqueId(700), [
    record(350, { createdAt: "2026-10-08T07:00:00.000Z" }),
    record(351, { createdAt: "2026-10-08T07:00:00.000Z" }),
  ], commitTime);

  const persisted = JSON.parse(await readFile(file, "utf8")) as { inbox: XInboxRecord[] };
  const expiredOld = persisted.inbox.find((item) => item.postId === opaqueId(999));
  const evictedTie = persisted.inbox.find((item) => item.postId === opaqueId(1));
  assert.equal(expiredOld?.state, "expired");
  assert.equal(expiredOld?.payload, undefined);
  assert.equal(evictedTie?.state, "expired");
  assert.equal(evictedTie?.payload, undefined);
  assert.equal(persisted.inbox.filter((item) => item.state === "pending").length, 350);
  assert.equal((await store.getPollState(authorId)).sinceId, opaqueId(700));

  const restarted = new LocalJsonXStore(file);
  const pending = await restarted.listPending(commitTime, 350);
  assert.equal(pending.records.length, 350);
  assert.equal(pending.records.some((item) => item.postId === opaqueId(1)), false);
  assert.equal(pending.records.some((item) => item.postId === opaqueId(2)), true);
  assert.deepEqual(pending.records.slice(0, 2).map((item) => item.postId), [opaqueId(350), opaqueId(351)]);
});

test("local X store write failure rolls back inbox cleanup and cursor advancement", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "radar-x-rollback-")), "x.json");
  const store = new LocalJsonXStore(file);
  await store.commitPage(authorId, opaqueId(80), [record(1, { createdAt: "2026-09-30T08:00:00.000Z" })], new Date("2026-10-01T08:00:00.000Z"));

  const writable = store as unknown as { write(data: unknown): Promise<void> };
  writable.write = async () => { throw new Error("injected write failure"); };
  await assert.rejects(store.commitPage(authorId, opaqueId(81), [record(2)], commitTime), /injected write failure/);

  const restarted = new LocalJsonXStore(file);
  assert.equal((await restarted.getPollState(authorId)).sinceId, opaqueId(80));
  const raw = JSON.parse(await readFile(file, "utf8")) as { inbox: XInboxRecord[] };
  assert.equal(raw.inbox.length, 1);
  assert.equal(raw.inbox[0].state, "pending");
  assert.ok(raw.inbox[0].payload);
});

test("local X store fails closed when persisted aliases make lookup ambiguous", async () => {
  const file = join(await mkdtemp(join(tmpdir(), "radar-x-corrupt-")), "x.json");
  const alias = opaqueId(90);
  await writeFile(file, `${JSON.stringify({
    pollState: {},
    inbox: [
      record(1, { editIds: [opaqueId(1), alias] }),
      record(2, { editIds: [opaqueId(2), alias] }),
    ],
    usage: [],
    nextUsageId: 1,
  })}\n`);
  await assert.rejects(new LocalJsonXStore(file).getStoryByPostId(alias), /ambiguous/);
});
