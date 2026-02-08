import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { recordEvent } from "../../monitors/event-logger";
import { hasPendingJudgeRun, restoreLatestJudgeRun } from "./judge-recovery";
import { isPrReviewTask, normalizeBlockReason, normalizeContext } from "./task-context";

// blockedタスクをクールダウン後に再キュー（リトライ回数制限付き）
export async function requeueBlockedTasksWithCooldown(
  cooldownMs: number = 5 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - cooldownMs);

  const blockedTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      goal: tasks.goal,
      context: tasks.context,
      allowedPaths: tasks.allowedPaths,
      commands: tasks.commands,
      priority: tasks.priority,
      riskLevel: tasks.riskLevel,
      role: tasks.role,
      dependencies: tasks.dependencies,
      timeboxMinutes: tasks.timeboxMinutes,
      blockReason: tasks.blockReason,
      updatedAt: tasks.updatedAt,
      retryCount: tasks.retryCount,
    })
    .from(tasks)
    .where(eq(tasks.status, "blocked"));

  if (blockedTasks.length === 0) {
    return 0;
  }

  let handled = 0;

  for (const task of blockedTasks) {
    const reason = normalizeBlockReason(task.blockReason);
    const cooldownPassed = task.updatedAt < cutoff;
    // 復旧を止めないため、上限に関わらずcooldownだけで再処理する
    if (!cooldownPassed) {
      continue;
    }

    const nextRetryCount = (task.retryCount ?? 0) + 1;

    if (reason === "needs_rework") {
      if (
        isPrReviewTask({
          title: task.title,
          goal: task.goal,
          context: task.context,
        })
      ) {
        const hasPendingRun = await hasPendingJudgeRun(task.id);
        let recoveredRunId: string | null = null;
        if (!hasPendingRun) {
          recoveredRunId = await restoreLatestJudgeRun(task.id);
        }

        await db
          .update(tasks)
          .set({
            status: "blocked",
            blockReason: "awaiting_judge",
            retryCount: nextRetryCount,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));

        await recordEvent({
          type: "task.requeued",
          entityType: "task",
          entityId: task.id,
          payload: {
            reason: hasPendingRun
              ? "pr_review_needs_rework_to_awaiting_judge"
              : "pr_review_needs_rework_run_restored",
            runId: recoveredRunId,
            retryCount: nextRetryCount,
          },
        });
        console.log(`[Cleanup] Routed blocked PR-review task back to awaiting_judge: ${task.id}`);
        handled++;
        continue;
      }

      // needs_rework は親タスクをfailed化し、分割した再作業タスクを自動生成する
      const context = normalizeContext(task.context);
      const notes = context.notes
        ? `${context.notes}\n[auto-rework] parentTask=${task.id}`
        : `[auto-rework] parentTask=${task.id}`;

      const [reworkTask] = await db
        .insert(tasks)
        .values({
          title: task.title.startsWith("[Rework]") ? task.title : `[Rework] ${task.title}`,
          goal: task.goal,
          context: {
            ...context,
            notes,
          },
          allowedPaths: task.allowedPaths ?? [],
          commands: task.commands ?? [],
          priority: (task.priority ?? 0) + 5,
          riskLevel: task.riskLevel ?? "medium",
          role: task.role ?? "worker",
          dependencies: task.dependencies ?? [],
          timeboxMinutes: Math.max(30, Math.floor((task.timeboxMinutes ?? 60) * 0.8)),
          status: "queued",
          blockReason: null,
        })
        .returning({ id: tasks.id });

      await db
        .update(tasks)
        .set({
          status: "failed",
          blockReason: null,
          retryCount: nextRetryCount,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      if (reworkTask) {
        await recordEvent({
          type: "task.split",
          entityType: "task",
          entityId: task.id,
          payload: {
            reason: "needs_rework",
            reworkTaskId: reworkTask.id,
            retryCount: nextRetryCount,
          },
        });
        console.log(`[Cleanup] Created rework task ${reworkTask.id} from blocked task ${task.id}`);
      }
      handled++;
      continue;
    }

    if (reason === "awaiting_judge") {
      if (await hasPendingJudgeRun(task.id)) {
        // Judge未処理の成功Runが残っている間は再実行しない
        continue;
      }
      const recoveredRunId = await restoreLatestJudgeRun(task.id);
      if (recoveredRunId) {
        await db
          .update(tasks)
          .set({
            status: "blocked",
            blockReason: "awaiting_judge",
            retryCount: nextRetryCount,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));

        await recordEvent({
          type: "task.requeued",
          entityType: "task",
          entityId: task.id,
          payload: {
            reason: "awaiting_judge_run_restored",
            runId: recoveredRunId,
            retryCount: nextRetryCount,
          },
        });
        console.log(`[Cleanup] Restored awaiting_judge run for task: ${task.id}`);
        handled++;
        continue;
      }
    }

    await db
      .update(tasks)
      .set({
        status: "queued",
        blockReason: null,
        retryCount: nextRetryCount,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));

    await recordEvent({
      type: "task.requeued",
      entityType: "task",
      entityId: task.id,
      payload: {
        reason:
          reason === "awaiting_judge"
            ? "awaiting_judge_timeout_retry"
            : reason === "quota_wait"
              ? "quota_wait_retry"
              : "blocked_cooldown_retry",
        retryCount: nextRetryCount,
      },
    });
    console.log(`[Cleanup] Requeued blocked task: ${task.id}`);
    handled++;
  }

  return handled;
}
