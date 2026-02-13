import { db } from "@openTiger/db";
import { artifacts, runs, tasks, events } from "@openTiger/db/schema";
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { JUDGE_AWAITING_RETRY_COOLDOWN_MS } from "./judge-config";

const JUDGE_ARTIFACT_TYPES: string[] = [
  "pr",
  "worktree",
  "research_claim",
  "research_source",
  "research_report",
];

export async function requeueTaskAfterJudge(params: {
  taskId: string;
  runId: string;
  agentId: string;
  reason: string;
}): Promise<void> {
  const { taskId, runId, agentId, reason } = params;

  const [task] = await db
    .select({ retryCount: tasks.retryCount })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const nextRetryCount = (task?.retryCount ?? 0) + 1;

  await db
    .update(tasks)
    .set({
      status: "queued",
      blockReason: null,
      retryCount: nextRetryCount,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  await db.insert(events).values({
    type: "judge.task_requeued",
    entityType: "task",
    entityId: taskId,
    agentId,
    payload: {
      runId,
      reason,
      retryCount: nextRetryCount,
    },
  });
}

export async function getTaskRetryCount(taskId: string): Promise<number> {
  const [task] = await db
    .select({ retryCount: tasks.retryCount })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  return task?.retryCount ?? 0;
}

export async function scheduleTaskForJudgeRetry(params: {
  taskId: string;
  runId: string;
  agentId: string;
  reason: string;
  restoreRunImmediately?: boolean;
}): Promise<void> {
  const { taskId, runId, agentId, reason, restoreRunImmediately = true } = params;
  const [task] = await db
    .select({ retryCount: tasks.retryCount })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const nextRetryCount = (task?.retryCount ?? 0) + 1;

  await db
    .update(tasks)
    .set({
      status: "blocked",
      blockReason: "awaiting_judge",
      retryCount: nextRetryCount,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  if (restoreRunImmediately) {
    await db
      .update(runs)
      .set({
        judgedAt: null,
      })
      .where(eq(runs.id, runId));
  }

  await db.insert(events).values({
    type: "judge.task_requeued",
    entityType: "task",
    entityId: taskId,
    agentId,
    payload: {
      runId,
      reason,
      retryCount: nextRetryCount,
    },
  });
}

export function isImportedPrReviewTask(goal: string, title: string): boolean {
  return goal.startsWith("Review and process open PR #") || title.startsWith("[PR] Review #");
}

export async function recoverAwaitingJudgeBacklog(agentId: string): Promise<number> {
  const cooldownMs =
    Number.isFinite(JUDGE_AWAITING_RETRY_COOLDOWN_MS) && JUDGE_AWAITING_RETRY_COOLDOWN_MS > 0
      ? JUDGE_AWAITING_RETRY_COOLDOWN_MS
      : 120000;
  const cutoff = new Date(Date.now() - cooldownMs);

  const stuckTasks = await db
    .select({
      id: tasks.id,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "blocked"),
        eq(tasks.blockReason, "awaiting_judge"),
        lte(tasks.updatedAt, cutoff),
      ),
    );

  if (stuckTasks.length === 0) {
    return 0;
  }

  let recovered = 0;
  for (const task of stuckTasks) {
    const [pendingRun] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.taskId, task.id), eq(runs.status, "success"), isNull(runs.judgedAt)))
      .limit(1);

    if (pendingRun?.id) {
      continue;
    }

    const [recoverableRun] = await db
      .select({
        runId: runs.id,
      })
      .from(runs)
      .innerJoin(artifacts, eq(artifacts.runId, runs.id))
      .where(
        and(
          eq(runs.taskId, task.id),
          eq(runs.status, "success"),
          inArray(artifacts.type, JUDGE_ARTIFACT_TYPES),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(1);

    if (!recoverableRun?.runId) {
      continue;
    }

    await db
      .update(runs)
      .set({
        judgedAt: null,
      })
      .where(eq(runs.id, recoverableRun.runId));

    await db.insert(events).values({
      type: "judge.task_recovered",
      entityType: "task",
      entityId: task.id,
      agentId,
      payload: {
        reason: "recover_awaiting_judge_run_restored",
        runId: recoverableRun.runId,
        cooldownMs,
      },
    });
    recovered += 1;
  }

  return recovered;
}

export async function claimRunForJudgement(runId: string): Promise<boolean> {
  const result = await db
    .update(runs)
    .set({
      judgedAt: new Date(),
      judgementVersion: sql`${runs.judgementVersion} + 1`,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "success"), isNull(runs.judgedAt)))
    .returning({ id: runs.id });

  return result.length > 0;
}
