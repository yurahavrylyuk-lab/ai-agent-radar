import assert from "node:assert/strict";
import test from "node:test";

import { D1EmailDeliveryLedger } from "../src/services/d1EmailDeliveryLedger.js";
import { deliveryIdentity, freezeDelivery } from "../src/services/emailDeliveryLedger.js";
import { createDailyEmailContext } from "../src/services/notificationOrchestrator.js";
import { runBatchMonitoringCycle } from "../src/services/monitor.js";
import { createGeminiBatchCycleContext } from "../src/tools/llm/gemini.js";
import { createEmailDeliveryDatabase } from "./fixtures/emailDeliveryD1.js";

test("an accepted current-day ledger row is recovered before any discovery or analysis", async () => {
  const { sqlite, d1 } = await createEmailDeliveryDatabase();
  try {
    const ledger = new D1EmailDeliveryLedger(d1 as unknown as D1Database);
    const identity = deliveryIdentity(new Date("2026-11-04T08:00:00.000Z"));
    const digest = { mode: "status_only" as const, reason: "no_eligible_stories" as const, cycleDate: identity.scheduledAt, items: [] };
    const frozen = await freezeDelivery(digest, identity, {
      from: "AI Radar <radar@example.test>", subject: "Status", text: "Status", html: "<p>Status</p>",
    }, "owner@example.test");
    await ledger.reserve(frozen);
    const claim = await ledger.claim(identity.key, "seed");
    if (claim.kind !== "committed" || !claim.record.claim) throw new Error("seed claim missing");
    await ledger.admitDispatch(claim.record.claim);
    await ledger.recordOutcome(claim.record.claim, frozen.payloadSha256, { kind: "accepted", id: "email-seed" });
    await ledger.reconcileAccepted(identity.key);

    let sourceCalls = 0;
    let sendCalls = 0;
    const result = await runBatchMonitoringCycle({
      searchPage: async () => { sourceCalls++; return { rawCount: 0, positions: [] }; },
      collectRss: async () => { sourceCalls++; return { observations: [], metrics: { status: "collected", configuredFeeds: 4, attemptedFeeds: 4, succeededFeeds: 4, failedFeeds: 0, observedPositions: 0, validCandidates: 0, rejectedItems: 0, itemLimitTruncations: 0, outcomes: [] } }; },
      history: { listRecentDiscoveries: async () => ({ discoveries: [], truncated: false }) } as never,
      notification: { history: { hasNotificationBeenSent: async () => false, getNotificationRecord: async () => undefined, recordNotificationSent: async () => { throw new Error("not reached"); } } },
      geminiPreflight: async () => ({ allowed: true }),
      analyze: async () => { sourceCalls++; return { returnedCount: 0, selections: [] }; },
      geminiCycleContext: createGeminiBatchCycleContext(),
      now: () => new Date("2026-11-04T09:00:00.000Z"),
      dailyDelivery: {
        context: createDailyEmailContext(), identity, ledger, recipient: "owner@example.test", sender: "AI Radar <radar@example.test>",
        sendFrozen: async () => { sendCalls++; return { kind: "accepted", id: "unexpected" }; },
      },
    } as Parameters<typeof runBatchMonitoringCycle>[0]);
    assert.equal(sourceCalls, 0);
    assert.equal(sendCalls, 0);
    assert.equal(result.delivery?.emailOutcome, "accepted");
    assert.equal(result.delivery?.emailAttempts, 0);
  } finally { sqlite.close(); }
});
