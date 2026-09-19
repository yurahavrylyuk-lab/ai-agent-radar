import "dotenv/config";
import { runMonitoringCycle } from "./services/monitor.js";

try {
  const result = await runMonitoringCycle();
  console.info(JSON.stringify(result, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[ERROR] Monitoring cycle failed: ${message}`);
  process.exitCode = 1;
}
