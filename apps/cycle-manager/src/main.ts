import { setupProcessLogging } from "@openTiger/core/process-logging";
import { restoreLatestCycle, startNewCycle, updateConfig } from "./cycle-controller";
import { handleCommand } from "./main/cli";
import { DEFAULT_CONFIG, logConfigSummary, type CycleManagerConfig } from "./main/config";
import { runCleanupLoop, runMonitorLoop, runStatsLoop } from "./main/loops";
import { setupSignalHandlers } from "./main/signals";

// Cycle Managerの状態
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let activeConfig: CycleManagerConfig = { ...DEFAULT_CONFIG };

// メイン処理
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

  // シグナルハンドラーを設定
  setupSignalHandlers(() => ({ monitorTimer, cleanupTimer, statsTimer }));

  // コマンドライン引数をチェック
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] !== "--daemon") {
    await handleCommand(args[0] ?? "");
    process.exit(0);
  }

  // 既存のサイクルを復元、なければ新規開始
  const restored = await restoreLatestCycle();
  if (!restored && activeConfig.autoStartCycle) {
    await startNewCycle();
  } else if (!restored) {
    console.log("[CycleManager] No active cycle found. Use 'new-cycle' to start.");
  }

  // 監視を開始

  // 監視ループ
  monitorTimer = setInterval(() => runMonitorLoop(activeConfig), activeConfig.monitorIntervalMs);

  // クリーンアップループ
  cleanupTimer = setInterval(() => runCleanupLoop(activeConfig), activeConfig.cleanupIntervalMs);

  // 統計更新ループ
  statsTimer = setInterval(runStatsLoop, activeConfig.statsIntervalMs);

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
