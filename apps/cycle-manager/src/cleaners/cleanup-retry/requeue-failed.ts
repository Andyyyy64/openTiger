import { db } from "@openTiger/db";
import { tasks, runs } from "@openTiger/db/schema";
import {
  FAILURE_CODE,
  extractFailedCommandFromErrorMeta,
  extractOutsideAllowedViolationPaths,
  extractPolicyViolationsFromErrorMeta,
  isVerificationRecoveryFailureCode,
  loadPolicyRecoveryConfig,
  mergeUniquePaths,
  resolveCommandDrivenAllowedPaths,
  resolvePolicyViolationAutoAllowPaths,
  type VerificationRecoveryFailureCode,
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

const DEFAULT_REPEATED_FAILURE_SIGNATURE_THRESHOLD = 4;

function resolveRepeatedFailureSignatureThreshold(): number {
  const parsed = Number.parseInt(
    process.env.FAILED_TASK_REPEATED_SIGNATURE_THRESHOLD ??
      String(DEFAULT_REPEATED_FAILURE_SIGNATURE_THRESHOLD),
    10,
  );
  if (!Number.isFinite(parsed) || parsed < 2) {
    return DEFAULT_REPEATED_FAILURE_SIGNATURE_THRESHOLD;
  }
  return parsed;
}

export function extractFailedVerificationCommand(
  errorMessage: string | null | undefined,
  errorMeta?: unknown,
): string | null {
  const fromMeta = extractFailedCommandFromErrorMeta(errorMeta);
  if (fromMeta) {
    return fromMeta;
  }
  const raw = (errorMessage ?? "").trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(/verification failed at\s+(.+?)\s+\[/i);
  const command = match?.[1]?.trim();
  return command && command.length > 0 ? command : null;
}

export function resolveOutsideAllowedViolationPaths(
  errorMessage: string | null | undefined,
  errorMeta?: unknown,
): string[] {
  const structuredViolations = extractPolicyViolationsFromErrorMeta(errorMeta);
  if (structuredViolations.length > 0) {
    return extractOutsideAllowedViolationPaths(structuredViolations);
  }
  return extractOutsideAllowedViolationPaths(errorMessage);
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseArtifactPresenceCheckPath(command: string): string | null {
  const trimmed = command.trim();
  const match = trimmed.match(/^test\s+-(?:f|s)\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }
  const target = stripWrappingQuotes(match[1]);
  return target.length > 0 ? target : null;
}

const GENERATED_ARTIFACT_SEGMENTS = new Set([
  "artifact",
  "artifacts",
  "build",
  "debug",
  "dist",
  "out",
  "release",
  "target",
]);

function isLikelyGeneratedArtifactPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!normalized || normalized.includes("..") || normalized.includes("*")) {
    return false;
  }
  return normalized
    .split("/")
    .some((segment) => segment.length > 0 && GENERATED_ARTIFACT_SEGMENTS.has(segment));
}

function splitCommandTokens(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function isCleanLikeCommand(command: string): boolean {
  const trimmed = command.trim();
  const tokens = splitCommandTokens(trimmed);
  const first = tokens[0]?.toLowerCase();
  if (!first) {
    return false;
  }
  if (first === "make") {
    return tokens.slice(1).some((token) => /clean/i.test(token));
  }
  if (first === "npm" || first === "pnpm" || first === "yarn" || first === "bun") {
    return /\b(run\s+)?(clean|distclean|clobber)\b/i.test(tokens.slice(1).join(" "));
  }
  return false;
}

function sanitizeCommandsForVerificationFormatIssue(
  commands: string[],
  errorMessage: string | null | undefined,
  errorMeta?: unknown,
): string[] {
  if (commands.length === 0) {
    return [];
  }
  const failedCommand = extractFailedVerificationCommand(errorMessage, errorMeta);
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

export function sanitizeCommandsForVerificationSequenceIssue(
  commands: string[],
  errorMessage: string | null | undefined,
  errorMeta?: unknown,
): string[] | null {
  if (commands.length < 2) {
    return null;
  }
  const failedCommand = extractFailedVerificationCommand(errorMessage, errorMeta);
  if (!failedCommand) {
    return null;
  }
  const normalizedFailed = failedCommand.trim();
  const failedIndex = commands.findIndex((command) => command.trim() === normalizedFailed);
  if (failedIndex <= 0) {
    return null;
  }
  const artifactPath = parseArtifactPresenceCheckPath(normalizedFailed);
  if (!artifactPath || !isLikelyGeneratedArtifactPath(artifactPath)) {
    return null;
  }
  const previousCommand = commands[failedIndex - 1];
  if (!previousCommand || !isCleanLikeCommand(previousCommand)) {
    return null;
  }

  const reordered = [...commands];
  const [failedEntry] = reordered.splice(failedIndex, 1);
  if (!failedEntry) {
    return null;
  }
  reordered.splice(failedIndex - 1, 0, failedEntry);
  return reordered;
}

type VerificationRecoveryReason = VerificationRecoveryFailureCode;

type VerificationRecoveryAdjustment = {
  nextCommands: string[];
  reasonLabel: string;
  eventReason:
    | "verification_command_missing_script_adjusted"
    | "verification_command_missing_make_target_adjusted"
    | "verification_command_unsupported_format_adjusted"
    | "verification_command_sequence_adjusted";
  recoveryRule: "drop_failed_command" | "reorder_clean_and_artifact_check";
};

export function applyVerificationRecoveryAdjustment(params: {
  reason: VerificationRecoveryReason;
  commands: string[];
  errorMessage: string | null | undefined;
  errorMeta?: unknown;
}): VerificationRecoveryAdjustment | null {
  const strategies: Record<
    VerificationRecoveryReason,
    (
      commands: string[],
      errorMessage: string | null | undefined,
      errorMeta?: unknown,
    ) => VerificationRecoveryAdjustment | null
  > = {
    [FAILURE_CODE.VERIFICATION_COMMAND_MISSING_SCRIPT]: (commands, errorMessage, errorMeta) => ({
      nextCommands: sanitizeCommandsForVerificationFormatIssue(commands, errorMessage, errorMeta),
      reasonLabel: "missing verification script",
      eventReason: "verification_command_missing_script_adjusted",
      recoveryRule: "drop_failed_command",
    }),
    [FAILURE_CODE.VERIFICATION_COMMAND_MISSING_MAKE_TARGET]: (
      commands,
      errorMessage,
      errorMeta,
    ) => ({
      nextCommands: sanitizeCommandsForVerificationFormatIssue(commands, errorMessage, errorMeta),
      reasonLabel: "missing make target for verification command",
      eventReason: "verification_command_missing_make_target_adjusted",
      recoveryRule: "drop_failed_command",
    }),
    [FAILURE_CODE.VERIFICATION_COMMAND_UNSUPPORTED_FORMAT]: (
      commands,
      errorMessage,
      errorMeta,
    ) => ({
      nextCommands: sanitizeCommandsForVerificationFormatIssue(commands, errorMessage, errorMeta),
      reasonLabel: "unsupported verification command format",
      eventReason: "verification_command_unsupported_format_adjusted",
      recoveryRule: "drop_failed_command",
    }),
    [FAILURE_CODE.VERIFICATION_COMMAND_SEQUENCE_ISSUE]: (commands, errorMessage, errorMeta) => {
      const nextCommands = sanitizeCommandsForVerificationSequenceIssue(
        commands,
        errorMessage,
        errorMeta,
      );
      if (!nextCommands) {
        return null;
      }
      return {
        nextCommands,
        reasonLabel: "verification command sequence issue",
        eventReason: "verification_command_sequence_adjusted",
        recoveryRule: "reorder_clean_and_artifact_check",
      };
    },
  };

  const strategy = strategies[params.reason];
  if (!strategy) {
    return null;
  }
  const adjustment = strategy(params.commands, params.errorMessage, params.errorMeta);
  if (!adjustment) {
    return null;
  }
  if (adjustment.nextCommands.length === 0 && params.commands.length > 0) {
    return adjustment;
  }
  const unchanged =
    adjustment.nextCommands.length === params.commands.length &&
    adjustment.nextCommands.every((command, index) => command === params.commands[index]);
  if (unchanged) {
    return null;
  }
  return adjustment;
}

function resolvePolicyRecoveryRepoPath(): string {
  return process.env.LOCAL_REPO_PATH?.trim() || process.env.REPLAN_WORKDIR?.trim() || process.cwd();
}

// Requeue failed tasks (immediate, all)
export async function requeueFailedTasks(): Promise<number> {
  return requeueFailedTasksWithCooldown(0);
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
  const repeatedFailureSignatureThreshold = resolveRepeatedFailureSignatureThreshold();
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
        errorMeta: runs.errorMeta,
      })
      .from(runs)
      .where(and(eq(runs.taskId, task.id), inArray(runs.status, ["failed", "cancelled"])))
      .orderBy(desc(runs.startedAt))
      .limit(1);

    const failure = classifyFailure(latestRun?.errorMessage ?? null, latestRun?.errorMeta);
    const categoryRetryLimit = resolveCategoryRetryLimit(failure.category);
    const currentRetry = task.retryCount ?? 0;
    const nextRetryCount = currentRetry + 1;
    const globalRetryAllowed = isRetryAllowed(currentRetry);
    const categoryRetryAllowed = isCategoryRetryAllowed(currentRetry, categoryRetryLimit);
    const repeatedFailure = await hasRepeatedFailureSignature(
      task.id,
      latestRun?.errorMessage ?? null,
      latestRun?.errorMeta,
      repeatedFailureSignatureThreshold,
    );

    if (isVerificationRecoveryFailureCode(failure.reason)) {
      const adjustment = applyVerificationRecoveryAdjustment({
        reason: failure.reason,
        commands: task.commands ?? [],
        errorMessage: latestRun?.errorMessage ?? null,
        errorMeta: latestRun?.errorMeta,
      });

      if (adjustment) {
        await db
          .update(tasks)
          .set({
            status: "queued",
            blockReason: null,
            commands: adjustment.nextCommands,
            retryCount: nextRetryCount,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));
        await recordEvent({
          type: "task.requeued",
          entityType: "task",
          entityId: task.id,
          payload: {
            reason: adjustment.eventReason,
            recoveryRule: adjustment.recoveryRule,
            retryCount: nextRetryCount,
            previousCommands: task.commands ?? [],
            nextCommands: adjustment.nextCommands,
          },
        });
        console.log(
          `[Cleanup] Requeued failed task with adjusted commands: ${task.id} (${adjustment.reasonLabel})`,
        );
        requeued++;
        continue;
      }
    }

    if (failure.reason === FAILURE_CODE.POLICY_VIOLATION) {
      const outsideAllowedPaths = resolveOutsideAllowedViolationPaths(
        latestRun?.errorMessage,
        latestRun?.errorMeta,
      );
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
