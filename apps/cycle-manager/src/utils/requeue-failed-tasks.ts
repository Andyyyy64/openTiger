#!/usr/bin/env node
// Utility to immediately requeue failed tasks
import { db } from "@openTiger/db";
import { tasks, events } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import "dotenv/config";

async function requeueAllFailedTasks(): Promise<void> {
  console.log("[Requeue] Looking for failed tasks...");

  const failedTasks = await db
    .select({ id: tasks.id, title: tasks.title, retryCount: tasks.retryCount })
    .from(tasks)
    .where(eq(tasks.status, "failed"));

  if (failedTasks.length === 0) {
    console.log("[Requeue] No failed tasks found");
    return;
  }

  console.log(`[Requeue] Found ${failedTasks.length} failed tasks`);

  for (const task of failedTasks) {
    await db
      .update(tasks)
      .set({
        status: "queued",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));

    await db.insert(events).values({
      type: "task.requeued",
      entityType: "task",
      entityId: task.id,
      payload: { reason: "manual_requeue", retryCount: task.retryCount },
    });

    console.log(`[Requeue] ${task.id} - ${task.title} (retry: ${task.retryCount ?? 0})`);
  }

  console.log("[Requeue] Done!");
  process.exit(0);
}

requeueAllFailedTasks().catch((error) => {
  console.error("[Requeue] Error:", error);
  process.exit(1);
});
