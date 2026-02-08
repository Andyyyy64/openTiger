import { startNewCycle, endCurrentCycle, getCycleState } from "../cycle-controller";
import { performFullCleanup } from "../cleaners/index";
import { getDetectedAnomalies, clearAnomalies } from "../monitors/index";
import { performHealthCheck } from "../state-manager";

// CLIコマンド処理
export async function handleCommand(command: string): Promise<void> {
  switch (command) {
    case "status": {
      const state = getCycleState();
      const health = await performHealthCheck();
      console.log("=== Cycle Manager Status ===");
      console.log(`Running: ${state.isRunning}`);
      console.log(`Cycle: #${state.cycleNumber} (id: ${state.cycleId ?? "none"})`);
      console.log(`Started: ${state.startedAt?.toISOString() ?? "N/A"}`);
      console.log(`Health: ${health.healthy ? "OK" : "DEGRADED"}`);
      console.log("Health Checks:", health.checks);
      break;
    }

    case "anomalies": {
      const anomalies = getDetectedAnomalies();
      console.log(`=== Detected Anomalies (${anomalies.length}) ===`);
      for (const a of anomalies) {
        console.log(`[${a.severity}] ${a.type}: ${a.message}`);
      }
      break;
    }

    case "clear-anomalies":
      clearAnomalies();
      console.log("Anomalies cleared");
      break;

    case "end-cycle":
      await endCurrentCycle("manual");
      console.log("Cycle ended manually");
      break;

    case "new-cycle":
      await startNewCycle();
      console.log("New cycle started");
      break;

    case "cleanup":
      await performFullCleanup(true);
      console.log("Full cleanup completed");
      break;

    default:
      console.log("Unknown command:", command);
      console.log(
        "Available commands: status, anomalies, clear-anomalies, end-cycle, new-cycle, cleanup",
      );
  }
}
