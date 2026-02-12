import { db } from "@openTiger/db";
import { tasks, runs } from "@openTiger/db/schema";
import {
  extractOutsideAllowedViolationPaths,
  loadPolicyRecoveryConfig,
  mergeUniquePaths,
  resolveCommandDrivenAllowedPaths,
  resolvePolicyViolationAutoAllowPaths,
} from "@openTiger/core";
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

function sanitizeCommandsForVerificationFormatIssue(
  commands: string[],
  errorMessage: string | null | undefined,
): string[] {
  if (commands.length === 0) {
    return [];
  }
  const failedCommand = extractFailedVerificationCommand(errorMessage);
  if (!failedCommand) {
    // If failed command unknown, clear explicit command for auto-verify fallback
    return [];
  }
  const normalizedFailed = failedCommand.trim();
  const filtered = commands.filter((command) => command.trim() !== normalizedFailed);
  if (filtered.length === commands.length) {
    return [];
  }
  return filtered;
}

function resolvePolicyRecoveryRepoPath(): string {
  return process.env.LOCAL_REPO_PATH?.trim() || process.env.REPLAN_WORKDIR?.trim() || process.cwd();
}

// Requeue failed tasks (immediate, all)
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

// Requeue failed tasks after cooldown (with retry limit)
export async function requeueFailedTasksWithCooldown(
  cooldownMs: number = 2 * 60 * 1000, // Default 2min (faster self-recovery)
): Promise<number> {
  const cutoff = new Date(Date.now() - cooldownMs);

  // Fetch failed tasks
  const failedTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      goal: tasks.goal,
      context: tasks.context,
      commands: tasks.commands,
      allowedPaths: tasks.allowedPaths,
      role: tasks.role,
      updatedAt: tasks.updatedAt,
      retryCount: tasks.retryCount,
    })
    .from(tasks)
    .where(eq(tasks.status, "failed"));

  if (failedTasks.length === 0) {
    return 0;
  }

  // Filter tasks past cooldown
  const eligibleTasks = failedTasks.filter((task) => {
    return task.updatedAt < cutoff;
  });

  if (eligibleTasks.length === 0) {
    return 0;
  }

  const policyRecoveryConfig = await loadPolicyRecoveryConfig(resolvePolicyRecoveryRepoPath());
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

    if (
      failure.reason === "verification_command_missing_script" ||
      failure.reason === "verification_command_unsupported_format"
    ) {
      const adjustedCommands = sanitizeCommandsForVerificationFormatIssue(
        task.commands ?? [],
        latestRun?.errorMessage ?? null,
      );
      const reasonLabel =
        failure.reason === "verification_command_missing_script"
          ? "missing verification script"
          : "unsupported verification command format";
      const eventReason =
        failure.reason === "verification_command_missing_script"
          ? "verification_command_missing_script_adjusted"
          : "verification_command_unsupported_format_adjusted";
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
          reason: eventReason,
          retryCount: nextRetryCount,
          previousCommands: task.commands ?? [],
          nextCommands: adjustedCommands,
        },
      });
      console.log(
        `[Cleanup] Requeued failed task with adjusted commands: ${task.id} (${reasonLabel})`,
      );
      requeued++;
      continue;
    }

    if (failure.reason === "policy_violation") {
      const outsideAllowedPaths = extractOutsideAllowedViolationPaths(latestRun?.errorMessage);
      const autoAllowPaths = resolvePolicyViolationAutoAllowPaths(
        task,
        outsideAllowedPaths,
        policyRecoveryConfig,
      );
      const commandDrivenPaths = resolveCommandDrivenAllowedPaths(task, policyRecoveryConfig);
      const adjustedAllowedPaths = mergeUniquePaths(task.allowedPaths ?? [], [
        ...autoAllowPaths,
        ...commandDrivenPaths,
      ]);
      const addedAllowedPaths = adjustedAllowedPaths.filter(
        (path) => !(task.allowedPaths ?? []).includes(path),
      );
      if (addedAllowedPaths.length === 0) {
        // Continue to normal retry flow when no safe policy recovery candidate exists.
      } else {
        await db
          .update(tasks)
          .set({
            status: "queued",
            blockReason: null,
            allowedPaths: adjustedAllowedPaths,
            retryCount: nextRetryCount,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));
        await recordEvent({
          type: "task.requeued",
          entityType: "task",
          entityId: task.id,
          payload: {
            reason: "policy_allowed_paths_adjusted",
            retryCount: nextRetryCount,
            previousAllowedPaths: task.allowedPaths ?? [],
            nextAllowedPaths: adjustedAllowedPaths,
            addedAllowedPaths,
            policyViolationPaths: outsideAllowedPaths,
          },
        });
        console.log(
          `[Cleanup] Requeued failed task with adjusted allowed paths: ${task.id} (+${addedAllowedPaths.join(", ")})`,
        );
        requeued++;
        continue;
      }
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
        // Continue to rework even when retry limit reached
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
