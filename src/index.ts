import "dotenv/config";

import { runMonitoringCycle } from "./services/monitor.js";

await runMonitoringCycle();
