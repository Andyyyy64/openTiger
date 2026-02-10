import { db } from "@openTiger/db";
import { tasks, runs, leases, agents } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";

interface FinalizeTaskStateOptions {
  runId: string;
  taskId: string;
  agentId: string;
  runStatus: "success" | "failed";
  taskStatus: "done" | "blocked" | "failed";
  blockReason: string | null;
  costTokens?: number | null;
  errorMessage?: string | null;
}

export async function finalizeTaskState(options: FinalizeTaskStateOptions): Promise<void> {
  const finishedAt = new Date();
  const updatedAt = new Date();
  const runUpdate: Partial<typeof runs.$inferInsert> = {
    status: options.runStatus,
    finishedAt,
  };
  if (options.costTokens !== undefined) {
    runUpdate.costTokens = options.costTokens;
  }
  if (options.errorMessage !== undefined) {
    runUpdate.errorMessage = options.errorMessage;
  }

  await db.transaction(async (tx) => {
    await tx.update(runs).set(runUpdate).where(eq(runs.id, options.runId));

    await tx
      .update(tasks)
      .set({
        status: options.taskStatus,
        blockReason: options.blockReason,
        updatedAt,
      })
      .where(eq(tasks.id, options.taskId));

    await tx.delete(leases).where(eq(leases.taskId, options.taskId));

    await tx
      .update(agents)
      .set({ status: "idle", currentTaskId: null })
      .where(eq(agents.id, options.agentId));
  });
}
