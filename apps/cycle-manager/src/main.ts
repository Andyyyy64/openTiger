import type { CycleConfig } from "@h1ve/core";
import {
  startNewCycle,
  endCurrentCycle,
  checkCycleEnd,
  restoreLatestCycle,
  getCycleState,
  updateConfig,
  calculateCycleStats,
} from "./cycle-controller.js";
import {
  performFullCleanup,
  cleanupExpiredLeases,
  resetOfflineAgents,
  cancelStuckRuns,
} from "./cleaners/index.js";
import {
  recordEvent,
  getCostSummary,
  runAllAnomalyChecks,
  checkCostLimits,
  getDetectedAnomalies,
  clearAnomalies,
} from "./monitors/index.js";
import {
  captureSystemState,
  persistState,
  updateCycleStats,
  performHealthCheck,
} from "./state-manager.js";

// Cycle Manager設定
interface CycleManagerConfig {
  cycleConfig: CycleConfig;
  monitorIntervalMs: number; // 監視間隔
  cleanupIntervalMs: number; // クリーンアップ間隔
  statsIntervalMs: number; // 統計更新間隔
  autoStartCycle: boolean; // 自動サイクル開始
}

// デフォルト設定
const DEFAULT_CONFIG: CycleManagerConfig = {
  cycleConfig: {
    maxDurationMs: parseInt(
      process.env.CYCLE_MAX_DURATION_MS ?? String(4 * 60 * 60 * 1000),
      10
    ), // 4時間
    maxTasksPerCycle: parseInt(process.env.CYCLE_MAX_TASKS ?? "100", 10),
    maxFailureRate: parseFloat(process.env.CYCLE_MAX_FAILURE_RATE ?? "0.3"),
    minTasksForFailureCheck: 10,
    cleanupOnEnd: true,
    preserveTaskState: true,
    statsIntervalMs: 60000,
    healthCheckIntervalMs: 30000,
  },
  monitorIntervalMs: parseInt(process.env.MONITOR_INTERVAL_MS ?? "30000", 10),
  cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS ?? "60000", 10),
  statsIntervalMs: parseInt(process.env.STATS_INTERVAL_MS ?? "60000", 10),
  autoStartCycle: process.env.AUTO_START_CYCLE !== "false",
};

// Cycle Managerの状態
let isRunning = false;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;

// 監視ループ
async function runMonitorLoop(): Promise<void> {
  try {
    const state = getCycleState();

    if (!state.isRunning) {
      return;
    }

    // サイクル終了判定
    const { shouldEnd, triggerType } = await checkCycleEnd();

    if (shouldEnd && triggerType) {
      console.log(`[CycleManager] Cycle end triggered by: ${triggerType}`);

      await recordEvent({
        type: "cycle.end_triggered",
        entityType: "cycle",
        entityId: state.cycleId ?? "unknown",
        payload: { triggerType },
      });

      // サイクル終了処理
      await endCurrentCycle(triggerType);

      // クリーンアップ
      if (state.config.cleanupOnEnd) {
        await performFullCleanup(state.config.preserveTaskState);
      }

      // 新しいサイクルを開始
      await startNewCycle();

      console.log("[CycleManager] New cycle started after cleanup");
    }

    // 異常検知
    const anomalies = await runAllAnomalyChecks();
    if (anomalies.length > 0) {
      console.log(`[CycleManager] Detected ${anomalies.length} anomalies`);

      // クリティカルな異常があればサイクル終了
      const criticalAnomalies = anomalies.filter(
        (a) => a.severity === "critical"
      );
      if (criticalAnomalies.length > 0) {
        console.log("[CycleManager] Critical anomalies detected, ending cycle");
        await endCurrentCycle("critical_anomaly");
        await performFullCleanup(true);
        await startNewCycle();
      }
    }

    // コスト制限チェック
    const costStatus = await checkCostLimits();
    if (!costStatus.isWithinLimits) {
      console.warn("[CycleManager] Cost limits exceeded:", costStatus.warnings);
      // コスト超過時は新しいタスクの実行を一時停止（別途Dispatcherに通知）
      await recordEvent({
        type: "cost.limit_exceeded",
        entityType: "system",
        entityId: "00000000-0000-0000-0000-000000000000",
        payload: costStatus,
      });
    }
  } catch (error) {
    console.error("[CycleManager] Monitor loop error:", error);
  }
}

// クリーンアップループ
async function runCleanupLoop(): Promise<void> {
  try {
    // 期限切れリースをクリーンアップ
    const expiredLeases = await cleanupExpiredLeases();
    if (expiredLeases > 0) {
      console.log(`[Cleanup] Released ${expiredLeases} expired leases`);
    }

    // オフラインエージェントをリセット
    const offlineAgents = await resetOfflineAgents();
    if (offlineAgents > 0) {
      console.log(`[Cleanup] Reset ${offlineAgents} offline agents`);
    }

    // 停滞Runをキャンセル
    const stuckRuns = await cancelStuckRuns();
    if (stuckRuns > 0) {
      console.log(`[Cleanup] Cancelled ${stuckRuns} stuck runs`);
    }
  } catch (error) {
    console.error("[CycleManager] Cleanup loop error:", error);
  }
}

// 統計更新ループ
async function runStatsLoop(): Promise<void> {
  try {
    const state = getCycleState();

    if (!state.isRunning || !state.cycleId || !state.startedAt) {
      return;
    }

    // サイクル統計を更新
    const stats = await calculateCycleStats(state.startedAt);
    await updateCycleStats(state.cycleId, stats);

    // システム状態をキャプチャして永続化
    const systemState = await captureSystemState();
    await persistState(systemState);

    // コストサマリーを出力
    const costSummary = await getCostSummary(state.startedAt);

    console.log(
      `[Stats] Cycle #${state.cycleNumber}: ` +
        `completed=${stats.tasksCompleted}, ` +
        `failed=${stats.tasksFailed}, ` +
        `tokens=${costSummary.totalTokens}`
    );
  } catch (error) {
    console.error("[CycleManager] Stats loop error:", error);
  }
}

// シグナルハンドラー
function setupSignalHandlers(): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}, stopping Cycle Manager...`);
    isRunning = false;

    // タイマーを停止
    if (monitorTimer) clearInterval(monitorTimer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (statsTimer) clearInterval(statsTimer);

    // 現在のサイクルを終了
    const state = getCycleState();
    if (state.isRunning) {
      await endCurrentCycle("shutdown");
    }

    console.log("[Shutdown] Cycle Manager stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// CLIコマンド処理
async function handleCommand(command: string): Promise<void> {
  switch (command) {
    case "status":
      const state = getCycleState();
      const health = await performHealthCheck();
      console.log("=== Cycle Manager Status ===");
      console.log(`Running: ${state.isRunning}`);
      console.log(`Cycle: #${state.cycleNumber} (id: ${state.cycleId ?? "none"})`);
      console.log(`Started: ${state.startedAt?.toISOString() ?? "N/A"}`);
      console.log(`Health: ${health.healthy ? "OK" : "DEGRADED"}`);
      console.log("Health Checks:", health.checks);
      break;

    case "anomalies":
      const anomalies = getDetectedAnomalies();
      console.log(`=== Detected Anomalies (${anomalies.length}) ===`);
      for (const a of anomalies) {
        console.log(`[${a.severity}] ${a.type}: ${a.message}`);
      }
      break;

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
      console.log("Available commands: status, anomalies, clear-anomalies, end-cycle, new-cycle, cleanup");
  }
}

// メイン処理
async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("h1ve Cycle Manager");
  console.log("=".repeat(60));

  const config = { ...DEFAULT_CONFIG };
  updateConfig(config.cycleConfig);

  console.log(`Monitor interval: ${config.monitorIntervalMs}ms`);
  console.log(`Cleanup interval: ${config.cleanupIntervalMs}ms`);
  console.log(`Stats interval: ${config.statsIntervalMs}ms`);
  console.log(`Max cycle duration: ${config.cycleConfig.maxDurationMs}ms`);
  console.log(`Max tasks per cycle: ${config.cycleConfig.maxTasksPerCycle}`);
  console.log(`Max failure rate: ${config.cycleConfig.maxFailureRate}`);
  console.log("=".repeat(60));

  // シグナルハンドラーを設定
  setupSignalHandlers();

  // コマンドライン引数をチェック
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] !== "--daemon") {
    await handleCommand(args[0] ?? "");
    process.exit(0);
  }

  // 既存のサイクルを復元、なければ新規開始
  const restored = await restoreLatestCycle();
  if (!restored && config.autoStartCycle) {
    await startNewCycle();
  } else if (!restored) {
    console.log("[CycleManager] No active cycle found. Use 'new-cycle' to start.");
  }

  // 監視を開始
  isRunning = true;

  // 監視ループ
  monitorTimer = setInterval(runMonitorLoop, config.monitorIntervalMs);

  // クリーンアップループ
  cleanupTimer = setInterval(runCleanupLoop, config.cleanupIntervalMs);

  // 統計更新ループ
  statsTimer = setInterval(runStatsLoop, config.statsIntervalMs);

  console.log("[CycleManager] Started monitoring loops");

  // デーモンモードで実行
  await new Promise(() => {
    // 永続的に実行
  });
}

main().catch((error) => {
  console.error("Cycle Manager crashed:", error);
  process.exit(1);
});
