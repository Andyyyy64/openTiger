import { createWriteStream, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { db } from "@h1ve/db";
import { events } from "@h1ve/db/schema";
import { eq, desc } from "drizzle-orm";
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
import type { SystemState } from "./state-manager.js";

function setupProcessLogging(logName: string): string | undefined {
  const logDir = process.env.H1VE_LOG_DIR ?? "/tmp/h1ve-logs";

  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create log dir: ${logDir}`, error);
    return;
  }

  const logPath = join(logDir, `${logName}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });

  // ターミナルが流れても追跡できるようにログをファイルに残す
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk, encoding, callback) => {
    stream.write(chunk);
    return stdoutWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk, encoding, callback) => {
    stream.write(chunk);
    return stderrWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stderr.write;

  process.on("exit", () => {
    stream.end();
  });

  console.log(`[Logger] Cycle Manager logs are written to ${logPath}`);
  return logPath;
}

// Cycle Manager設定
interface CycleManagerConfig {
  cycleConfig: CycleConfig;
  monitorIntervalMs: number; // 監視間隔
  cleanupIntervalMs: number; // クリーンアップ間隔
  statsIntervalMs: number; // 統計更新間隔
  autoStartCycle: boolean; // 自動サイクル開始
  autoReplan: boolean; // タスク枯渇時に再計画
  replanIntervalMs: number; // 再計画の最小間隔
  replanRequirementPath?: string; // 要件ファイルのパス
  replanCommand: string; // Planner実行コマンド
  replanWorkdir: string; // Planner実行ディレクトリ
  replanRepoUrl?: string; // 差分判定に使うリポジトリURL
  replanBaseBranch: string; // 差分判定に使うベースブランチ
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
  autoReplan: process.env.AUTO_REPLAN !== "false",
  replanIntervalMs: parseInt(process.env.REPLAN_INTERVAL_MS ?? "300000", 10),
  replanRequirementPath:
    process.env.REPLAN_REQUIREMENT_PATH ?? process.env.REQUIREMENT_PATH,
  replanCommand: process.env.REPLAN_COMMAND ?? "pnpm --filter @h1ve/planner start",
  replanWorkdir: process.env.REPLAN_WORKDIR ?? process.cwd(),
  replanRepoUrl: process.env.REPLAN_REPO_URL ?? process.env.REPO_URL,
  replanBaseBranch: process.env.REPLAN_BASE_BRANCH
    ?? process.env.BASE_BRANCH
    ?? "main",
};

// Cycle Managerの状態
let isRunning = false;
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let activeConfig: CycleManagerConfig = { ...DEFAULT_CONFIG };
let replanInProgress = false;
let lastReplanAt: number | null = null;
let warnedMissingRequirementPath = false;

interface ReplanSignature {
  signature: string;
  requirementHash: string;
  repoHeadSha: string;
}

async function computeRequirementHash(
  requirementPath: string
): Promise<string | undefined> {
  try {
    const content = await readFile(requirementPath, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    console.warn("[CycleManager] Failed to read requirement file:", error);
    return;
  }
}

async function fetchRepoHeadSha(
  repoUrl: string,
  baseBranch: string
): Promise<string | undefined> {
  const token = process.env.GITHUB_TOKEN;
  const authenticatedUrl =
    token && repoUrl.startsWith("https://github.com/")
      ? repoUrl.replace(
        "https://github.com/",
        `https://x-access-token:${token}@github.com/`
      )
      : repoUrl;

  return new Promise((resolveResult) => {
    const child = spawn("git", ["ls-remote", authenticatedUrl, baseBranch], {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.warn("[CycleManager] git ls-remote failed:", stderr.trim());
        resolveResult(undefined);
        return;
      }

      const sha = stdout.trim().split(/\s+/)[0];
      resolveResult(sha || undefined);
    });

    child.on("error", (error) => {
      console.warn("[CycleManager] git ls-remote error:", error);
      resolveResult(undefined);
    });
  });
}

async function computeReplanSignature(
  config: CycleManagerConfig
): Promise<ReplanSignature | undefined> {
  // 要件とリポジトリの状態をまとめて署名し、差異判定に使う
  if (!config.replanRequirementPath) {
    return;
  }

  const requirementHash = await computeRequirementHash(config.replanRequirementPath);
  if (!requirementHash) {
    return;
  }

  if (!config.replanRepoUrl) {
    return;
  }

  const repoHeadSha = await fetchRepoHeadSha(
    config.replanRepoUrl,
    config.replanBaseBranch
  );
  if (!repoHeadSha) {
    return;
  }

  const signaturePayload = {
    requirementHash,
    repoHeadSha,
    repoUrl: config.replanRepoUrl,
    baseBranch: config.replanBaseBranch,
  };
  const signature = createHash("sha256")
    .update(JSON.stringify(signaturePayload))
    .digest("hex");

  return {
    signature,
    requirementHash,
    repoHeadSha,
  };
}

async function getLastSuccessfulReplanSignature(): Promise<string | null> {
  try {
    const [row] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.type, "planner.replan_finished"))
      .orderBy(desc(events.createdAt))
      .limit(1);

    if (!row?.payload || typeof row.payload !== "object") {
      return null;
    }

    const payload = row.payload as Record<string, unknown>;
    const exitCode = payload.exitCode;
    if (exitCode !== 0) {
      return null;
    }

    const signature = payload.signature;
    return typeof signature === "string" ? signature : null;
  } catch (error) {
    console.warn("[CycleManager] Failed to load replan signature:", error);
    return null;
  }
}

async function shouldTriggerReplan(
  state: SystemState,
  config: CycleManagerConfig
): Promise<{ shouldRun: boolean; signature?: ReplanSignature; reason?: string }> {
  if (!config.autoReplan || replanInProgress) {
    return { shouldRun: false, reason: "disabled_or_running" };
  }
  if (!config.replanRequirementPath) {
    if (!warnedMissingRequirementPath) {
      console.warn("[CycleManager] REPLAN_REQUIREMENT_PATH is not set.");
      warnedMissingRequirementPath = true;
    }
    return { shouldRun: false, reason: "missing_requirement_path" };
  }
  if (state.tasks.queued > 0 || state.tasks.running > 0) {
    return { shouldRun: false, reason: "tasks_in_progress" };
  }
  if (lastReplanAt && Date.now() - lastReplanAt < config.replanIntervalMs) {
    return { shouldRun: false, reason: "interval" };
  }

  const signature = await computeReplanSignature(config);
  if (signature) {
    // 直近の成功時と同じ署名なら差異がないので再計画しない
    const lastSignature = await getLastSuccessfulReplanSignature();
    if (lastSignature && lastSignature === signature.signature) {
      return { shouldRun: false, signature, reason: "no_diff" };
    }
  }

  return { shouldRun: true, signature };
}

function buildReplanCommand(config: CycleManagerConfig): string {
  const requirementPath = resolve(config.replanRequirementPath ?? "");
  return `${config.replanCommand} "${requirementPath}"`;
}

async function triggerReplan(
  state: SystemState,
  signature?: ReplanSignature
): Promise<void> {
  const config = activeConfig;
  if (!config.replanRequirementPath) {
    return;
  }

  const command = buildReplanCommand(config);
  replanInProgress = true;
  lastReplanAt = Date.now();

  console.log(`[CycleManager] Triggering planner: ${command}`);
  await recordEvent({
    type: "planner.replan_triggered",
    entityType: "system",
    entityId: "00000000-0000-0000-0000-000000000000",
    payload: {
      reason: "tasks_empty",
      requirementPath: resolve(config.replanRequirementPath),
      tasks: state.tasks,
      signature: signature?.signature,
      requirementHash: signature?.requirementHash,
      repoHeadSha: signature?.repoHeadSha,
    },
  });

  const child = spawn("sh", ["-c", command], {
    cwd: config.replanWorkdir,
    env: {
      ...process.env,
      REPLAN_TRIGGERED_BY: "cycle-manager",
    },
  });

  // Plannerの標準出力をそのまま流す
  child.stdout.on("data", (data: Buffer) => {
    process.stdout.write(data);
  });
  child.stderr.on("data", (data: Buffer) => {
    process.stderr.write(data);
  });

  child.on("close", (code) => {
    replanInProgress = false;
    const exitCode = code ?? -1;
    if (exitCode !== 0) {
      console.error(`[CycleManager] Planner exited with code ${exitCode}`);
    }
    void recordEvent({
      type: "planner.replan_finished",
      entityType: "system",
      entityId: "00000000-0000-0000-0000-000000000000",
      payload: {
        exitCode,
        signature: signature?.signature,
        requirementHash: signature?.requirementHash,
        repoHeadSha: signature?.repoHeadSha,
      },
    });
  });

  child.on("error", (error) => {
    replanInProgress = false;
    console.error("[CycleManager] Planner spawn error:", error);
    void recordEvent({
      type: "planner.replan_failed",
      entityType: "system",
      entityId: "00000000-0000-0000-0000-000000000000",
      payload: {
        error: error.message,
      },
    });
  });
}

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

    // タスク枯渇時はPlannerを再実行する
    const systemState = await captureSystemState();
    const replanDecision = await shouldTriggerReplan(systemState, activeConfig);
    if (replanDecision.shouldRun) {
      await triggerReplan(systemState, replanDecision.signature);
    } else if (replanDecision.reason === "no_diff") {
      lastReplanAt = Date.now();
      await recordEvent({
        type: "planner.replan_skipped",
        entityType: "system",
        entityId: "00000000-0000-0000-0000-000000000000",
        payload: {
          reason: "no_diff",
          signature: replanDecision.signature?.signature,
          requirementHash: replanDecision.signature?.requirementHash,
          repoHeadSha: replanDecision.signature?.repoHeadSha,
        },
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
  setupProcessLogging(process.env.H1VE_LOG_NAME ?? "cycle-manager");
  console.log("=".repeat(60));
  console.log("h1ve Cycle Manager");
  console.log("=".repeat(60));

  activeConfig = { ...DEFAULT_CONFIG };
  updateConfig(activeConfig.cycleConfig);

  console.log(`Monitor interval: ${activeConfig.monitorIntervalMs}ms`);
  console.log(`Cleanup interval: ${activeConfig.cleanupIntervalMs}ms`);
  console.log(`Stats interval: ${activeConfig.statsIntervalMs}ms`);
  console.log(`Max cycle duration: ${activeConfig.cycleConfig.maxDurationMs}ms`);
  console.log(`Max tasks per cycle: ${activeConfig.cycleConfig.maxTasksPerCycle}`);
  console.log(`Max failure rate: ${activeConfig.cycleConfig.maxFailureRate}`);
  console.log(`Auto replan: ${activeConfig.autoReplan}`);
  if (activeConfig.autoReplan) {
    console.log(`Replan interval: ${activeConfig.replanIntervalMs}ms`);
    console.log(
      `Replan requirement: ${activeConfig.replanRequirementPath ?? "not set"}`
    );
    console.log(
      `Replan repo: ${activeConfig.replanRepoUrl ?? "not set"} (${activeConfig.replanBaseBranch})`
    );
  }
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
  if (!restored && activeConfig.autoStartCycle) {
    await startNewCycle();
  } else if (!restored) {
    console.log("[CycleManager] No active cycle found. Use 'new-cycle' to start.");
  }

  // 監視を開始
  isRunning = true;

  // 監視ループ
  monitorTimer = setInterval(runMonitorLoop, activeConfig.monitorIntervalMs);

  // クリーンアップループ
  cleanupTimer = setInterval(runCleanupLoop, activeConfig.cleanupIntervalMs);

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
