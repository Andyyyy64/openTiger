import { db } from "@openTiger/db";
import { tasks, runs } from "@openTiger/db/schema";
import { eq, inArray, and, desc } from "drizzle-orm";
import { recordEvent } from "../../monitors/event-logger";
import { classifyFailure, hasRepeatedFailureSignature } from "./failure-classifier";
import { hasPendingJudgeRun, restoreLatestJudgeRun } from "./judge-recovery";
import {
  formatRetryLimitDisplay,
  isCategoryRetryAllowed,
  isRetryAllowed,
  resolveCategoryRetryLimit,
} from "./retry-policy";
import { isPrReviewTask } from "./task-context";
import type { BlockReason } from "./types";

function extractFailedVerificationCommand(errorMessage: string | null | undefined): string | null {
  const raw = (errorMessage ?? "").trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(/verification failed at\s+(.+?)\s+\[/i);
  const command = match?.[1]?.trim();
  return command && command.length > 0 ? command : null;
}

function sanitizeCommandsForMissingScript(
  commands: string[],
  errorMessage: string | null | undefined,
): string[] {
  if (commands.length === 0) {
    return [];
  }
  const failedCommand = extractFailedVerificationCommand(errorMessage);
  if (!failedCommand) {
    // 失敗コマンドを特定できない場合は explicit command を空にして自動検証へフォールバック
    return [];
  }
  const normalizedFailed = failedCommand.trim();
  const filtered = commands.filter((command) => command.trim() !== normalizedFailed);
  if (filtered.length === commands.length) {
    return [];
  }
  return filtered;
}

// 失敗したタスクを再キューイング（即時、全件）
export async function requeueFailedTasks(): Promise<number> {
  const result = await db
    .update(tasks)
    .set({ status: "queued", blockReason: null, updatedAt: new Date() })
    .where(eq(tasks.status, "failed"))
    .returning({ id: tasks.id });

  for (const task of result) {
    await recordEvent({
      type: "task.requeued",
      entityType: "task",
      entityId: task.id,
    });
  }

  return result.length;
}

// 失敗タスクをクールダウン後に再キュー（リトライ回数制限付き）
export async function requeueFailedTasksWithCooldown(
  cooldownMs: number = 2 * 60 * 1000, // デフォルト2分に短縮（自己復旧を早める）
): Promise<number> {
  const cutoff = new Date(Date.now() - cooldownMs);

  // 失敗したタスクを取得
  const failedTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      goal: tasks.goal,
      context: tasks.context,
      commands: tasks.commands,
      updatedAt: tasks.updatedAt,
      retryCount: tasks.retryCount,
    })
    .from(tasks)
    .where(eq(tasks.status, "failed"));

  if (failedTasks.length === 0) {
    return 0;
  }

  // クールダウン経過済みのタスクをフィルタ
  const eligibleTasks = failedTasks.filter((task) => {
    return task.updatedAt < cutoff;
  });

  if (eligibleTasks.length === 0) {
    return 0;
  }

  let requeued = 0;

  for (const task of eligibleTasks) {
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
          retryCount: (task.retryCount ?? 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      await recordEvent({
        type: "task.requeued",
        entityType: "task",
        entityId: task.id,
        payload: {
          reason: hasPendingRun
            ? "pr_review_failed_to_awaiting_judge"
            : "pr_review_failed_run_restored",
          runId: recoveredRunId,
        },
      });
      console.log(`[Cleanup] Routed failed PR-review task back to awaiting_judge: ${task.id}`);
      requeued++;
      continue;
    }

    const [latestRun] = await db
      .select({
        errorMessage: runs.errorMessage,
      })
      .from(runs)
      .where(and(eq(runs.taskId, task.id), inArray(runs.status, ["failed", "cancelled"])))
      .orderBy(desc(runs.startedAt))
      .limit(1);

    const failure = classifyFailure(latestRun?.errorMessage ?? null);
    const categoryRetryLimit = resolveCategoryRetryLimit(failure.category);
    const currentRetry = task.retryCount ?? 0;
    const nextRetryCount = currentRetry + 1;
    const globalRetryAllowed = isRetryAllowed(currentRetry);
    const categoryRetryAllowed = isCategoryRetryAllowed(currentRetry, categoryRetryLimit);
    const repeatedFailure = await hasRepeatedFailureSignature(
      task.id,
      latestRun?.errorMessage ?? null,
    );

    if (failure.reason === "verification_command_missing_script") {
      const adjustedCommands = sanitizeCommandsForMissingScript(
        task.commands ?? [],
        latestRun?.errorMessage ?? null,
      );
      await db
        .update(tasks)
        .set({
          status: "queued",
          blockReason: null,
          commands: adjustedCommands,
          retryCount: nextRetryCount,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));
      await recordEvent({
        type: "task.requeued",
        entityType: "task",
        entityId: task.id,
        payload: {
          reason: "verification_command_missing_script_adjusted",
          retryCount: nextRetryCount,
          previousCommands: task.commands ?? [],
          nextCommands: adjustedCommands,
        },
      });
      console.log(
        `[Cleanup] Requeued failed task with adjusted commands: ${task.id} (missing verification script)`,
      );
      requeued++;
      continue;
    }

    if (!globalRetryAllowed || !failure.retryable || !categoryRetryAllowed || repeatedFailure) {
      const blockReason: Extract<BlockReason, "needs_rework"> = repeatedFailure
        ? "needs_rework"
        : failure.blockReason;
      const blockDetailReason = repeatedFailure
        ? "repeated_same_failure_signature"
        : failure.reason;
      await db
        .update(tasks)
        .set({
          status: "blocked",
          blockReason,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      await recordEvent({
        // 再試行上限に達しても止めずに再作業へ切り替える
        type: "task.recovery_escalated",
        entityType: "task",
        entityId: task.id,
        payload: {
          category: failure.category,
          retryable: failure.retryable,
          retryCount: currentRetry,
          retryLimit: categoryRetryLimit < 0 ? null : categoryRetryLimit,
          retryLimitUnlimited: categoryRetryLimit < 0,
          reason: blockDetailReason,
          blockReason,
          globalRetryAllowed,
          categoryRetryAllowed,
          repeatedFailure,
        },
      });
      console.log(
        `[Cleanup] Escalated failed task ${task.id} (${failure.category}, retry=${currentRetry}/${formatRetryLimitDisplay(categoryRetryLimit)}, reason=${blockDetailReason})`,
      );
      continue;
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
        reason: "cooldown_retry",
        category: failure.category,
        retryCount: nextRetryCount,
      },
    });
    console.log(
      `[Cleanup] Requeued failed task: ${task.id} (${failure.category}, retry=${nextRetryCount}/${formatRetryLimitDisplay(categoryRetryLimit)})`,
    );
    requeued++;
  }

  return requeued;
}
