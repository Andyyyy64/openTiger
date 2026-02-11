import { db } from "@openTiger/db";
import { tasks, runs, agents, leases } from "@openTiger/db/schema";
import { eq, not } from "drizzle-orm";
import { SYSTEM_ENTITY_ID } from "@openTiger/core";
import { recordEvent } from "../monitors/event-logger";
import { cleanupExpiredLeases } from "./cleanup-leases";
import { resetOfflineAgents } from "./cleanup-agents";

// Cleanup result
interface CleanupResult {
  leasesReleased: number;
  agentsReset: number;
  tasksReset: number;
  runsCancelled: number;
}

// Full cleanup on cycle end
export async function performFullCleanup(
  preserveTaskState: boolean = true,
): Promise<CleanupResult> {
  console.log("[Cleanup] Starting full cleanup...");

  // 1. Clean up expired leases
  const leasesReleased = await cleanupExpiredLeases();

  // 2. Release all leases
  const allLeases = await db.select().from(leases);
  if (allLeases.length > 0) {
    await db.delete(leases);
    console.log(`[Cleanup] Released ${allLeases.length} active leases`);
  }

  // 3. Reset offline agents
  const agentsReset = await resetOfflineAgents();

  // 4. Set all agents to idle
  await db
    .update(agents)
    .set({ status: "idle", currentTaskId: null })
    .where(not(eq(agents.status, "offline")));

  // 5. Reset running tasks
  let tasksReset = 0;
  if (!preserveTaskState) {
    // Revert all tasks to queued
    const result = await db
      .update(tasks)
      .set({ status: "queued", blockReason: null, updatedAt: new Date() })
      .where(eq(tasks.status, "running"))
      .returning({ id: tasks.id });
    tasksReset = result.length;
  } else {
    // Revert only running tasks to queued
    const result = await db
      .update(tasks)
      .set({ status: "queued", blockReason: null, updatedAt: new Date() })
      .where(eq(tasks.status, "running"))
      .returning({ id: tasks.id });
    tasksReset = result.length;
  }

  // 6. Cancel running runs
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
      `${result.runsCancelled} runs`,
  );

  await recordEvent({
    type: "cycle.cleanup",
    entityType: "cycle",
    entityId: SYSTEM_ENTITY_ID,
    payload: { ...result },
  });

  return result;
}
