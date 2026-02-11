import { resolve, relative, isAbsolute } from "node:path";
import { db } from "@openTiger/db";
import { tasks, runs } from "@openTiger/db/schema";
import { and, count, eq } from "drizzle-orm";
import { getRepoMode, getLocalRepoPath, getLocalWorktreeRoot } from "@openTiger/core";
import { setupProcessLogging } from "@openTiger/core/process-logging";
import { createTaskQueue, enqueueTask, getQueueStats, getTaskQueueName } from "@openTiger/queue";

import {
  cleanupExpiredLeases,
  cleanupDanglingLeases,
  recoverOrphanedRunningTasks,
  acquireLease,
  releaseLease,
  getAvailableTasks,
  launchWorker,
  stopAllWorkers,
  getBusyAgentCount,
  reclaimDeadAgentLeases,
  getAgentStats,
  getAvailableAgents,
  type LaunchMode,
} from "./scheduler/index";

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

const DEFAULT_MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_NO_IDLE_LOG_INTERVAL_MS = 60_000;
const NO_IDLE_LOG_INTERVAL_MS = (() => {
  const raw = Number.parseInt(
    process.env.DISPATCH_NO_IDLE_LOG_INTERVAL_MS ?? String(DEFAULT_NO_IDLE_LOG_INTERVAL_MS),
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NO_IDLE_LOG_INTERVAL_MS;
})();
const MAX_POLL_INTERVAL_MS = (() => {
  const raw = Number.parseInt(
    process.env.DISPATCH_MAX_POLL_INTERVAL_MS ?? String(DEFAULT_MAX_POLL_INTERVAL_MS),
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_POLL_INTERVAL_MS;
})();
const noIdleLogState = new Map<string, { lastLoggedAt: number; suppressed: number }>();

function parseMaxConcurrentWorkers(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return 5;
  }
  if (parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
}

function computeBackoffDelayMs(baseDelayMs: number, idleLoopStreak: number): number {
  if (idleLoopStreak <= 0) {
    return baseDelayMs;
  }
  const exponent = Math.min(idleLoopStreak, 6);
  const delay = baseDelayMs * 2 ** exponent;
  return Math.min(delay, Math.max(baseDelayMs, MAX_POLL_INTERVAL_MS));
}

function logNoIdleAgent(requiredRole: string): void {
  const now = Date.now();
  const state = noIdleLogState.get(requiredRole) ?? { lastLoggedAt: 0, suppressed: 0 };
  if (now - state.lastLoggedAt < NO_IDLE_LOG_INTERVAL_MS) {
    state.suppressed += 1;
    noIdleLogState.set(requiredRole, state);
    return;
  }

  const suffix =
    state.suppressed > 0 ? ` (${state.suppressed} similar events suppressed)` : "";
  console.log(`[Dispatch] No idle ${requiredRole} agent available${suffix}`);
  noIdleLogState.set(requiredRole, { lastLoggedAt: now, suppressed: 0 });
}

// デフォルト設定
const DEFAULT_CONFIG: DispatcherConfig = {
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? "5000", 10),
  maxConcurrentWorkers: parseMaxConcurrentWorkers(process.env.MAX_CONCURRENT_WORKERS),
  launchMode: (process.env.LAUNCH_MODE as LaunchMode) ?? "process",
  repoMode: getRepoMode(),
  repoUrl: process.env.REPO_URL ?? "",
  baseBranch: process.env.BASE_BRANCH ?? "main",
  workspacePath: process.env.WORKSPACE_PATH ?? "/tmp/openTiger-workspace",
  localRepoPath: getLocalRepoPath(),
  localWorktreeRoot: getLocalWorktreeRoot(),
};

function isSubPath(baseDir: string, targetDir: string): boolean {
  const relativePath = relative(baseDir, targetDir);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function resolveWorkspacePath(config: DispatcherConfig): string {
  const envPath = process.env.WORKSPACE_PATH?.trim();
  const baseDir = resolve(process.cwd());

  if (config.launchMode === "process") {
    const fallbackPath = resolve(baseDir, ".openTiger-workspace");
    if (!envPath) {
      return fallbackPath;
    }
    const resolved = resolve(envPath);
    if (isSubPath(baseDir, resolved)) {
      return resolved;
    }
    // プロセス起動時は外部ディレクトリを避ける
    console.warn("[Dispatcher] WORKSPACE_PATH is outside repo. Using local workspace instead.");
    return fallbackPath;
  }

  return envPath ? resolve(envPath) : "/tmp/openTiger-workspace";
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
      "[Dispatcher] LOCAL_WORKTREE_ROOT is outside repo. Using local worktrees instead.",
    );
    return fallbackPath;
  }

  return envPath ? resolve(envPath) : "/tmp/openTiger-worktree";
}

// ディスパッチャーの状態
let isRunning = false;
let quotaThrottleActive = false;
// エージェント専用キューを再利用するためのキャッシュ
const taskQueues = new Map<string, ReturnType<typeof createTaskQueue>>();

function getTaskQueueForAgent(agentId: string): ReturnType<typeof createTaskQueue> {
  const existing = taskQueues.get(agentId);
  if (existing) return existing;
  const queue = createTaskQueue(getTaskQueueName(agentId));
  taskQueues.set(agentId, queue);
  return queue;
}

async function hasQuotaWaitBacklog(): Promise<boolean> {
  const [result] = await db
    .select({ count: count() })
    .from(tasks)
    .where(and(eq(tasks.status, "blocked"), eq(tasks.blockReason, "quota_wait")));
  return (result?.count ?? 0) > 0;
}

// タスクをディスパッチ
async function dispatchTask(
  task: Awaited<ReturnType<typeof getAvailableTasks>>[0],
  agentId: string,
  agentRole: string,
  config: DispatcherConfig,
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
    `[Dispatch] Task "${task.title}" dispatched to agent ${agentId} (${agentRole}, ${config.launchMode} mode)`,
  );
  return true;
}

// ディスパッチループ
async function runDispatchLoop(config: DispatcherConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("openTiger Dispatcher started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(
    `Max concurrent workers: ${
      Number.isFinite(config.maxConcurrentWorkers) ? config.maxConcurrentWorkers : "unlimited"
    }`,
  );
  console.log(`Launch mode: ${config.launchMode}`);
  console.log(`Repo mode: ${config.repoMode}`);
  console.log(`Repository: ${config.repoUrl}`);
  console.log(`Base branch: ${config.baseBranch}`);
  console.log("=".repeat(60));

  let idleLoopStreak = 0;
  while (isRunning) {
    try {
      let dispatchedThisLoop = 0;
      // 期限切れリースをクリーンアップ
      const expiredCount = await cleanupExpiredLeases();
      if (expiredCount > 0) {
        console.log(`[Cleanup] Released ${expiredCount} expired leases`);
      }

      const danglingCount = await cleanupDanglingLeases();
      if (danglingCount > 0) {
        console.log(`[Cleanup] Released ${danglingCount} dangling leases`);
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
      const quotaWaitBacklog = await hasQuotaWaitBacklog();
      const effectiveMaxConcurrentWorkers = quotaWaitBacklog
        ? Math.min(config.maxConcurrentWorkers, 1)
        : config.maxConcurrentWorkers;
      if (quotaWaitBacklog && !quotaThrottleActive) {
        console.log(
          "[Dispatch] quota_wait backlog detected. Concurrency temporarily limited to 1.",
        );
        quotaThrottleActive = true;
      } else if (!quotaWaitBacklog && quotaThrottleActive) {
        console.log("[Dispatch] quota_wait backlog cleared. Restoring normal concurrency.");
        quotaThrottleActive = false;
      }

      const availableSlots = Number.isFinite(effectiveMaxConcurrentWorkers)
        ? Math.max(0, effectiveMaxConcurrentWorkers - busyAgentCount)
        : Number.MAX_SAFE_INTEGER;

      if (availableSlots > 0) {
        // 利用可能なタスクを取得
        const availableTasks = await getAvailableTasks();

        if (availableTasks.length > 0) {
          console.log(
            `[Dispatch] Found ${availableTasks.length} available tasks, ${availableSlots} slots available`,
          );

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
              logNoIdleAgent(requiredRole);
              continue;
            }

            // ディスパッチ
            const dispatched = await dispatchTask(task, selectedAgent, requiredRole, config);
            if (dispatched) {
              dispatchedThisLoop += 1;
            }
          }
        }
      }

      // 統計情報を定期的に出力
      if (Math.random() < 0.1) {
        const stats = await getAgentStats();
        const queueStats = taskQueues.size
          ? await Promise.all(Array.from(taskQueues.values()).map((queue) => getQueueStats(queue)))
          : [];
        const aggregatedStats = queueStats.reduce(
          (acc, stat) => ({
            waiting: acc.waiting + stat.waiting,
            active: acc.active + stat.active,
            completed: acc.completed + stat.completed,
            failed: acc.failed + stat.failed,
            total: acc.total + stat.total,
          }),
          { waiting: 0, active: 0, completed: 0, failed: 0, total: 0 },
        );
        console.log(
          `[Stats] Agents: ${stats.busy} busy, ${stats.idle} idle, ${stats.offline} offline | ` +
            `Queue: ${aggregatedStats.waiting} waiting, ${aggregatedStats.active} active`,
        );
      }

      if (dispatchedThisLoop > 0) {
        idleLoopStreak = 0;
      } else {
        idleLoopStreak += 1;
      }
    } catch (error) {
      console.error("[Dispatch] Error in dispatch loop:", error);
      idleLoopStreak += 1;
    }

    // 次のポーリングまで待機
    const delayMs = computeBackoffDelayMs(config.pollIntervalMs, idleLoopStreak);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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
      await Promise.all(Array.from(taskQueues.values()).map((queue) => queue.close()));
    }

    console.log("[Shutdown] Dispatcher stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// メイン処理
async function main(): Promise<void> {
  setupProcessLogging(process.env.OPENTIGER_LOG_NAME ?? "dispatcher", { label: "Dispatcher" });
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
