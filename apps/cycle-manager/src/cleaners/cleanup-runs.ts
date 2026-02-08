import { db } from "@openTiger/db";
import { runs, tasks } from "@openTiger/db/schema";
import { and, eq, inArray, lt } from "drizzle-orm";
import { recordEvent } from "../monitors/event-logger";

// 実行中だが進行していないRunをキャンセル
export async function cancelStuckRuns(
  maxDurationMs: number = parseInt(process.env.STUCK_RUN_TIMEOUT_MS ?? "900000", 10), // デフォルト15分
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
    .set({ status: "failed", blockReason: null, updatedAt: new Date() })
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
