import { db } from "@openTiger/db";
import { tasks, leases } from "@openTiger/db/schema";
import { and, eq, inArray, lt } from "drizzle-orm";
import { recordEvent } from "../monitors/event-logger";

// Clean up expired leases
export async function cleanupExpiredLeases(): Promise<number> {
  const now = new Date();

  // Fetch expired leases
  const expired = await db
    .select({ id: leases.id, taskId: leases.taskId })
    .from(leases)
    .where(lt(leases.expiresAt, now));

  if (expired.length === 0) {
    return 0;
  }

  // Delete leases
  const leaseIds = expired.map((l) => l.id);
  await db.delete(leases).where(inArray(leases.id, leaseIds));

  // Revert corresponding tasks to queued
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
