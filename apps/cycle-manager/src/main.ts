import { setupProcessLogging } from "@openTiger/core/process-logging";
import { restoreLatestCycle, startNewCycle, updateConfig } from "./cycle-controller";
import { handleCommand } from "./main/cli";
import { DEFAULT_CONFIG, logConfigSummary, type CycleManagerConfig } from "./main/config";
import { runCleanupLoop, runMonitorLoop, runStatsLoop } from "./main/loops";
import { setupSignalHandlers } from "./main/signals";

// Cycle Manager state
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let activeConfig: CycleManagerConfig = { ...DEFAULT_CONFIG };

// Main entry
async function main(): Promise<void> {
  setupProcessLogging(process.env.OPENTIGER_LOG_NAME ?? "cycle-manager", {
    label: "Cycle Manager",
  });
  console.log("=".repeat(60));
  console.log("openTiger Cycle Manager");
  console.log("=".repeat(60));

  activeConfig = { ...DEFAULT_CONFIG };
  updateConfig(activeConfig.cycleConfig);

  logConfigSummary(activeConfig);
  console.log("=".repeat(60));

  // Setup signal handlers
  setupSignalHandlers(() => ({ monitorTimer, cleanupTimer, statsTimer }));

  // Check CLI args
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] !== "--daemon") {
    await handleCommand(args[0] ?? "");
    process.exit(0);
  }

  // Restore existing cycle or start new one
  const restored = await restoreLatestCycle();
  if (!restored && activeConfig.autoStartCycle) {
    await startNewCycle();
  } else if (!restored) {
    console.log("[CycleManager] No active cycle found. Use 'new-cycle' to start.");
  }

  // Start monitoring

  // Monitor loop
  monitorTimer = setInterval(() => runMonitorLoop(activeConfig), activeConfig.monitorIntervalMs);

  // Cleanup loop
  cleanupTimer = setInterval(() => runCleanupLoop(activeConfig), activeConfig.cleanupIntervalMs);

  // Stats update loop
  statsTimer = setInterval(runStatsLoop, activeConfig.statsIntervalMs);

  console.log("[CycleManager] Started monitoring loops");

  // Run in daemon mode
  await new Promise(() => {
    // Run indefinitely
  });
}

main().catch((error) => {
  console.error("Cycle Manager crashed:", error);
  process.exit(1);
});
