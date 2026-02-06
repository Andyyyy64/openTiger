import { createWriteStream, mkdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { db } from "@sebastian-code/db";
import { tasks, agents, runs } from "@sebastian-code/db/schema";
import { and, eq } from "drizzle-orm";
import { getRepoMode, getLocalRepoPath, getLocalWorktreeRoot } from "@sebastian-code/core";
import {
  createTaskQueue,
  enqueueTask,
  createTaskWorker,
  getQueueStats,
  type TaskJobData,
  getTaskQueueName,
} from "@sebastian-code/queue";
import type { Job } from "bullmq";

import {
  cleanupExpiredLeases,
  recoverOrphanedRunningTasks,
  acquireLease,
  releaseLease,
  getAvailableTasks,
  launchWorker,
  stopAllWorkers,
  getBusyAgentCount,
  reclaimDeadAgentLeases,
  getAgentStats,
  registerAgent,
  getAvailableAgents,
  type LaunchMode,
} from "./scheduler/index.js";

function setupProcessLogging(logName: string): string | undefined {
  const logDir = process.env.SEBASTIAN_LOG_DIR ?? "/tmp/sebastian-code-logs";

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

  console.log(`[Logger] Dispatcher logs are written to ${logPath}`);
  return logPath;
}

// ディスパッチャー設定
interface DispatcherConfig {
  pollIntervalMs: number;
  maxConcurrentWorkers: number;
  launchMode: LaunchMode;
  repoMode: "git" | "local";
  repoUrl: string;
  baseBranch: string;
  workspacePath: string;
  localRepoPath?: string;
  localWorktreeRoot?: string;
}

// デフォルト設定
const DEFAULT_CONFIG: DispatcherConfig = {
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10),
  maxConcurrentWorkers: parseInt(process.env.MAX_CONCURRENT_WORKERS ?? "5", 10),
  launchMode: (process.env.LAUNCH_MODE as LaunchMode) ?? "process",
  repoMode: getRepoMode(),
  repoUrl: process.env.REPO_URL ?? "",
  baseBranch: process.env.BASE_BRANCH ?? "main",
  workspacePath: process.env.WORKSPACE_PATH ?? "/tmp/sebastian-code-workspace",
  localRepoPath: getLocalRepoPath(),
  localWorktreeRoot: getLocalWorktreeRoot(),
};

function isSubPath(baseDir: string, targetDir: string): boolean {
  const relativePath = relative(baseDir, targetDir);
  return (
    relativePath === ""
    || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function resolveWorkspacePath(config: DispatcherConfig): string {
  const envPath = process.env.WORKSPACE_PATH?.trim();
  const baseDir = resolve(process.cwd());

  if (config.launchMode === "process") {
    const fallbackPath = resolve(baseDir, ".sebastian-code-workspace");
    if (!envPath) {
      return fallbackPath;
    }
    const resolved = resolve(envPath);
    if (isSubPath(baseDir, resolved)) {
      return resolved;
    }
    // プロセス起動時は外部ディレクトリを避ける
    console.warn(
      "[Dispatcher] WORKSPACE_PATH is outside repo. Using local workspace instead."
    );
    return fallbackPath;
  }

  return envPath ? resolve(envPath) : "/tmp/sebastian-code-workspace";
}

function resolveLocalWorktreeRoot(config: DispatcherConfig): string | undefined {
  const envPath = process.env.LOCAL_WORKTREE_ROOT?.trim();
  const baseDir = resolve(process.cwd());

  if (config.launchMode === "process") {
    const fallbackPath = resolve(config.workspacePath, "worktrees");
    if (!envPath) {
      return fallbackPath;
    }
    const resolved = resolve(envPath);
    if (isSubPath(baseDir, resolved)) {
      return resolved;
    }
    // プロセス起動時は外部ディレクトリを避ける
    console.warn(
      "[Dispatcher] LOCAL_WORKTREE_ROOT is outside repo. Using local worktrees instead."
    );
    return fallbackPath;
  }

  return envPath ? resolve(envPath) : "/tmp/sebastian-code-worktree";
}

// ディスパッチャーの状態
let isRunning = false;
// エージェント専用キューを再利用するためのキャッシュ
const taskQueues = new Map<string, ReturnType<typeof createTaskQueue>>();

function getTaskQueueForAgent(agentId: string): ReturnType<typeof createTaskQueue> {
  const existing = taskQueues.get(agentId);
  if (existing) return existing;
  const queue = createTaskQueue(getTaskQueueName(agentId));
  taskQueues.set(agentId, queue);
  return queue;
}

// タスクをディスパッチ
async function dispatchTask(
  task: Awaited<ReturnType<typeof getAvailableTasks>>[0],
  agentId: string,
  agentRole: string,
  config: DispatcherConfig
): Promise<boolean> {
  // 同一タスクの重複実行を避ける: 実行中Runが残っている場合は再配布しない
  const runningRuns = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, task.id), eq(runs.status, "running")))
    .limit(1);
  if (runningRuns.length > 0) {
    console.log(`[Dispatch] Task ${task.id} already has a running run. Skipping.`);
    return false;
  }

  // リースを取得
  const leaseResult = await acquireLease(task.id, agentId);

  if (!leaseResult.success) {
    console.log(`[Dispatch] Failed to acquire lease for task ${task.id}: ${leaseResult.error}`);
    return false;
  }

  // タスクをrunning状態に更新
  const taskUpdate = await db
    .update(tasks)
    .set({ status: "running", updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "queued")))
    .returning({ id: tasks.id });
  if (taskUpdate.length === 0) {
    await releaseLease(task.id);
    console.log(`[Dispatch] Task ${task.id} is no longer queued. Skipping dispatch.`);
    return false;
  }

  // BullMQキューにジョブを追加
  const agentQueue = getTaskQueueForAgent(agentId);
  await enqueueTask(agentQueue, {
    taskId: task.id,
    agentId,
    priority: task.priority,
  });
  console.log(`[Dispatch] Task ${task.id} enqueued for agent ${agentId}`);

  // Workerを起動
  const launchResult = await launchWorker({
    mode: config.launchMode,
    taskId: task.id,
    agentId,
    agentRole,
    repoUrl: config.repoUrl,
    baseBranch: config.baseBranch,
    workspacePath: `${config.workspacePath}/${agentId}`,
    env: {
      REPO_MODE: config.repoMode,
      LOCAL_REPO_PATH: config.localRepoPath ?? "",
      LOCAL_WORKTREE_ROOT: config.localWorktreeRoot ?? "",
    },
  });

  if (!launchResult.success) {
    console.error(`[Dispatch] Failed to launch worker: ${launchResult.error}`);
    // リースを解放してタスクをqueuedに戻す
    await releaseLease(task.id);
    await db
      .update(tasks)
      .set({ status: "queued", blockReason: null, updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
    return false;
  }

    console.log(
      `[Dispatch] Task "${task.title}" dispatched to agent ${agentId} (${agentRole}, ${config.launchMode} mode)`
    );
  return true;
}

// ディスパッチループ
async function runDispatchLoop(config: DispatcherConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("sebastian-code Dispatcher started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`Max concurrent workers: ${config.maxConcurrentWorkers}`);
  console.log(`Launch mode: ${config.launchMode}`);
  console.log(`Repo mode: ${config.repoMode}`);
  console.log(`Repository: ${config.repoUrl}`);
  console.log(`Base branch: ${config.baseBranch}`);
  console.log("=".repeat(60));

  while (isRunning) {
    try {
      // 期限切れリースをクリーンアップ
      const expiredCount = await cleanupExpiredLeases();
      if (expiredCount > 0) {
        console.log(`[Cleanup] Released ${expiredCount} expired leases`);
      }

      // オフラインエージェントのリースを回収
      const reclaimedCount = await reclaimDeadAgentLeases();
      if (reclaimedCount > 0) {
        console.log(`[Cleanup] Reclaimed ${reclaimedCount} leases from dead agents`);
      }

      // running だが実行中Runが無いタスクを復旧
      const recoveredCount = await recoverOrphanedRunningTasks();
      if (recoveredCount > 0) {
        console.log(`[Cleanup] Recovered ${recoveredCount} orphaned running tasks`);
      }

      // busyエージェント数を基準に同時実行上限を適用（queue/process両対応）
      const busyAgentCount = await getBusyAgentCount();
      const availableSlots = Math.max(0, config.maxConcurrentWorkers - busyAgentCount);

      if (availableSlots > 0) {
        // 利用可能なタスクを取得
        const availableTasks = await getAvailableTasks();

        if (availableTasks.length > 0) {
          console.log(`[Dispatch] Found ${availableTasks.length} available tasks, ${availableSlots} slots available`);

          // 利用可能なスロット分だけディスパッチ
          const tasksToDispatch = availableTasks.slice(0, availableSlots);

          // 現在のサイクルでディスパッチ予定の targetArea を追跡
          const pendingTargetAreas = new Set<string>();

          for (const task of tasksToDispatch) {
            // targetArea の重複チェック（同じサイクル内での衝突回避）
            if (task.targetArea && pendingTargetAreas.has(task.targetArea)) {
              continue;
            }
            if (task.targetArea) {
              pendingTargetAreas.add(task.targetArea);
            }

            // 利用可能な常駐エージェントを取得
            const requiredRole = task.role ?? "worker";
            const availableAgentsList = await getAvailableAgents(requiredRole);
            const selectedAgent = availableAgentsList[0];

            if (!selectedAgent) {
              console.log(`[Dispatch] No idle ${requiredRole} agent for task ${task.id}. Skipping.`);
              continue;
            }

            // ディスパッチ
            await dispatchTask(task, selectedAgent, requiredRole, config);
          }
        }
      }

      // 統計情報を定期的に出力
      if (Math.random() < 0.1) {
        const stats = await getAgentStats();
        const queueStats = taskQueues.size
          ? await Promise.all(
              Array.from(taskQueues.values()).map((queue) => getQueueStats(queue))
            )
          : [];
        const aggregatedStats = queueStats.reduce(
          (acc, stat) => ({
            waiting: acc.waiting + stat.waiting,
            active: acc.active + stat.active,
            completed: acc.completed + stat.completed,
            failed: acc.failed + stat.failed,
            total: acc.total + stat.total,
          }),
          { waiting: 0, active: 0, completed: 0, failed: 0, total: 0 }
        );
        console.log(
          `[Stats] Agents: ${stats.busy} busy, ${stats.idle} idle, ${stats.offline} offline | ` +
          `Queue: ${aggregatedStats.waiting} waiting, ${aggregatedStats.active} active`
        );
      }
    } catch (error) {
      console.error("[Dispatch] Error in dispatch loop:", error);
    }

    // 次のポーリングまで待機
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

// BullMQワーカーを起動
function startQueueWorker(): void {
  const worker = createTaskWorker(async (job: Job<TaskJobData>) => {
    console.log(`[Queue] Processing job ${job.id} for task ${job.data.taskId}`);
    // 実際の処理はWorkerプロセスが行うため、ここでは監視のみ
  });

  worker.on("completed", (job) => {
    console.log(`[Queue] Job ${job.id} completed`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[Queue] Job ${job?.id} failed:`, error.message);
  });
}

// シグナルハンドラー
function setupSignalHandlers(): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}, stopping dispatcher...`);
    isRunning = false;

    // 全Workerを停止
    await stopAllWorkers();

    // キューを閉じる
    if (taskQueues.size > 0) {
      await Promise.all(
        Array.from(taskQueues.values()).map((queue) => queue.close())
      );
    }

    console.log("[Shutdown] Dispatcher stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// メイン処理
async function main(): Promise<void> {
  setupProcessLogging(process.env.SEBASTIAN_LOG_NAME ?? "dispatcher");
  const config = { ...DEFAULT_CONFIG };
  config.workspacePath = resolveWorkspacePath(config);
  config.localWorktreeRoot = resolveLocalWorktreeRoot(config);

  // 設定の検証
  if (config.repoMode === "git" && !config.repoUrl) {
    console.error("Error: REPO_URL environment variable is required for git mode");
    process.exit(1);
  }
  if (config.repoMode === "local" && !config.localRepoPath) {
    console.error("Error: LOCAL_REPO_PATH environment variable is required for local mode");
    process.exit(1);
  }

  // シグナルハンドラーを設定
  setupSignalHandlers();

  // ディスパッチャーを開始
  isRunning = true;
  await runDispatchLoop(config);
}

main().catch((error) => {
  console.error("Dispatcher crashed:", error);
  process.exit(1);
});
