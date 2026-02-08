import { db } from "@openTiger/db";
import { cycles, tasks, runs, agents, leases } from "@openTiger/db/schema";
import { eq, and, gte, lte, sql, count, sum } from "drizzle-orm";
import type { CycleConfig, CycleStats, StateSnapshot, CycleTriggerType } from "@openTiger/core";

// サイクル制御の状態
interface CycleState {
  cycleId: string | null;
  cycleNumber: number;
  startedAt: Date | null;
  config: CycleConfig;
  isRunning: boolean;
}

let currentState: CycleState = {
  cycleId: null,
  cycleNumber: 0,
  startedAt: null,
  config: {
    maxDurationMs: 4 * 60 * 60 * 1000, // 4時間
    maxTasksPerCycle: 100,
    maxFailureRate: 0.3, // 30%
    minTasksForFailureCheck: 10,
    cleanupOnEnd: true,
    preserveTaskState: true,
    statsIntervalMs: 60000,
    healthCheckIntervalMs: 30000,
  },
  isRunning: false,
};

// 設定を更新
export function updateConfig(config: Partial<CycleConfig>): void {
  currentState.config = { ...currentState.config, ...config };
}

// 現在のサイクル状態を取得
export function getCycleState(): CycleState {
  return { ...currentState };
}

// 状態スナップショットを取得
export async function captureStateSnapshot(): Promise<StateSnapshot> {
  const [pendingResult] = await db
    .select({ count: count() })
    .from(tasks)
    .where(eq(tasks.status, "queued"));

  const [runningResult] = await db
    .select({ count: count() })
    .from(tasks)
    .where(eq(tasks.status, "running"));

  const [agentResult] = await db
    .select({ count: count() })
    .from(agents)
    .where(eq(agents.status, "busy"));

  const [leaseResult] = await db.select({ count: count() }).from(leases);

  return {
    pendingTaskCount: pendingResult?.count ?? 0,
    runningTaskCount: runningResult?.count ?? 0,
    activeAgentCount: agentResult?.count ?? 0,
    queuedJobCount: leaseResult?.count ?? 0,
    timestamp: new Date(),
  };
}

// サイクル統計を計算
export async function calculateCycleStats(cycleStartedAt: Date): Promise<CycleStats> {
  // サイクル開始以降のRun統計を取得
  const runStats = await db
    .select({
      status: runs.status,
      count: count(),
      tokens: sum(runs.costTokens),
    })
    .from(runs)
    .where(gte(runs.startedAt, cycleStartedAt))
    .groupBy(runs.status);

  let tasksCompleted = 0;
  let tasksFailed = 0;
  let runsTotal = 0;
  let totalTokens = 0;

  for (const stat of runStats) {
    const c = stat.count;
    runsTotal += c;
    if (stat.status === "success") {
      tasksCompleted = c;
    } else if (stat.status === "failed") {
      tasksFailed = c;
    }
    totalTokens += Number(stat.tokens) || 0;
  }

  // アクティブWorker数をピーク値として取得（簡易版: 現在値）
  const [activeWorkers] = await db
    .select({ count: count() })
    .from(agents)
    .where(eq(agents.status, "busy"));

  return {
    tasksCompleted,
    tasksFailed,
    tasksCancelled: 0,
    runsTotal,
    totalTokens,
    prsCreated: 0,
    prsMerged: 0,
    prsRejected: 0,
    peakConcurrentWorkers: activeWorkers?.count ?? 0,
  };
}

// 新しいサイクルを開始
export async function startNewCycle(): Promise<string> {
  // 前のサイクルが実行中なら終了
  if (currentState.isRunning && currentState.cycleId) {
    await endCurrentCycle("new_cycle_start");
  }

  // 次のサイクル番号を取得
  const [lastCycle] = await db
    .select({ maxNumber: sql<number>`MAX(${cycles.number})` })
    .from(cycles);

  const nextNumber = (lastCycle?.maxNumber ?? 0) + 1;

  // 状態スナップショットを取得
  const snapshot = await captureStateSnapshot();

  // 新しいサイクルを作成
  const [newCycle] = await db
    .insert(cycles)
    .values({
      number: nextNumber,
      status: "running",
      stateSnapshot: snapshot,
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksCancelled: 0,
        runsTotal: 0,
        totalTokens: 0,
        prsCreated: 0,
        prsMerged: 0,
        prsRejected: 0,
        peakConcurrentWorkers: 0,
      },
    })
    .returning();

  if (!newCycle) {
    throw new Error("Failed to create new cycle");
  }

  currentState = {
    ...currentState,
    cycleId: newCycle.id,
    cycleNumber: nextNumber,
    startedAt: newCycle.startedAt,
    isRunning: true,
  };

  console.log(`[Cycle] Started cycle #${nextNumber} (id: ${newCycle.id})`);
  return newCycle.id;
}

// 現在のサイクルを終了
export async function endCurrentCycle(reason: string): Promise<void> {
  if (!currentState.cycleId || !currentState.startedAt) {
    return;
  }

  // 最終統計を計算
  const stats = await calculateCycleStats(currentState.startedAt);

  // サイクルを終了状態に更新
  await db
    .update(cycles)
    .set({
      status: "completed",
      endedAt: new Date(),
      endReason: reason,
      stats,
    })
    .where(eq(cycles.id, currentState.cycleId));

  console.log(
    `[Cycle] Ended cycle #${currentState.cycleNumber} - ${reason} ` +
      `(completed: ${stats.tasksCompleted}, failed: ${stats.tasksFailed})`,
  );

  currentState.isRunning = false;
}

// 時間ベースのサイクル終了判定
export function shouldEndByTime(): boolean {
  if (!currentState.startedAt || !currentState.config.maxDurationMs) {
    return false;
  }

  const elapsed = Date.now() - currentState.startedAt.getTime();
  return elapsed >= currentState.config.maxDurationMs;
}

// タスク数ベースのサイクル終了判定
export async function shouldEndByTaskCount(): Promise<boolean> {
  if (!currentState.startedAt || !currentState.config.maxTasksPerCycle) {
    return false;
  }

  const [result] = await db
    .select({ count: count() })
    .from(runs)
    .where(and(gte(runs.startedAt, currentState.startedAt), eq(runs.status, "success")));

  return (result?.count ?? 0) >= currentState.config.maxTasksPerCycle;
}

// 失敗率ベースのサイクル終了判定
export async function shouldEndByFailureRate(): Promise<boolean> {
  if (!currentState.startedAt || !currentState.config.maxFailureRate) {
    return false;
  }

  const stats = await calculateCycleStats(currentState.startedAt);
  const totalTasks = stats.tasksCompleted + stats.tasksFailed;

  // 最小タスク数に達していない場合はチェックしない
  if (totalTasks < currentState.config.minTasksForFailureCheck) {
    return false;
  }

  const failureRate = stats.tasksFailed / totalTasks;
  return failureRate >= currentState.config.maxFailureRate;
}

// サイクル終了判定を実行
export async function checkCycleEnd(): Promise<{
  shouldEnd: boolean;
  triggerType: CycleTriggerType | null;
}> {
  // 時間ベースチェック
  if (shouldEndByTime()) {
    return { shouldEnd: true, triggerType: "time" };
  }

  // タスク数ベースチェック
  if (await shouldEndByTaskCount()) {
    return { shouldEnd: true, triggerType: "task_count" };
  }

  // 失敗率ベースチェック
  if (await shouldEndByFailureRate()) {
    return { shouldEnd: true, triggerType: "failure_rate" };
  }

  return { shouldEnd: false, triggerType: null };
}

// 最新のサイクルを復元
export async function restoreLatestCycle(): Promise<boolean> {
  const [latestCycle] = await db
    .select()
    .from(cycles)
    .where(eq(cycles.status, "running"))
    .orderBy(sql`${cycles.startedAt} DESC`)
    .limit(1);

  if (!latestCycle) {
    return false;
  }

  currentState = {
    ...currentState,
    cycleId: latestCycle.id,
    cycleNumber: latestCycle.number,
    startedAt: latestCycle.startedAt,
    isRunning: true,
  };

  console.log(`[Cycle] Restored cycle #${latestCycle.number} (id: ${latestCycle.id})`);
  return true;
}
