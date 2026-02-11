import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import type { Policy, Task } from "@openTiger/core";
import { eq } from "drizzle-orm";
import { executeTask, verifyChanges, type ExecuteResult, type VerifyResult } from "./steps/index";
import { shouldAllowNoChanges } from "./worker-task-helpers";
import { finalizeTaskState } from "./worker-runner-state";
import {
  appendContextNotes,
  buildVerifyRecoveryHint,
  encodeVerifyReworkMarker,
  isExecutionTimeout,
  parseRecoveryAttempts,
  restoreExpectedBranchContext,
  shouldAttemptVerifyRecovery,
  summarizeVerificationFailure,
} from "./worker-runner-utils";
import type { WorkerResult } from "./worker-runner-types";

interface RunVerificationPhaseOptions {
  repoPath: string;
  taskData: Task;
  taskId: string;
  runId: string;
  agentId: string;
  branchName: string;
  baseBranch: string;
  repoMode: "git" | "local";
  verificationAllowedPaths: string[];
  effectivePolicy: Policy;
  instructionsPath?: string;
  model?: string;
  retryHints: string[];
  executeResult: ExecuteResult;
  runtimeExecutorDisplayName: string;
}

type VerificationPhaseResult =
  | {
      success: true;
      verifyResult: VerifyResult;
      executeResult: ExecuteResult;
    }
  | {
      success: false;
      result: WorkerResult;
    };

function shouldEnableNoChangeVerificationFallback(): boolean {
  const mode = (process.env.WORKER_NO_CHANGE_CONFIRM_MODE ?? "verify").trim().toLowerCase();
  if (!mode) {
    return true;
  }
  return !["off", "false", "strict", "disabled", "none"].includes(mode);
}

function hasMeaningfulVerificationPass(verifyResult: VerifyResult): boolean {
  return verifyResult.commandResults.some((result) => result.outcome === "passed");
}

export async function runVerificationPhase(
  options: RunVerificationPhaseOptions,
): Promise<VerificationPhaseResult> {
  const {
    repoPath,
    taskData,
    taskId,
    runId,
    agentId,
    branchName,
    baseBranch,
    repoMode,
    verificationAllowedPaths,
    effectivePolicy,
    instructionsPath,
    model,
    retryHints,
    runtimeExecutorDisplayName,
  } = options;
  let executeResult = options.executeResult;

  console.log("\n[5/7] Verifying changes...");
  let verifyResult = await verifyChanges({
    repoPath,
    commands: taskData.commands,
    allowedPaths: verificationAllowedPaths,
    policy: effectivePolicy,
    baseBranch,
    headBranch: branchName,
    // pnpm install による lockfile 変更を許容する
    allowLockfileOutsidePaths: true,
    // local mode では .env.example 作成を許容する
    allowEnvExampleOutsidePaths: repoMode === "local",
    allowNoChanges: shouldAllowNoChanges(taskData),
  });

  const isNoChangeFailure = (message: string | undefined): boolean => {
    const normalized = (message ?? "").toLowerCase();
    return (
      normalized.includes("no changes were made") ||
      normalized.includes("no relevant changes were made")
    );
  };

  // 変更なしで失敗した場合も同一プロセス内で自己修復を試みる
  if (!verifyResult.success && isNoChangeFailure(verifyResult.error)) {
    const rawAttempts = Number.parseInt(process.env.WORKER_NO_CHANGE_RECOVERY_ATTEMPTS ?? "1", 10);
    const noChangeRecoveryAttempts = Number.isFinite(rawAttempts) ? Math.max(0, rawAttempts) : 0;
    for (let attempt = 1; attempt <= noChangeRecoveryAttempts; attempt += 1) {
      const recoveryHint =
        "変更が検出されませんでした。タスクの目的を満たすための変更を必ず行ってください。";
      const recoveryHints = [recoveryHint, ...retryHints];
      console.warn(
        `[Worker] No changes detected; recovery attempt ${attempt}/${noChangeRecoveryAttempts}`,
      );
      executeResult = await executeTask({
        repoPath,
        task: taskData,
        instructionsPath,
        model,
        retryHints: recoveryHints,
        policy: effectivePolicy,
      });
      if (!executeResult.success) {
        continue;
      }
      verifyResult = await verifyChanges({
        repoPath,
        commands: taskData.commands,
        allowedPaths: verificationAllowedPaths,
        policy: effectivePolicy,
        baseBranch,
        headBranch: branchName,
        allowLockfileOutsidePaths: true,
        allowEnvExampleOutsidePaths: repoMode === "local",
        allowNoChanges: shouldAllowNoChanges(taskData),
      });
      if (verifyResult.success) {
        break;
      }
    }
  }

  // 差分ゼロでも検証コマンド実行で成立するケースを no-op 成功として扱う
  if (
    !verifyResult.success &&
    isNoChangeFailure(verifyResult.error) &&
    shouldEnableNoChangeVerificationFallback() &&
    (taskData.commands?.length ?? 0) > 0
  ) {
    console.warn(
      "[Worker] No diff detected after recovery attempts; running no-change verification fallback.",
    );
    const fallbackVerifyResult = await verifyChanges({
      repoPath,
      commands: taskData.commands,
      allowedPaths: verificationAllowedPaths,
      policy: effectivePolicy,
      baseBranch,
      headBranch: branchName,
      allowLockfileOutsidePaths: true,
      allowEnvExampleOutsidePaths: repoMode === "local",
      allowNoChanges: true,
    });

    if (fallbackVerifyResult.success && hasMeaningfulVerificationPass(fallbackVerifyResult)) {
      console.log(
        "[Worker] No-change fallback verified successfully. Accepting no-op completion for this task.",
      );
      verifyResult = fallbackVerifyResult;
    } else if (!fallbackVerifyResult.success) {
      verifyResult = fallbackVerifyResult;
    } else {
      console.warn(
        "[Worker] No-change fallback skipped acceptance because no verification command produced a passing result.",
      );
    }
  }

  // allowedPaths違反は即失敗せず、同一プロセス内で自己修復を試みる
  if (!verifyResult.success && verifyResult.policyViolations.length > 0) {
    const rawAttempts = Number.parseInt(process.env.WORKER_POLICY_RECOVERY_ATTEMPTS ?? "1", 10);
    const policyRecoveryAttempts = Number.isFinite(rawAttempts) ? Math.max(0, rawAttempts) : 0;
    for (let attempt = 1; attempt <= policyRecoveryAttempts; attempt += 1) {
      const policyHint = `allowedPaths外の変更を取り除き、許可パスのみに修正を収めてください: ${verifyResult.policyViolations.join(", ")}`;
      const recoveryHints = [policyHint, ...retryHints];
      console.warn(
        `[Worker] Policy violations detected; recovery attempt ${attempt}/${policyRecoveryAttempts}`,
      );
      executeResult = await executeTask({
        repoPath,
        task: taskData,
        instructionsPath,
        model,
        retryHints: recoveryHints,
        policy: effectivePolicy,
      });
      if (!executeResult.success) {
        continue;
      }
      verifyResult = await verifyChanges({
        repoPath,
        commands: taskData.commands,
        allowedPaths: verificationAllowedPaths,
        policy: effectivePolicy,
        baseBranch,
        headBranch: branchName,
        allowLockfileOutsidePaths: true,
        allowEnvExampleOutsidePaths: repoMode === "local",
        allowNoChanges: shouldAllowNoChanges(taskData),
      });
      if (verifyResult.success) {
        break;
      }
    }
  }

  const verifyRecoveryAttempts = parseRecoveryAttempts("WORKER_VERIFY_RECOVERY_ATTEMPTS", 1);
  const allowExplicitVerifyRecovery =
    (process.env.WORKER_VERIFY_RECOVERY_ALLOW_EXPLICIT ?? "true").toLowerCase() !== "false";

  if (
    !verifyResult.success &&
    shouldAttemptVerifyRecovery(verifyResult, allowExplicitVerifyRecovery)
  ) {
    for (let attempt = 1; attempt <= verifyRecoveryAttempts; attempt += 1) {
      const failedCommand = verifyResult.failedCommand ?? "(unknown command)";
      const recoveryHint = buildVerifyRecoveryHint({
        verifyResult,
        attempt,
        maxAttempts: verifyRecoveryAttempts,
      });
      const recoveryHints = [recoveryHint, ...retryHints];
      console.warn(
        `[Worker] Verification failed at ${failedCommand}; recovery attempt ${attempt}/${verifyRecoveryAttempts}`,
      );
      executeResult = await executeTask({
        repoPath,
        task: taskData,
        instructionsPath,
        model,
        retryHints: recoveryHints,
        policy: effectivePolicy,
        verificationRecovery: {
          attempt,
          failedCommand,
          failedCommandSource: verifyResult.failedCommandSource,
          failedCommandStderr: verifyResult.failedCommandStderr,
        },
      });

      if (!executeResult.success) {
        const isTimeout = isExecutionTimeout(
          executeResult.openCodeResult.stderr,
          executeResult.openCodeResult.exitCode,
        );
        if (isTimeout) {
          console.warn(
            "[Worker] Verification recovery execution timed out; continuing to re-verify changes.",
          );
        } else {
          continue;
        }
      }

      await restoreExpectedBranchContext(repoPath, branchName, runtimeExecutorDisplayName);
      verifyResult = await verifyChanges({
        repoPath,
        commands: taskData.commands,
        allowedPaths: verificationAllowedPaths,
        policy: effectivePolicy,
        baseBranch,
        headBranch: branchName,
        allowLockfileOutsidePaths: true,
        allowEnvExampleOutsidePaths: repoMode === "local",
        allowNoChanges: shouldAllowNoChanges(taskData),
      });
      if (verifyResult.success) {
        break;
      }
      if (!shouldAttemptVerifyRecovery(verifyResult, allowExplicitVerifyRecovery)) {
        break;
      }
    }
  }

  if (!verifyResult.success) {
    if (verifyResult.policyViolations.length > 0) {
      const errorMessage =
        verifyResult.error ?? `Policy violations: ${verifyResult.policyViolations.join(", ")}`;
      console.warn("[Worker] Policy violations detected; deferring to rework flow.");
      await finalizeTaskState({
        runId,
        taskId,
        agentId,
        runStatus: "failed",
        taskStatus: "blocked",
        blockReason: "needs_rework",
        costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
        errorMessage,
      });
      return {
        success: false,
        result: {
          success: false,
          taskId,
          runId,
          error: errorMessage,
        },
      };
    }
    if (!verifyResult.failedCommand?.trim()) {
      throw new Error(verifyResult.error ?? "Verification commands failed");
    }
    const failedCommand = verifyResult.failedCommand ?? "(unknown command)";
    const failedSource = verifyResult.failedCommandSource ?? "explicit";
    const stderrSummary = summarizeVerificationFailure(
      verifyResult.failedCommandStderr ?? verifyResult.error,
    );
    const verifyMarker = encodeVerifyReworkMarker({
      failedCommand,
      failedCommandSource: failedSource,
      stderrSummary,
    });
    const existingNotes = taskData.context?.notes;
    const markerPrefix = "[verify-rework-json]";
    const hasVerifyMarker = existingNotes?.includes(markerPrefix) ?? false;
    const notesToAppend = hasVerifyMarker
      ? []
      : [
          "[verify-rework] Verification command failure requires focused rework.",
          `failed_command: ${failedCommand}`,
          `failed_source: ${failedSource}`,
          `failed_stderr: ${stderrSummary}`,
          verifyMarker,
        ];
    if (notesToAppend.length > 0) {
      const updatedContext = {
        ...taskData.context,
        notes: appendContextNotes(existingNotes, notesToAppend),
      };
      await db
        .update(tasks)
        .set({
          context: updatedContext,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
    }

    const errorMessage =
      verifyResult.error ??
      `Verification failed at ${failedCommand} [${failedSource}]: ${stderrSummary}`;
    console.warn("[Worker] Verification failure detected; deferring to rework flow.");
    await finalizeTaskState({
      runId,
      taskId,
      agentId,
      runStatus: "failed",
      taskStatus: "blocked",
      blockReason: "needs_rework",
      costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
      errorMessage,
    });
    return {
      success: false,
      result: {
        success: false,
        taskId,
        runId,
        error: errorMessage,
      },
    };
  }

  return {
    success: true,
    verifyResult,
    executeResult,
  };
}
