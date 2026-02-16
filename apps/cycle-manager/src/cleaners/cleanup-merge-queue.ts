import { SYSTEM_ENTITY_ID } from "@openTiger/core";
import { db } from "@openTiger/db";
import { prMergeQueue } from "@openTiger/db/schema";
import { and, eq, lte } from "drizzle-orm";
import { recordEvent } from "../monitors/event-logger";

function resolveMergeQueueRetryDelayMs(): number {
  const parsed = Number.parseInt(process.env.JUDGE_MERGE_QUEUE_RETRY_DELAY_MS ?? "30000", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 30000;
  }
  return parsed;
}

export async function recoverStaleMergeQueueClaims(): Promise<number> {
  const now = new Date();
  const staleRows = await db
    .select({
      id: prMergeQueue.id,
      taskId: prMergeQueue.taskId,
      prNumber: prMergeQueue.prNumber,
      claimOwner: prMergeQueue.claimOwner,
    })
    .from(prMergeQueue)
    .where(and(eq(prMergeQueue.status, "processing"), lte(prMergeQueue.claimExpiresAt, now)));

  if (staleRows.length === 0) {
    return 0;
  }

  const retryAt = new Date(now.getTime() + resolveMergeQueueRetryDelayMs());
  await db
    .update(prMergeQueue)
    .set({
      status: "pending",
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      claimedAt: null,
      nextAttemptAt: retryAt,
      updatedAt: now,
    })
    .where(and(eq(prMergeQueue.status, "processing"), lte(prMergeQueue.claimExpiresAt, now)));

  await recordEvent({
    type: "cycle.merge_queue_claim_recovered",
    entityType: "system",
    entityId: SYSTEM_ENTITY_ID,
    payload: {
      recoveredCount: staleRows.length,
      retryAt: retryAt.toISOString(),
      queueRows: staleRows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        prNumber: row.prNumber,
        claimOwner: row.claimOwner,
      })),
    },
  });

  return staleRows.length;
}
