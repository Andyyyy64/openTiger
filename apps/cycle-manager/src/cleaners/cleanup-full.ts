import { db } from "@openTiger/db";
import { tasks, runs, agents, leases } from "@openTiger/db/schema";
import { eq, not } from "drizzle-orm";
import { SYSTEM_ENTITY_ID } from "@openTiger/core";
import { recordEvent } from "../monitors/event-logger.js";
import { cleanupExpiredLeases } from "./cleanup-leases.js";
import { resetOfflineAgents } from "./cleanup-agents.js";

// クリーンアップ結果
interface CleanupResult {
  leasesReleased: number;
  agentsReset: number;
  tasksReset: number;
  runsCancelled: number;
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
      .set({ status: "queued", blockReason: null, updatedAt: new Date() })
      .where(eq(tasks.status, "running"))
      .returning({ id: tasks.id });
    tasksReset = result.length;
  } else {
    // runningタスクのみqueuedに
    const result = await db
      .update(tasks)
      .set({ status: "queued", blockReason: null, updatedAt: new Date() })
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
    entityId: SYSTEM_ENTITY_ID,
    payload: { ...result },
  });

  return result;
}
