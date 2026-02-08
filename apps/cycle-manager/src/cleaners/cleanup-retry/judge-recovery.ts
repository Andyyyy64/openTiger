import { db } from "@openTiger/db";
import { runs, artifacts } from "@openTiger/db/schema";
import { eq, inArray, and, isNull, desc } from "drizzle-orm";

export async function hasPendingJudgeRun(taskId: string): Promise<boolean> {
  const pending = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.status, "success"), isNull(runs.judgedAt)))
    .limit(1);

  return pending.length > 0;
}

export async function restoreLatestJudgeRun(taskId: string): Promise<string | null> {
  const [latestRun] = await db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(artifacts, eq(artifacts.runId, runs.id))
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.status, "success"),
        inArray(artifacts.type, ["pr", "worktree"]),
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(1);

  if (!latestRun?.runId) {
    return null;
  }

  await db.update(runs).set({ judgedAt: null }).where(eq(runs.id, latestRun.runId));

  return latestRun.runId;
}
