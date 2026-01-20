import { db } from "@h1ve/db";
import { tasks, runs, agents, leases } from "@h1ve/db/schema";
import { eq, inArray, and, lt, not } from "drizzle-orm";
import { recordEvent } from "../monitors/event-logger.js";

// クリーンアップ結果
interface CleanupResult {
  leasesReleased: number;
  agentsReset: number;
  tasksReset: number;
  runsCancelled: number;
}

// 期限切れリースをクリーンアップ
export async function cleanupExpiredLeases(): Promise<number> {
  const now = new Date();

  // 期限切れリースを取得
  const expired = await db
    .select({ id: leases.id, taskId: leases.taskId })
    .from(leases)
    .where(lt(leases.expiresAt, now));

  if (expired.length === 0) {
    return 0;
  }

  // リースを削除
  const leaseIds = expired.map((l) => l.id);
  await db.delete(leases).where(inArray(leases.id, leaseIds));

  // 対応するタスクをqueuedに戻す
  const taskIds = expired.map((l) => l.taskId);
  await db
    .update(tasks)
    .set({ status: "queued", updatedAt: new Date() })
    .where(
      and(inArray(tasks.id, taskIds), eq(tasks.status, "running"))
    );

  for (const lease of expired) {
    await recordEvent({
      type: "lease.expired",
      entityType: "lease",
      entityId: lease.id,
      payload: { taskId: lease.taskId },
    });
  }

  return expired.length;
}

// オフラインエージェントをリセット
export async function resetOfflineAgents(): Promise<number> {
  // ハートビートが一定時間ない（10分以上）エージェントを検出
  const threshold = new Date(Date.now() - 10 * 60 * 1000);

  const offlineAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        not(eq(agents.status, "offline")),
        lt(agents.lastHeartbeat, threshold)
      )
    );

  if (offlineAgents.length === 0) {
    return 0;
  }

  const agentIds = offlineAgents.map((a) => a.id);
  await db
    .update(agents)
    .set({ status: "offline", currentTaskId: null })
    .where(inArray(agents.id, agentIds));

  for (const agent of offlineAgents) {
    await recordEvent({
      type: "agent.offline",
      entityType: "agent",
      entityId: agent.id,
      agentId: agent.id,
    });
  }

  return offlineAgents.length;
}

// 実行中だが進行していないRunをキャンセル
export async function cancelStuckRuns(
  maxDurationMs: number = 60 * 60 * 1000 // デフォルト1時間
): Promise<number> {
  const threshold = new Date(Date.now() - maxDurationMs);

  const stuckRuns = await db
    .select({ id: runs.id, taskId: runs.taskId })
    .from(runs)
    .where(and(eq(runs.status, "running"), lt(runs.startedAt, threshold)));

  if (stuckRuns.length === 0) {
    return 0;
  }

  const runIds = stuckRuns.map((r) => r.id);
  await db
    .update(runs)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      errorMessage: "Cancelled due to timeout",
    })
    .where(inArray(runs.id, runIds));

  // 対応するタスクをfailedに
  const taskIds = stuckRuns.map((r) => r.taskId);
  await db
    .update(tasks)
    .set({ status: "failed", updatedAt: new Date() })
    .where(inArray(tasks.id, taskIds));

  for (const run of stuckRuns) {
    await recordEvent({
      type: "run.timeout",
      entityType: "run",
      entityId: run.id,
      payload: { taskId: run.taskId, reason: "stuck_timeout" },
    });
  }

  return stuckRuns.length;
}

// サイクル終了時のフルクリーンアップ
export async function performFullCleanup(
  preserveTaskState: boolean = true
): Promise<CleanupResult> {
  console.log("[Cleanup] Starting full cleanup...");

  // 1. 期限切れリースをクリーンアップ
  const leasesReleased = await cleanupExpiredLeases();

  // 2. 全リースを解放
  const allLeases = await db.select().from(leases);
  if (allLeases.length > 0) {
    await db.delete(leases);
    console.log(`[Cleanup] Released ${allLeases.length} active leases`);
  }

  // 3. オフラインエージェントをリセット
  const agentsReset = await resetOfflineAgents();

  // 4. 全エージェントをidleに
  await db
    .update(agents)
    .set({ status: "idle", currentTaskId: null })
    .where(not(eq(agents.status, "offline")));

  // 5. 実行中タスクをリセット
  let tasksReset = 0;
  if (!preserveTaskState) {
    // 全タスクをqueuedに戻す
    const result = await db
      .update(tasks)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(tasks.status, "running"))
      .returning({ id: tasks.id });
    tasksReset = result.length;
  } else {
    // runningタスクのみqueuedに
    const result = await db
      .update(tasks)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(tasks.status, "running"))
      .returning({ id: tasks.id });
    tasksReset = result.length;
  }

  // 6. 実行中Runをキャンセル
  const runResult = await db
    .update(runs)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      errorMessage: "Cancelled during cycle cleanup",
    })
    .where(eq(runs.status, "running"))
    .returning({ id: runs.id });
  const runsCancelled = runResult.length;

  const result: CleanupResult = {
    leasesReleased: leasesReleased + allLeases.length,
    agentsReset,
    tasksReset,
    runsCancelled,
  };

  console.log(
    `[Cleanup] Completed: ` +
      `${result.leasesReleased} leases, ` +
      `${result.agentsReset} agents, ` +
      `${result.tasksReset} tasks, ` +
      `${result.runsCancelled} runs`
  );

  await recordEvent({
    type: "cycle.cleanup",
    entityType: "cycle",
    entityId: "system",
    payload: { ...result },
  });

  return result;
}

// 失敗したタスクを再キューイング
export async function requeueFailedTasks(): Promise<number> {
  const result = await db
    .update(tasks)
    .set({ status: "queued", updatedAt: new Date() })
    .where(eq(tasks.status, "failed"))
    .returning({ id: tasks.id });

  for (const task of result) {
    await recordEvent({
      type: "task.requeued",
      entityType: "task",
      entityId: task.id,
    });
  }

  return result.length;
}
