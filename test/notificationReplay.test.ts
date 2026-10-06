import assert from "node:assert/strict";
import test from "node:test";
import {
  getNotificationReplayWindow,
  MAX_REPLAY_DISCOVERY_SCAN,
  NOTIFICATION_REPLAY_ACTIVATION_CUTOFF,
  NOTIFICATION_REPLAY_WINDOW_HOURS,
} from "../src/config/notificationReplay.js";

test("replay policy is disabled at and before the immutable activation cutoff", () => {
  assert.equal(getNotificationReplayWindow(new Date("2026-10-06T15:59:59.999Z")), undefined);
  assert.equal(getNotificationReplayWindow(new Date(NOTIFICATION_REPLAY_ACTIVATION_CUTOFF)), undefined);
});

test("replay policy uses the activation cutoff until the full 72-hour window has elapsed", () => {
  assert.equal(NOTIFICATION_REPLAY_WINDOW_HOURS, 72);
  assert.deepEqual(getNotificationReplayWindow(new Date("2026-10-07T08:00:00.000Z")), {
    fromInclusive: NOTIFICATION_REPLAY_ACTIVATION_CUTOFF,
    beforeExclusive: "2026-10-07T08:00:00.000Z",
    limit: MAX_REPLAY_DISCOVERY_SCAN,
  });
});

test("replay policy advances to a rolling 72-hour boundary and remains bounded", () => {
  assert.equal(MAX_REPLAY_DISCOVERY_SCAN, 100);
  assert.deepEqual(getNotificationReplayWindow(new Date("2026-10-10T08:00:00.000Z")), {
    fromInclusive: "2026-10-07T08:00:00.000Z",
    beforeExclusive: "2026-10-10T08:00:00.000Z",
    limit: 100,
  });
});

test("replay policy rejects an invalid cycle timestamp", () => {
  assert.throws(() => getNotificationReplayWindow(new Date("invalid")), /timestamp is invalid/);
});
