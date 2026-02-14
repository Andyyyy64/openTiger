import { db } from "@openTiger/db";
import { runs, artifacts } from "@openTiger/db/schema";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Task } from "@openTiger/core";
import { resolve } from "node:path";
import {
  DEFAULT_POLICY,
  getRepoMode,
  getLocalRepoPath,
  getLocalWorktreeRoot,
  applyRepoModePolicyOverrides,
} from "@openTiger/core";
import {
  checkoutRepository,
  createWorkBranch,
  checkoutExistingBranch,
  executeTask,
  commitAndPush,
  createTaskPR,
  ensureRemoteBaseBranch,
} from "./steps/index";
import { generateBranchName } from "./steps/branch";
import {
  buildPrFetchRefspecs,
  resolveBranchBaseRef,
  resolveTaskPrContext,
} from "./worker-task-context";
import {
  isNoCommitsBetweenError,
  isQuotaFailure,
  sanitizeRetryHint,
  validateExpectedFiles,
} from "./worker-task-helpers";
import { buildTaskLogPath, setTaskLogPath } from "./worker-logging";
import { finalizeTaskState } from "./worker-runner-state";
import {
  getRuntimeExecutorDisplayName,
  isExecutionTimeout,
  isConflictAutoFixTaskTitle,
  restoreExpectedBranchContext,
} from "./worker-runner-utils";
import { attachExistingPrArtifact } from "./worker-runner-artifacts";
import { runVerificationPhase } from "./worker-runner-verification";
import type { WorkerConfig, WorkerResult } from "./worker-runner-types";
import { recordContextDeltaFailure } from "./context/context-delta";
import { resolveResearchInstructionsPathFromTask } from "./research/instructions";
import { runResearchWorker } from "./research/runner";

export type { WorkerConfig, WorkerResult } from "./worker-runner-types";
const DEFAULT_LOG_DIR = resolve(import.meta.dirname, "../../../raw-logs");

// Main task execution
export async function runWorker(taskData: Task, config: WorkerConfig): Promise<WorkerResult> {
  const {
    agentId,
    role,
    workspacePath,
    repoUrl,
    baseBranch = "main",
    instructionsPath,
    model,
    policy = DEFAULT_POLICY,
    logPath,
  } = config;
  const repoMode = getRepoMode();
  const effectivePolicy = applyRepoModePolicyOverrides(policy);
  const taskPrContext = repoMode === "git" ? resolveTaskPrContext(taskData) : null;
  const shouldReturnConflictAutoFixToJudge =
    repoMode === "git" &&
    isConflictAutoFixTaskTitle(taskData.title) &&
    typeof taskPrContext?.number === "number";
  const verificationAllowedPaths = shouldReturnConflictAutoFixToJudge
    ? ["**"]
    : taskData.allowedPaths;

  const taskId = taskData.id;
  const isResearchTask = taskData.kind === "research";
  const effectiveInstructionsPath = isResearchTask
    ? resolveResearchInstructionsPathFromTask(taskData)
    : instructionsPath;
  const agentLabel = role === "tester" ? "Tester" : role === "docser" ? "Docser" : "Worker";

  console.log("=".repeat(60));
  console.log(`${agentLabel} ${agentId} starting task: ${taskData.title}`);
  console.log("=".repeat(60));
  if (taskPrContext) {
    console.log(
      `[Worker] Using PR context: #${taskPrContext.number}` +
        (taskPrContext.headRef ? ` (head=${taskPrContext.headRef})` : ""),
    );
  }

  // Create run record
  const runRecords = await db
    .insert(runs)
    .values({
      taskId,
      agentId,
      status: "running",
      logPath,
    })
    .returning();

  const runRecord = runRecords[0];
  if (!runRecord) {
    throw new Error("Failed to create run record");
  }

  const runId = runRecord.id;
  const logDir = process.env.OPENTIGER_LOG_DIR ?? DEFAULT_LOG_DIR;
  const taskLogPath = buildTaskLogPath(logDir, taskId, runId, agentId);
  setTaskLogPath(taskLogPath);
  await db.update(runs).set({ logPath: taskLogPath }).where(eq(runs.id, runId));

  let worktreeBasePath: string | undefined;
  let worktreePath: string | undefined;

  try {
    if (isResearchTask) {
      console.log("\n[Research] Running non-git research execution path...");
      return await runResearchWorker({
        task: taskData,
        runId,
        agentId,
        workspacePath,
        model,
        instructionsPath: effectiveInstructionsPath,
      });
    }

    const localBranchName = repoMode === "local" ? generateBranchName(agentId, taskId) : undefined;

    // Step 1: Checkout repository
    console.log("\n[1/7] Checking out repository...");
    const checkoutResult = await checkoutRepository({
      repoUrl,
      workspacePath,
      taskId,
      baseBranch,
      githubToken: process.env.GITHUB_TOKEN,
      repoMode,
      localRepoPath: getLocalRepoPath(),
      localWorktreeRoot: `${getLocalWorktreeRoot()}/${agentId}`,
      branchName: localBranchName,
      extraFetchRefs: buildPrFetchRefspecs(taskPrContext),
    });

    if (!checkoutResult.success) {
      throw new Error(checkoutResult.error);
    }

    const repoPath = checkoutResult.repoPath;
    worktreeBasePath = checkoutResult.baseRepoPath;
    worktreePath = checkoutResult.worktreePath;

    // Step 2: Create working branch
    let branchName: string;
    if (taskPrContext?.headRef) {
      console.log("\n[2/7] Checking out PR branch...");
      const branchResult = await checkoutExistingBranch({
        repoPath,
        branchName: taskPrContext.headRef,
        baseRef: resolveBranchBaseRef(taskPrContext, baseBranch),
      });

      if (!branchResult.success) {
        throw new Error(branchResult.error);
      }

      branchName = branchResult.branchName;
    } else if (repoMode === "local") {
      branchName = localBranchName ?? generateBranchName(agentId, taskId);
    } else {
      console.log("\n[2/7] Creating work branch...");
      const branchResult = await createWorkBranch({
        repoPath,
        agentId,
        taskId,
        baseRef: resolveBranchBaseRef(taskPrContext, baseBranch),
      });

      if (!branchResult.success) {
        throw new Error(branchResult.error);
      }

      branchName = branchResult.branchName;
    }

    // Record branch as artifact
    await db.insert(artifacts).values({
      runId,
      type: "branch",
      ref: branchName,
    });

    if (repoMode === "local" && worktreePath && worktreeBasePath) {
      await db.insert(artifacts).values({
        runId,
        type: "worktree",
        ref: worktreePath,
        metadata: {
          baseRepoPath: worktreeBasePath,
          worktreePath,
          baseBranch,
          branchName,
        },
      });
    }

    // Step 3: Execute task with selected LLM engine
    const runtimeExecutorDisplayName = getRuntimeExecutorDisplayName();
    console.log(`\n[3/7] Executing task with ${runtimeExecutorDisplayName}...`);
    const previousFailures = await db
      .select({
        status: runs.status,
        errorMessage: runs.errorMessage,
        agentId: runs.agentId,
      })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, taskId),
          ne(runs.id, runId),
          inArray(runs.status, ["failed", "cancelled"]),
          isNotNull(runs.finishedAt),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(3);
    const retryHints = previousFailures.map((row) => {
      const status = row.status === "cancelled" ? "cancelled" : "failed";
      const reason = sanitizeRetryHint(row.errorMessage ?? "No detailed error message").slice(
        0,
        240,
      );
      return `${status} on ${row.agentId}: ${reason}`;
    });

    let executeResult = await executeTask({
      repoPath,
      task: taskData,
      instructionsPath: effectiveInstructionsPath,
      model,
      retryHints,
      policy: effectivePolicy,
    });

    if (!executeResult.success) {
      const isTimeout = isExecutionTimeout(
        executeResult.openCodeResult.stderr,
        executeResult.openCodeResult.exitCode,
      );
      if (isTimeout) {
        // Proceed to verify; changes may exist even on timeout
        console.warn(
          `[Worker] ${runtimeExecutorDisplayName} timed out, but continuing to verify changes...`,
        );
      } else {
        throw new Error(executeResult.error);
      }
    }

    // If switched branch during execution, return to PR target branch before next steps
    await restoreExpectedBranchContext(repoPath, branchName, runtimeExecutorDisplayName);

    // Step 4: Verify expected files exist
    console.log("\n[4/7] Checking expected files...");
    const missingFiles = await validateExpectedFiles(repoPath, taskData);
    if (missingFiles.length > 0) {
      // Fallback to verification command to decide
      console.warn(`[Worker] Warning: Expected files not found: ${missingFiles.join(", ")}`);
      console.warn("[Worker] Continuing with verification commands...");
    }

    // Step 5: Verify changes
    const verificationPhaseResult = await runVerificationPhase({
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
      instructionsPath: effectiveInstructionsPath,
      model,
      retryHints,
      executeResult,
      runtimeExecutorDisplayName,
    });
    if (!verificationPhaseResult.success) {
      return verificationPhaseResult.result;
    }
    const verifyResult = verificationPhaseResult.verifyResult;
    executeResult = verificationPhaseResult.executeResult;

    if (verifyResult.changedFiles.length === 0) {
      console.log("\n[6/7] Skipping commit/PR...");
      if (shouldReturnConflictAutoFixToJudge && taskPrContext) {
        console.log(
          "[Worker] No repository diff detected for conflict autofix task. Returning task to Judge queue.",
        );

        const prUrl = await attachExistingPrArtifact({
          runId,
          prNumber: taskPrContext.number,
          repoUrl,
        });

        await finalizeTaskState({
          runId,
          taskId,
          agentId,
          runStatus: "success",
          taskStatus: "blocked",
          blockReason: "awaiting_judge",
          costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
          errorMessage:
            "Conflict autofix produced no diff; returned to judge for mergeability check.",
        });

        console.log("\n" + "=".repeat(60));
        console.log("Task completed: awaiting judge re-check.");
        console.log(`PR #${taskPrContext.number} will be re-evaluated.`);
        console.log("=".repeat(60));

        return {
          success: true,
          taskId,
          runId,
          prUrl,
        };
      }
      console.log(
        "[Worker] No repository diff detected after verification. Marking task as no-op success.",
      );

      await finalizeTaskState({
        runId,
        taskId,
        agentId,
        runStatus: "success",
        taskStatus: "done",
        blockReason: null,
        costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
      });

      console.log("\n" + "=".repeat(60));
      console.log("Task completed successfully (no-op).");
      console.log("No repository changes were required.");
      console.log("=".repeat(60));

      return {
        success: true,
        taskId,
        runId,
      };
    }

    // Step 6: Commit and push
    console.log("\n[6/7] Committing and pushing...");
    const commitResult = await commitAndPush({
      repoPath,
      branchName,
      task: taskData,
      changedFiles: verifyResult.changedFiles,
    });

    if (!commitResult.success) {
      throw new Error(commitResult.error);
    }

    if (!commitResult.committed) {
      console.log("\n[7/7] Skipping PR...");
      if (shouldReturnConflictAutoFixToJudge && taskPrContext) {
        console.log(
          "[Worker] Commit step produced no new commit for conflict autofix task. Returning task to Judge queue.",
        );

        const prUrl = await attachExistingPrArtifact({
          runId,
          prNumber: taskPrContext.number,
          repoUrl,
        });

        await finalizeTaskState({
          runId,
          taskId,
          agentId,
          runStatus: "success",
          taskStatus: "blocked",
          blockReason: "awaiting_judge",
          costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
          errorMessage:
            "Conflict autofix produced no additional commit; returned to judge for mergeability check.",
        });

        console.log("\n" + "=".repeat(60));
        console.log("Task completed: awaiting judge re-check.");
        console.log(`PR #${taskPrContext.number} will be re-evaluated.`);
        console.log("=".repeat(60));

        return {
          success: true,
          taskId,
          runId,
          prUrl,
        };
      }
      console.log("[Worker] Commit step produced no new commit. Marking task as no-op success.");

      await finalizeTaskState({
        runId,
        taskId,
        agentId,
        runStatus: "success",
        taskStatus: "done",
        blockReason: null,
        costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
      });

      console.log("\n" + "=".repeat(60));
      console.log("Task completed successfully (no-op after commit check).");
      console.log("No commit was created, so PR creation was skipped.");
      console.log("=".repeat(60));

      return {
        success: true,
        taskId,
        runId,
      };
    }

    // Record commit as artifact
    await db.insert(artifacts).values({
      runId,
      type: "commit",
      ref: branchName,
      metadata: {
        message: commitResult.commitMessage,
        files: verifyResult.changedFiles,
        stats: verifyResult.stats,
      },
    });

    // Step 7: Create PR
    console.log("\n[7/7] Creating PR...");
    // Guarantee base branch for empty repo
    if (repoMode === "git") {
      const baseResult = await ensureRemoteBaseBranch(repoPath, baseBranch, branchName);
      if (!baseResult.success) {
        throw new Error(baseResult.error ?? "Failed to ensure base branch on remote");
      }
    }
    const prResult = await createTaskPR({
      repoPath,
      branchName,
      task: taskData,
      baseBranch,
      changedFiles: verifyResult.changedFiles,
      stats: verifyResult.stats,
      verificationResults: verifyResult.commandResults.map((r) => ({
        command: r.command,
        success: r.success,
      })),
    });

    if (!prResult.success) {
      if (isNoCommitsBetweenError(prResult.error ?? "")) {
        console.warn(
          "[Worker] No commits between base/head at PR creation. Treating as no-op success.",
        );

        await finalizeTaskState({
          runId,
          taskId,
          agentId,
          runStatus: "success",
          taskStatus: "done",
          blockReason: null,
          costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
          errorMessage: "No commits between branches; PR creation skipped as no-op.",
        });

        return {
          success: true,
          taskId,
          runId,
        };
      }
      throw new Error(prResult.error);
    }

    // Record PR as artifact
    if (prResult.pr) {
      await db.insert(artifacts).values({
        runId,
        type: "pr",
        ref: String(prResult.pr.number),
        url: prResult.pr.url,
        metadata: {
          title: prResult.pr.title,
          state: prResult.pr.state,
        },
      });
    } else if (repoMode === "git") {
      // Record when pushed directly
      await db.insert(artifacts).values({
        runId,
        type: "commit",
        ref: baseBranch,
        metadata: {
          message: "Direct push to base branch (base branch did not exist)",
        },
      });
    }

    // If PR exists, set to awaiting Judge
    const needsReview = repoMode === "local" || Boolean(prResult.pr);
    const nextStatus = needsReview ? "blocked" : "done";
    await finalizeTaskState({
      runId,
      taskId,
      agentId,
      runStatus: "success",
      taskStatus: nextStatus,
      blockReason: needsReview ? "awaiting_judge" : null,
      costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
    });

    console.log("\n" + "=".repeat(60));
    console.log("Task completed successfully!");
    if (prResult.pr) {
      console.log(`PR: ${prResult.pr.url}`);
    } else {
      console.log(`Changes committed to ${branchName}`);
    }
    console.log("=".repeat(60));

    return {
      success: true,
      taskId,
      runId,
      prUrl: prResult.pr?.url,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await recordContextDeltaFailure({
      message: errorMessage,
    }).catch(() => undefined);
    const quotaFailure = isQuotaFailure(errorMessage);
    const nextTaskStatus: "failed" | "blocked" = quotaFailure ? "blocked" : "failed";
    const nextBlockReason = quotaFailure ? "quota_wait" : null;

    console.error("\n" + "=".repeat(60));
    console.error("Task failed:", errorMessage);
    if (quotaFailure) {
      console.warn(
        `[Worker] Quota failure detected. Parking task ${taskId} as blocked(quota_wait) for cooldown retry.`,
      );
    }
    console.error("=".repeat(60));

    await finalizeTaskState({
      runId,
      taskId,
      agentId,
      runStatus: "failed",
      taskStatus: nextTaskStatus,
      blockReason: nextBlockReason,
      errorMessage,
      errorMeta: {
        source: "execution",
        failureCode: quotaFailure ? "quota_failure" : "execution_failed",
      },
    });

    return {
      success: false,
      taskId,
      runId,
      error: errorMessage,
    };
  } finally {
    setTaskLogPath();
    if (repoMode === "local" && worktreeBasePath && worktreePath) {
      const { removeWorktree } = await import("@openTiger/vcs");
      await removeWorktree({
        baseRepoPath: worktreeBasePath,
        worktreePath,
      });
    }
  }
}
