import { db } from "@openTiger/db";
import { tasks, runs, artifacts, leases, agents } from "@openTiger/db/schema";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Task, Policy } from "@openTiger/core";
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
  executeTask,
  verifyChanges,
  commitAndPush,
  createTaskPR,
  ensureRemoteBaseBranch,
} from "./steps/index.js";
import { generateBranchName } from "./steps/branch.js";
import {
  buildPrFetchRefspecs,
  resolveBranchBaseRef,
  resolveTaskPrContext,
} from "./worker-task-context.js";
import {
  isNoCommitsBetweenError,
  isQuotaFailure,
  sanitizeRetryHint,
  shouldAllowNoChanges,
  validateExpectedFiles,
} from "./worker-task-helpers.js";
import { buildTaskLogPath, setTaskLogPath } from "./worker-logging.js";

// Workerの実行設定
export interface WorkerConfig {
  agentId: string;
  role?: string;
  workspacePath: string;
  repoUrl: string;
  baseBranch?: string;
  instructionsPath?: string;
  model?: string;
  policy?: Policy;
  logPath?: string;
}

// 実行結果
export interface WorkerResult {
  success: boolean;
  taskId: string;
  runId?: string;
  prUrl?: string;
  error?: string;
  costTokens?: number;
}

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

async function finalizeTaskState(options: FinalizeTaskStateOptions): Promise<void> {
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
    await tx
      .update(runs)
      .set(runUpdate)
      .where(eq(runs.id, options.runId));

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

// タスクを実行するメイン処理
export async function runWorker(
  taskData: Task,
  config: WorkerConfig
): Promise<WorkerResult> {
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

  const taskId = taskData.id;
  const agentLabel = role === "tester"
    ? "Tester"
    : role === "docser"
      ? "Docser"
      : "Worker";

  console.log("=".repeat(60));
  console.log(`${agentLabel} ${agentId} starting task: ${taskData.title}`);
  console.log("=".repeat(60));
  if (taskPrContext) {
    console.log(
      `[Worker] Using PR context: #${taskPrContext.number}` +
      (taskPrContext.headRef ? ` (head=${taskPrContext.headRef})` : "")
    );
  }

  // 実行レコードを作成する
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
  const logDir = process.env.OPENTIGER_LOG_DIR ?? "/tmp/openTiger-logs";
  const taskLogPath = buildTaskLogPath(logDir, taskId, runId, agentId);
  setTaskLogPath(taskLogPath);
  await db
    .update(runs)
    .set({ logPath: taskLogPath })
    .where(eq(runs.id, runId));

  let worktreeBasePath: string | undefined;
  let worktreePath: string | undefined;

  try {
    const localBranchName = repoMode === "local"
      ? generateBranchName(agentId, taskId)
      : undefined;

    // Step 1: リポジトリをチェックアウトする
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

    // Step 2: 作業用ブランチを作成する
    let branchName: string;
    if (repoMode === "local") {
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

    // ブランチを成果物として記録する
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

    // Step 3: OpenCodeでタスクを実行する
    console.log("\n[3/7] Executing task with OpenCode...");
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
          isNotNull(runs.finishedAt)
        )
      )
      .orderBy(desc(runs.startedAt))
      .limit(3);
    const retryHints = previousFailures
      .map((row) => {
        const status = row.status === "cancelled" ? "cancelled" : "failed";
        const reason = sanitizeRetryHint(row.errorMessage ?? "No detailed error message")
          .slice(0, 240);
        return `${status} on ${row.agentId}: ${reason}`;
      });

    const executeResult = await executeTask({
      repoPath,
      task: taskData,
      instructionsPath,
      model,
      retryHints,
      policy: effectivePolicy,
    });

    if (!executeResult.success) {
      const isTimeout = executeResult.openCodeResult.exitCode === -1
        && executeResult.openCodeResult.stderr.includes("[OpenCode] Timeout exceeded");
      if (isTimeout) {
        // タイムアウトでも変更がある可能性があるため検証へ進む
        console.warn("[Worker] OpenCode timed out, but continuing to verify changes...");
      } else {
        throw new Error(executeResult.error);
      }
    }

    // Step 4: 期待ファイルの存在を確認する
    console.log("\n[4/7] Checking expected files...");
    const missingFiles = await validateExpectedFiles(repoPath, taskData);
    if (missingFiles.length > 0) {
      // 期待ファイルがなくても検証コマンドで判断する
      console.warn(`[Worker] Warning: Expected files not found: ${missingFiles.join(", ")}`);
      console.warn("[Worker] Continuing with verification commands...");
    }

    // Step 5: 変更内容を検証する
    console.log("\n[5/7] Verifying changes...");
    const verifyResult = await verifyChanges({
      repoPath,
      commands: taskData.commands,
      allowedPaths: taskData.allowedPaths,
      policy: effectivePolicy,
      baseBranch,
      headBranch: branchName,
      // pnpm install による lockfile 変更を許容する
      allowLockfileOutsidePaths: true,
      // local mode では .env.example 作成を許容する
      allowEnvExampleOutsidePaths: repoMode === "local",
      allowNoChanges: shouldAllowNoChanges(taskData),
    });

    if (!verifyResult.success) {
      throw new Error(verifyResult.error);
    }

    if (verifyResult.changedFiles.length === 0) {
      console.log("\n[6/7] Skipping commit/PR...");
      console.log("[Worker] No repository diff detected after verification. Marking task as no-op success.");

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

    // Step 6: コミットして push する
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

    // コミットを成果物として記録する
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

    // Step 7: PRを作成する
    console.log("\n[7/7] Creating PR...");
    // 空リポジトリ対策でベースブランチを保証する
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
        console.warn("[Worker] No commits between base/head at PR creation. Treating as no-op success.");

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

    // PRを成果物として記録する
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
      // 直接 push した場合の記録
      await db.insert(artifacts).values({
        runId,
        type: "commit",
        ref: baseBranch,
        metadata: {
          message: "Direct push to base branch (base branch did not exist)",
        },
      });
    }

    // PRがある場合はJudge待ち状態にする
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
    const quotaFailure = isQuotaFailure(errorMessage);
    const nextTaskStatus: "failed" | "blocked" = quotaFailure ? "blocked" : "failed";
    const nextBlockReason = quotaFailure ? "quota_wait" : null;

    console.error("\n" + "=".repeat(60));
    console.error("Task failed:", errorMessage);
    if (quotaFailure) {
      console.warn(
        `[Worker] Quota failure detected. Parking task ${taskId} as blocked(quota_wait) for cooldown retry.`
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
