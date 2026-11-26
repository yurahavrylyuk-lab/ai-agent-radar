import type { BatchGatewayOperations } from "./batchGatewayOperations.js";
import { readGatewayJson, validGatewayKey } from "./batchGatewayWire.js";
import type { WorkerBatchPersistence } from "../worker.js";
import type { MonitoringTelemetry } from "./monitoringTelemetry.js";
import { discoveryTopicTaxonomy } from "./discoveryPriority.js";

type Operation = keyof BatchGatewayOperations;
type Remote<Group extends string> = {
  [K in Operation as K extends `${Group}.${infer Method}` ? Method : never]: BatchGatewayOperations[K]["run"];
};
const unsupported = async (): Promise<never> => { throw new Error("Operation is outside the Batch gateway contract."); };
const preferenceTopics = Object.keys(discoveryTopicTaxonomy);

export function createBatchGatewayClient(endpoint: string, key: string, request: typeof fetch = globalThis.fetch) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    url.pathname !== "/v1/batch" || !validGatewayKey(key)) throw new Error("Batch gateway configuration is invalid.");

  async function call<K extends Operation>(op: K, args: Parameters<BatchGatewayOperations[K]["run"]>):
    Promise<Awaited<ReturnType<BatchGatewayOperations[K]["run"]>>> {
    try {
      // No transparent retries. A dropped write response is an unknown outcome.
      const response = await request(url, { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(15000), redirect: "error", cache: "no-store" });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error();
      const decoded = await readGatewayJson(response, 4 * 1024 * 1024);
      if (!decoded || typeof decoded !== "object") throw new Error();
      const { kind, value } = decoded as Record<string, unknown>;
      if (kind === "map" && (!Array.isArray(value) || !value.every(pair =>
        Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string"))) throw new Error();
      const mapOperation = op === "history.getDiscoveries" || op === "notifications.getNotificationRecords";
      if (mapOperation !== (kind === "map")) throw new Error();
      if (kind !== "value" && kind !== "void" && kind !== "map") throw new Error();
      if (kind === "value" && !Object.hasOwn(decoded, "value")) throw new Error();
      if (op === "feedback.getPreferenceProfile") {
        if (kind !== "value" || !value || typeof value !== "object" || Object.keys(value).length !== preferenceTopics.length ||
          !preferenceTopics.every(topic => {
            const score = (value as Record<string, unknown>)[topic];
            return typeof score === "number" && Number.isFinite(score) && Math.abs(score) <= 0.5;
          })) throw new Error();
      }
      if (op === "ledger.reserveWithBindings" && (kind !== "value" || !value || typeof value !== "object")) throw new Error();
      if (kind === "void" && (op === "ledger.read" || op === "gemini.getUsageData" || op === "brave.getRecords" ||
        op === "history.listRecentDiscoveries" || op === "gemini.reserveRequest" || op === "ledger.verifyDispatch")) throw new Error();
      return (kind === "map" ? new Map(value as [string, unknown][]) : kind === "void" ? undefined : value) as
        Awaited<ReturnType<BatchGatewayOperations[K]["run"]>>;
    } catch { throw new Error("Batch gateway request could not be confirmed."); }
  }

  function remote<Group extends string>(group: Group): Remote<Group> {
    return new Proxy(Object.create(null), {
      get(_target, property) {
        if (typeof property !== "string" || property === "then") return undefined;
        return (...args: unknown[]) => call(`${group}.${property}` as Operation, args as never);
      },
    }) as Remote<Group>;
  }
  const history = remote("history");
  const notifications = remote("notifications");
  const gemini = remote("gemini");
  const persistence: WorkerBatchPersistence = {
    discoveryHistory: {
      getDiscovery: history.getDiscovery, getDiscoveries: history.getDiscoveries, listRecentDiscoveries: history.listRecentDiscoveries,
      touchDiscovery: (url, at) => history.touchDiscovery(url, at),
      touchDiscoveries: (urls, at) => history.touchDiscoveries(urls, at),
      recordDiscoveryWithOutcome: (analysis, at, source, selection) => history.recordDiscoveryWithOutcome(analysis, at, source, selection),
      recordDiscovery: async (analysis, at, source, selection) => (await history.recordDiscoveryWithOutcome(analysis, at, source, selection)).discovery,
    },
    notificationHistory: {
      getNotificationRecord: notifications.getNotificationRecord, getNotificationRecords: notifications.getNotificationRecords,
      hasNotificationBeenSent: notifications.hasNotificationBeenSent, recordNotificationSent: unsupported,
    },
    braveUsageStore: remote("brave"),
    geminiUsageStore: {
      getUsageData: gemini.getUsageData, markUsageUnknown: gemini.markUsageUnknown, reserveRequest: gemini.reserveRequest,
      settleRequest: gemini.settleRequest, confirmZeroRequest: gemini.confirmZeroRequest,
      markRequestAmbiguous: gemini.markRequestAmbiguous, settleObservedAttempt: gemini.settleObservedAttempt,
      recordRequest: unsupported, reconcileAbandonedReservation: unsupported, retireAmbiguousRequest: unsupported,
    },
    openaiFallbackUsageStore: remote("luna"),
    emailDeliveryLedger: remote("ledger"),
    feedbackStore: remote("feedback"),
  };
  return {
    persistence,
    telemetry: remote("telemetry") satisfies MonitoringTelemetry,
    async acquireDay(date: string, mode: "admit" | "recover"): Promise<boolean> {
      const result = await call(mode === "admit" ? "daily.admit" : "daily.recover", [date]);
      if (typeof result !== "boolean") throw new Error("Daily gateway authority could not be confirmed.");
      return result;
    },
  };
}
