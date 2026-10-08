import "dotenv/config";

import { runMonitoringCycle } from "./services/monitor.js";
import { createLocalMonitoringDependencies } from "./services/localMonitoringDependencies.js";

await runMonitoringCycle(undefined, createLocalMonitoringDependencies());
