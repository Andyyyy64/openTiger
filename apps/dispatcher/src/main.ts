import { db } from "@h1ve/db";
import { tasks, agents } from "@h1ve/db/schema";
import { eq } from "drizzle-orm";
import {
  createTaskQueue,
  enqueueTask,
  createTaskWorker,
  getQueueStats,
  type TaskJobData,
} from "@h1ve/queue";
import type { Job } from "bullmq";

import {
  cleanupExpiredLeases,
  acquireLease,
  releaseLease,
  getAvailableTasks,
  launchWorker,
  stopAllWorkers,
  getActiveWorkerCount,
  reclaimDeadAgentLeases,
  getAgentStats,
  registerAgent,
  type LaunchMode,
} from "./scheduler/index.js";

// ディスパッチャー設定
interface DispatcherConfig {
  pollIntervalMs: number;
  maxConcurrentWorkers: number;
  launchMode: LaunchMode;
  repoUrl: string;
  baseBranch: string;
  workspacePath: string;
}

// デフォルト設定
const DEFAULT_CONFIG: DispatcherConfig = {
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10),
  maxConcurrentWorkers: parseInt(process.env.MAX_CONCURRENT_WORKERS ?? "5", 10),
  launchMode: (process.env.LAUNCH_MODE as LaunchMode) ?? "process",
  repoUrl: process.env.REPO_URL ?? "",
  baseBranch: process.env.BASE_BRANCH ?? "main",
  workspacePath: process.env.WORKSPACE_PATH ?? "/tmp/h1ve-workspace",
};

// ディスパッチャーの状態
let isRunning = false;
let taskQueue: ReturnType<typeof createTaskQueue> | null = null;

// タスクをディスパッチ
async function dispatchTask(
  task: Awaited<ReturnType<typeof getAvailableTasks>>[0],
  agentId: string,
  config: DispatcherConfig
): Promise<boolean> {
  // リースを取得
  const leaseResult = await acquireLease(task.id, agentId);

  if (!leaseResult.success) {
    console.log(`[Dispatch] Failed to acquire lease for task ${task.id}: ${leaseResult.error}`);
    return false;
  }

  // タスクをrunning状態に更新
  await db
    .update(tasks)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(tasks.id, task.id));

  // BullMQキューにジョブを追加
  if (taskQueue) {
    await enqueueTask(taskQueue, {
      taskId: task.id,
      agentId,
      priority: task.priority,
    });
    console.log(`[Dispatch] Task ${task.id} enqueued for agent ${agentId}`);
  }

  // Workerを起動
  const launchResult = await launchWorker({
    mode: config.launchMode,
    taskId: task.id,
    agentId,
    repoUrl: config.repoUrl,
    baseBranch: config.baseBranch,
    workspacePath: `${config.workspacePath}/${agentId}`,
  });

  if (!launchResult.success) {
    console.error(`[Dispatch] Failed to launch worker: ${launchResult.error}`);
    // リースを解放してタスクをqueuedに戻す
    await releaseLease(task.id);
    await db
      .update(tasks)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
    return false;
  }

  console.log(
    `[Dispatch] Task "${task.title}" dispatched to agent ${agentId} (${config.launchMode} mode)`
  );
  return true;
}

// ディスパッチループ
async function runDispatchLoop(config: DispatcherConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("h1ve Dispatcher started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`Max concurrent workers: ${config.maxConcurrentWorkers}`);
  console.log(`Launch mode: ${config.launchMode}`);
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

      // 現在のWorker数をチェック
      const activeWorkerCount = getActiveWorkerCount();
      const availableSlots = config.maxConcurrentWorkers - activeWorkerCount;

      if (availableSlots > 0) {
        // 利用可能なタスクを取得
        const availableTasks = await getAvailableTasks();

        if (availableTasks.length > 0) {
          console.log(`[Dispatch] Found ${availableTasks.length} available tasks, ${availableSlots} slots available`);

          // 利用可能なスロット分だけディスパッチ
          const tasksToDispatch = availableTasks.slice(0, availableSlots);

          for (const task of tasksToDispatch) {
            // エージェントIDを生成
            const agentId = `worker-${Date.now()}-${Math.random().toString(36).substring(7)}`;

            // エージェントを登録
            await registerAgent(agentId, "worker");

            // ディスパッチ
            await dispatchTask(task, agentId, config);
          }
        }
      }

      // 統計情報を定期的に出力
      if (Math.random() < 0.1) {
        const stats = await getAgentStats();
        const queueStats = taskQueue ? await getQueueStats(taskQueue) : null;
        console.log(
          `[Stats] Agents: ${stats.busy} busy, ${stats.idle} idle, ${stats.offline} offline | ` +
          `Queue: ${queueStats?.waiting ?? 0} waiting, ${queueStats?.active ?? 0} active`
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
    if (taskQueue) {
      await taskQueue.close();
    }

    console.log("[Shutdown] Dispatcher stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// メイン処理
async function main(): Promise<void> {
  const config = { ...DEFAULT_CONFIG };

  // 設定の検証
  if (!config.repoUrl) {
    console.error("Error: REPO_URL environment variable is required");
    process.exit(1);
  }

  // シグナルハンドラーを設定
  setupSignalHandlers();

  // BullMQキューを初期化
  taskQueue = createTaskQueue();
  console.log("[Init] Task queue initialized");

  // BullMQワーカーを起動
  startQueueWorker();
  console.log("[Init] Queue worker started");

  // ディスパッチャーを開始
  isRunning = true;
  await runDispatchLoop(config);
}

main().catch((error) => {
  console.error("Dispatcher crashed:", error);
  process.exit(1);
});
