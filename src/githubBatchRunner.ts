import { createBatchGatewayClient } from "./services/batchGatewayClient.js";
import { deliveryIdentity } from "./services/emailDeliveryLedger.js";
import { createDailyEmailContext, recoverDailyDelivery } from "./services/notificationOrchestrator.js";
import { createMonitoringRuntimeConfiguration } from "./services/radarRuntimeConfiguration.js";
import { RESEND_ONBOARDING_SENDER, sendFrozenWithResend } from "./tools/email/resend.js";
import { runScheduledMonitoring, type BatchRuntimeEnvironment } from "./worker.js";

type RunMode = "primary" | "fallback" | "recovery";
export type BatchRunnerResult = { action: "cycle" | "recovery"; accepted: boolean }
  | { action: "held"; accepted: false; reason: "no_frozen_payload" | "delivery_authority_unavailable" };

class BatchScheduleError extends Error {
  constructor(reason: "manual_date_invalid" | "schedule_date_unverified" | "schedule_expired", readonly date?: string) {
    super(reason);
  }
}

export function resolveBatchRun(source: NodeJS.ProcessEnv, now: Date): { mode: RunMode; date: string } {
  const today = now.toISOString().slice(0, 10);
  if (source.GITHUB_EVENT_NAME === "workflow_dispatch") {
    if (source.BATCH_LOGICAL_DATE !== today) throw new BatchScheduleError("manual_date_invalid");
    return { mode: "recovery", date: today };
  }

  const timestamp = source.BATCH_RUN_CREATED_AT ?? "";
  const createdAt = new Date(timestamp);
  if (source.GITHUB_EVENT_NAME !== "schedule" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp) ||
    !Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== timestamp.replace(/Z$/, ".000Z")) {
    throw new BatchScheduleError("schedule_date_unverified");
  }
  const date = timestamp.slice(0, 10);
  const weekday = createdAt.getUTCDay();
  const mode = source.BATCH_CRON === `7 8 * * ${weekday}` ? "primary" :
    source.BATCH_CRON === `17 9 * * ${weekday}` ? "fallback" : null;
  if (!mode || timestamp.slice(11, 16) < (mode === "primary" ? "08:07" : "09:17") || createdAt > now) {
    throw new BatchScheduleError("schedule_date_unverified", date);
  }
  if (date !== today || now.getUTCHours() >= 12) throw new BatchScheduleError("schedule_expired", date);
  return { mode, date };
}

export async function runGitHubBatch(options: {
  mode: RunMode;
  date: string;
  env: BatchRuntimeEnvironment;
  gateway: ReturnType<typeof createBatchGatewayClient>;
}): Promise<BatchRunnerResult> {
  const { gateway, mode, date, env } = options;
  const scheduledAt = new Date(date + "T08:00:00.000Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(scheduledAt.getTime()) ||
    scheduledAt.toISOString().slice(0, 10) !== date) throw new Error("Invalid UTC logical date.");
  // Feedback routes stay on the Worker. The Actions runner does not dispatch Threads or X.
  const runtime = { ...env, DB: undefined, X_DISCOVERY_ENABLED: "false", THREADS_DISCOVERY_ENABLED: "false" };
  createMonitoringRuntimeConfiguration(runtime as unknown as Record<string, string | undefined>);
  if (mode !== "recovery" && await gateway.acquireDay(date, "admit")) {
    const result = await runScheduledMonitoring(runtime, { scheduledAt, persistence: gateway.persistence, telemetry: gateway.telemetry });
    return { action: "cycle", accepted: result.delivery?.emailOutcome === "accepted" };
  }
  const identity = deliveryIdentity(scheduledAt);
  if (mode === "primary" || !await gateway.acquireDay(date, "recover")) {
    const record = await gateway.persistence.emailDeliveryLedger.read(identity.key);
    return { action: "held", accepted: false, reason: record ? "delivery_authority_unavailable" : "no_frozen_payload" };
  }

  const result = await recoverDailyDelivery({
    identity,
    context: createDailyEmailContext(),
    ledger: gateway.persistence.emailDeliveryLedger,
    recipient: runtime.NOTIFICATION_EMAIL,
    sender: RESEND_ONBOARDING_SENDER,
    sendFrozen: (body, key) => sendFrozenWithResend(body, key, { environment: runtime as unknown as Record<string, string | undefined> }),
  });
  return { action: "recovery", accepted: result?.emailOutcome === "accepted" };
}

export async function githubBatchMain(source: NodeJS.ProcessEnv): Promise<number> {
  if (source.BATCH_RUNNER_ENABLED !== "true" || Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("Batch runner is inactive or requires Node.js 24.");
  }
  process.env.TZ = "UTC";
  let date: string | undefined;
  try {
    const run = resolveBatchRun(source, new Date());
    date = run.date;
    const gateway = createBatchGatewayClient(source.BATCH_GATEWAY_URL ?? "", source.BATCH_GATEWAY_KEY ?? "");
    const result = await runGitHubBatch({ ...run, gateway, env: source as unknown as BatchRuntimeEnvironment });
    console.info(JSON.stringify({ event: "github_batch_result", date, ...result }));
    return result.accepted ? 0 : 1;
  } catch (error) {
    const scheduleError = error instanceof BatchScheduleError ? error : undefined;
    console.info(JSON.stringify({ event: "github_batch_result", date: scheduleError?.date ?? date,
      action: "stopped", accepted: false, reason: scheduleError?.message ?? "completion_unconfirmed" }));
    return 1;
  }
}
