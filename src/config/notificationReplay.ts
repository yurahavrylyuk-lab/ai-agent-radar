export const NOTIFICATION_REPLAY_WINDOW_HOURS = 72;
export const NOTIFICATION_REPLAY_ACTIVATION_CUTOFF = "2026-10-06T16:00:00.000Z";
export const MAX_REPLAY_DISCOVERY_SCAN = 100;

export function getNotificationReplayWindow(now: Date): {
  fromInclusive: string;
  beforeExclusive: string;
  limit: number;
} | undefined {
  if (Number.isNaN(now.getTime())) throw new Error("Replay cycle timestamp is invalid.");
  if (now.toISOString() <= NOTIFICATION_REPLAY_ACTIVATION_CUTOFF) return undefined;
  const windowStart = new Date(now.getTime() - NOTIFICATION_REPLAY_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  return {
    fromInclusive: windowStart > NOTIFICATION_REPLAY_ACTIVATION_CUTOFF
      ? windowStart
      : NOTIFICATION_REPLAY_ACTIVATION_CUTOFF,
    beforeExclusive: now.toISOString(),
    limit: MAX_REPLAY_DISCOVERY_SCAN,
  };
}
