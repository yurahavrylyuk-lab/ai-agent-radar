import "dotenv/config";
import { runMonitoringCycle } from "./services/monitor.js";
import { createLocalMonitoringDependencies } from "./services/localMonitoringDependencies.js";

try {
  const result = await runMonitoringCycle(undefined, createLocalMonitoringDependencies());
  console.info(JSON.stringify(result, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[ERROR] Monitoring cycle failed: ${message}`);
  process.exitCode = 1;
}
