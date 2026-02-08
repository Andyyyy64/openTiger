import { db } from "@openTiger/db";
import { tasks, leases } from "@openTiger/db/schema";
import { and, eq, inArray, lt } from "drizzle-orm";
import { recordEvent } from "../monitors/event-logger";

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
    .set({ status: "queued", blockReason: null, updatedAt: new Date() })
    .where(and(inArray(tasks.id, taskIds), eq(tasks.status, "running")));

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
