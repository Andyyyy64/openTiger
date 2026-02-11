import { db } from "@openTiger/db";
import { tasks, runs, leases, agents } from "@openTiger/db/schema";
import { and, eq, sql } from "drizzle-orm";

// Heartbeat interval (ms)
const HEARTBEAT_INTERVAL = 30000; // 30s

export async function recoverInterruptedAgentRuns(agentId: string): Promise<number> {
  const staleRuns = await db
    .select({
      runId: runs.id,
      taskId: runs.taskId,
    })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, "running")));

  if (staleRuns.length === 0) {
    return 0;
  }

  for (const run of staleRuns) {
    await db
      .update(runs)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        errorMessage: "Agent process restarted before task completion",
      })
      .where(eq(runs.id, run.runId));

    await db
      .update(tasks)
      .set({
        status: "queued",
        blockReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, run.taskId), eq(tasks.status, "running")));

    await db.delete(leases).where(eq(leases.taskId, run.taskId));
  }

  return staleRuns.length;
}

// Send heartbeat
export function startHeartbeat(agentId: string): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await db
        .update(agents)
        .set({
          lastHeartbeat: new Date(),
          // Only allow offline recovery; do not overwrite busy
          status: sql`CASE WHEN ${agents.status} = 'offline' THEN 'idle' ELSE ${agents.status} END`,
        })
        .where(eq(agents.id, agentId));
    } catch (error) {
      console.error(`[Heartbeat] Failed to send heartbeat for ${agentId}:`, error);
    }
  }, HEARTBEAT_INTERVAL);
}

export async function markAgentOffline(agentId: string): Promise<void> {
  await db
    .update(agents)
    .set({
      status: "offline",
      currentTaskId: null,
      lastHeartbeat: new Date(),
    })
    .where(eq(agents.id, agentId));
}
