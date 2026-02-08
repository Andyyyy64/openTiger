import { db } from "@openTiger/db";
import { tasks, runs, artifacts } from "@openTiger/db/schema";
import { eq, inArray, and, isNull, desc } from "drizzle-orm";
import { recordEvent } from "../monitors/event-logger";

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

type BlockReason = "awaiting_judge" | "needs_rework" | "quota_wait";

// 最大リトライ回数（-1で無制限。上限超過時は再作業へ切り替えて復旧を止めない）
const MAX_RETRY_COUNT = (() => {
  const parsed = Number.parseInt(process.env.FAILED_TASK_MAX_RETRY_COUNT ?? "-1", 10);
  return Number.isFinite(parsed) ? parsed : -1;
})();

type FailureCategory =
  | "env"
  | "setup"
  | "permission"
  | "noop"
  | "policy"
  | "test"
  | "flaky"
  | "model"
  | "model_loop";

type FailureClassification = {
  category: FailureCategory;
  retryable: boolean;
  reason: string;
  blockReason: Extract<BlockReason, "needs_rework">;
};

const CATEGORY_RETRY_LIMIT: Record<FailureCategory, number> = {
  env: 5,
  setup: 3,
  permission: 0,
  noop: 0,
  policy: 2,
  test: 2,
  flaky: 6,
  model: 2,
  model_loop: 1,
};

function isUnlimitedRetry(): boolean {
  return MAX_RETRY_COUNT < 0;
}

function isRetryAllowed(retryCount: number): boolean {
  return isUnlimitedRetry() || retryCount < MAX_RETRY_COUNT;
}

function resolveCategoryRetryLimit(category: FailureCategory): number {
  const categoryLimit = CATEGORY_RETRY_LIMIT[category];
  if (isUnlimitedRetry()) {
    // 無制限モードでも非リトライカテゴリは再作業へ切り替える判断材料として残す
    return categoryLimit <= 0 ? 0 : -1;
  }
  return Math.min(categoryLimit, MAX_RETRY_COUNT);
}

function isCategoryRetryAllowed(retryCount: number, categoryRetryLimit: number): boolean {
  return categoryRetryLimit < 0 || retryCount < categoryRetryLimit;
}

function formatRetryLimitDisplay(categoryRetryLimit: number): string {
  return categoryRetryLimit < 0 ? "inf" : String(categoryRetryLimit);
}

function classifyFailure(errorMessage: string | null): FailureClassification {
  const message = (errorMessage ?? "").toLowerCase();

  if (
    /external_directory permission prompt|permission required:\s*external_directory/.test(message)
  ) {
    return {
      category: "permission",
      retryable: false,
      reason: "external_directory_permission_prompt",
      blockReason: "needs_rework",
    };
  }

  if (
    /no changes were made|no relevant changes were made|no commits between/.test(message)
  ) {
    return {
      category: "noop",
      retryable: false,
      reason: "no_actionable_changes",
      blockReason: "needs_rework",
    };
  }

  if (
    /policy violation|denied command|outside allowed paths|change to denied path/.test(message)
  ) {
    return {
      category: "policy",
      retryable: true,
      reason: "policy_violation",
      blockReason: "needs_rework",
    };
  }

  if (
    /package\.json|pnpm-workspace\.yaml|cannot find module|enoent|command not found|repository not found|authentication failed|permission denied|no commits between|no history in common/.test(
      message
    )
  ) {
    return {
      category: "setup",
      retryable: true,
      reason: "setup_or_bootstrap_issue",
      blockReason: "needs_rework",
    };
  }

  if (/database_url|redis_url|connection refused|dns|env/.test(message)) {
    return {
      category: "env",
      retryable: true,
      reason: "environment_issue",
      blockReason: "needs_rework",
    };
  }

  if (/vitest|playwright|assert|expected|test failed|verification commands failed/.test(message)) {
    return {
      category: "test",
      retryable: true,
      reason: "test_failure",
      blockReason: "needs_rework",
    };
  }

  if (
    /rate limit|429|503|502|timeout|timed out|econnreset|eai_again|temporarily unavailable/.test(
      message
    )
  ) {
    return {
      category: "flaky",
      retryable: true,
      reason: "transient_or_flaky_failure",
      blockReason: "needs_rework",
    };
  }

  if (
    /doom loop detected|excessive planning chatter detected|unsupported pseudo tool call detected: todo/.test(
      message
    )
  ) {
    return {
      category: "model_loop",
      retryable: true,
      reason: "model_doom_loop",
      blockReason: "needs_rework",
    };
  }

  return {
    category: "model",
    retryable: true,
    reason: "model_or_unknown_failure",
    blockReason: "needs_rework",
  };
}

function normalizeBlockReason(reason: string | null): BlockReason | null {
  if (reason === "needs_human") {
    // legacy互換: needs_humanはawaiting_judgeとして回収する
    return "awaiting_judge";
  }
  if (
    reason === "awaiting_judge"
    || reason === "needs_rework"
    || reason === "quota_wait"
  ) {
    return reason;
  }
  return null;
}

function normalizeContext(
  context: unknown
): {
  files?: string[];
  specs?: string;
  notes?: string;
  pr?: { number: number; url?: string; title?: string };
  issue?: { number: number; url?: string; title?: string };
} {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return {};
  }
  return context as {
    files?: string[];
    specs?: string;
    notes?: string;
    pr?: { number: number; url?: string; title?: string };
    issue?: { number: number; url?: string; title?: string };
  };
}

function isPrReviewTask(params: {
  title: string;
  goal: string;
  context: unknown;
}): boolean {
  if (params.goal.startsWith("Review and process open PR #")) {
    return true;
  }
  if (params.title.includes("[PR] Review #")) {
    return true;
  }
  const context = normalizeContext(params.context);
  if (typeof context.pr?.number === "number") {
    return true;
  }
  if (typeof context.issue?.number === "number" && params.title.includes("[PR]")) {
    return true;
  }
  return context.notes?.includes("Imported from open GitHub PR backlog") === true;
}

function normalizeFailureSignature(errorMessage: string | null): string {
  return (errorMessage ?? "")
    .toLowerCase()
    .replace(/\x1B\[[0-9;]*m/g, "")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>")
    .replace(/\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

async function hasRepeatedFailureSignature(
  taskId: string,
  latestErrorMessage: string | null,
  threshold = 3
): Promise<boolean> {
  if (threshold <= 1) {
    return true;
  }

  const latestSignature = normalizeFailureSignature(latestErrorMessage);
  if (!latestSignature) {
    return false;
  }

  const recentRuns = await db
    .select({ errorMessage: runs.errorMessage })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, ["failed", "cancelled"])))
    .orderBy(desc(runs.startedAt))
    .limit(threshold);

  if (recentRuns.length < threshold) {
    return false;
  }

  return recentRuns.every(
    (run) => normalizeFailureSignature(run.errorMessage) === latestSignature
  );
}

async function hasPendingJudgeRun(taskId: string): Promise<boolean> {
  const pending = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.status, "success"),
        isNull(runs.judgedAt)
      )
    )
    .limit(1);

  return pending.length > 0;
}

async function restoreLatestJudgeRun(taskId: string): Promise<string | null> {
  const [latestRun] = await db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(artifacts, eq(artifacts.runId, runs.id))
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.status, "success"),
        inArray(artifacts.type, ["pr", "worktree"])
      )
    )
    .orderBy(desc(runs.startedAt))
    .limit(1);

  if (!latestRun?.runId) {
    return null;
  }

  await db
    .update(runs)
    .set({ judgedAt: null })
    .where(eq(runs.id, latestRun.runId));

  return latestRun.runId;
}

// 失敗タスクをクールダウン後に再キュー（リトライ回数制限付き）
export async function requeueFailedTasksWithCooldown(
  cooldownMs: number = 2 * 60 * 1000 // デフォルト2分に短縮（自己復旧を早める）
): Promise<number> {
  const cutoff = new Date(Date.now() - cooldownMs);

  // 失敗したタスクを取得
  const failedTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      goal: tasks.goal,
      context: tasks.context,
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
      .where(
        and(
          eq(runs.taskId, task.id),
          inArray(runs.status, ["failed", "cancelled"])
        )
      )
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
      latestRun?.errorMessage ?? null
    );

    if (
      !globalRetryAllowed
      || !failure.retryable
      || !categoryRetryAllowed
      || repeatedFailure
    ) {
      const blockReason: Extract<BlockReason, "needs_rework"> = repeatedFailure
        ? "needs_rework"
        : failure.blockReason;
      const blockDetailReason = repeatedFailure ? "repeated_same_failure_signature" : failure.reason;
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
        `[Cleanup] Escalated failed task ${task.id} (${failure.category}, retry=${currentRetry}/${formatRetryLimitDisplay(categoryRetryLimit)}, reason=${blockDetailReason})`
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
      `[Cleanup] Requeued failed task: ${task.id} (${failure.category}, retry=${nextRetryCount}/${formatRetryLimitDisplay(categoryRetryLimit)})`
    );
    requeued++;
  }

  return requeued;
}

// blockedタスクをクールダウン後に再キュー（リトライ回数制限付き）
export async function requeueBlockedTasksWithCooldown(
  cooldownMs: number = 5 * 60 * 1000
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
        console.log(
          `[Cleanup] Routed blocked PR-review task back to awaiting_judge: ${task.id}`
        );
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
          title: task.title.startsWith("[Rework]")
            ? task.title
            : `[Rework] ${task.title}`,
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
        console.log(
          `[Cleanup] Created rework task ${reworkTask.id} from blocked task ${task.id}`
        );
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
        reason: reason === "awaiting_judge"
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
