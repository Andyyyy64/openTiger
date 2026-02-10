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
  checkoutExistingBranch,
  executeTask,
  verifyChanges,
  commitAndPush,
  createTaskPR,
  ensureRemoteBaseBranch,
  type VerifyResult,
} from "./steps/index";
import { checkoutBranch, getCurrentBranch } from "@openTiger/vcs";
import { generateBranchName } from "./steps/branch";
import type { VerificationCommandSource } from "./steps/verify/types";
import {
  buildPrFetchRefspecs,
  resolveBranchBaseRef,
  resolveTaskPrContext,
} from "./worker-task-context";
import {
  isNoCommitsBetweenError,
  isQuotaFailure,
  sanitizeRetryHint,
  shouldAllowNoChanges,
  validateExpectedFiles,
} from "./worker-task-helpers";
import { buildTaskLogPath, setTaskLogPath } from "./worker-logging";

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

function isClaudeExecutorValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

function getRuntimeExecutorDisplayName(): string {
  return isClaudeExecutorValue(process.env.LLM_EXECUTOR) ? "Claude Code" : "OpenCode";
}

function isExecutionTimeout(stderr: string, exitCode: number): boolean {
  return (
    exitCode === -1 &&
    (stderr.includes("[OpenCode] Timeout exceeded") ||
      stderr.includes("[ClaudeCode] Timeout exceeded"))
  );
}

function parseRecoveryAttempts(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, parsed);
}

function summarizeVerificationFailure(stderr: string | undefined, maxChars = 400): string {
  const normalized = sanitizeRetryHint(stderr ?? "");
  if (!normalized) {
    return "stderr unavailable";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function shouldAttemptVerifyRecovery(
  verifyResult: VerifyResult,
  allowExplicitRecovery: boolean,
): boolean {
  if (verifyResult.success || verifyResult.policyViolations.length > 0) {
    return false;
  }
  const failedCommand = verifyResult.failedCommand?.trim();
  if (!failedCommand) {
    return false;
  }
  const source = verifyResult.failedCommandSource ?? "explicit";
  if (source === "auto") {
    return true;
  }
  if (!allowExplicitRecovery) {
    return false;
  }
  return source === "explicit" || source === "light-check" || source === "guard";
}

function buildVerifyRecoveryHint(params: {
  verifyResult: VerifyResult;
  attempt: number;
  maxAttempts: number;
}): string {
  const command = params.verifyResult.failedCommand ?? "(unknown command)";
  const sourceLabel = params.verifyResult.failedCommandSource
    ? ` [${params.verifyResult.failedCommandSource}]`
    : "";
  const stderrSummary = summarizeVerificationFailure(params.verifyResult.failedCommandStderr);
  return (
    `検証失敗を優先して復旧してください（${params.attempt}/${params.maxAttempts}）: ` +
    `${command}${sourceLabel} が失敗。` +
    `stderr: ${stderrSummary}. ` +
    "最小限の修正で失敗コマンドが通る状態にしてください。"
  );
}

function encodeVerifyReworkMarker(payload: {
  failedCommand: string;
  failedCommandSource?: VerificationCommandSource;
  stderrSummary: string;
}): string {
  const encoded = encodeURIComponent(
    JSON.stringify({
      failedCommand: payload.failedCommand,
      failedCommandSource: payload.failedCommandSource ?? "explicit",
      stderrSummary: payload.stderrSummary,
    }),
  );
  return `[verify-rework-json]${encoded}`;
}

function appendContextNotes(existingNotes: string | undefined, lines: string[]): string {
  const base = existingNotes?.trim();
  const additions = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  if (!base) {
    return additions;
  }
  if (!additions) {
    return base;
  }
  return `${base}\n${additions}`;
}

async function restoreExpectedBranchContext(
  repoPath: string,
  expectedBranch: string,
  executorDisplayName: string,
): Promise<void> {
  const currentBranch = await getCurrentBranch(repoPath);
  if (currentBranch === expectedBranch) {
    return;
  }
  console.warn(
    `[Worker] Branch drift detected after ${executorDisplayName} execution: current=${currentBranch ?? "unknown"}, expected=${expectedBranch}`,
  );
  const restoreBranchResult = await checkoutBranch(repoPath, expectedBranch);
  if (!restoreBranchResult.success) {
    throw new Error(
      `Failed to restore expected branch ${expectedBranch}: ${restoreBranchResult.stderr}`,
    );
  }
  console.log(`[Worker] Restored branch context to ${expectedBranch}`);
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
    await tx.update(runs).set(runUpdate).where(eq(runs.id, options.runId));

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

function isConflictAutoFixTaskTitle(title: string): boolean {
  return /^\[AutoFix-Conflict\]\s+PR\s+#\d+/i.test(title.trim());
}

function buildGitHubPrUrl(repoUrl: string, prNumber: number): string | undefined {
  try {
    const normalizedRepoUrl = repoUrl.startsWith("git@github.com:")
      ? repoUrl.replace("git@github.com:", "https://github.com/")
      : repoUrl;
    const parsed = new URL(normalizedRepoUrl);
    if (!parsed.hostname.toLowerCase().includes("github.com")) {
      return undefined;
    }
    const parts = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    const owner = parts[0];
    const repo = parts[1]?.replace(/\.git$/i, "");
    if (!owner || !repo) {
      return undefined;
    }
    return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  } catch {
    return undefined;
  }
}

async function attachExistingPrArtifact(params: {
  runId: string;
  prNumber: number;
  repoUrl: string;
}): Promise<string | undefined> {
  const prUrl = buildGitHubPrUrl(params.repoUrl, params.prNumber);
  await db.insert(artifacts).values({
    runId: params.runId,
    type: "pr",
    ref: String(params.prNumber),
    url: prUrl,
    metadata: {
      source: "existing_pr_context",
      reused: true,
    },
  });
  return prUrl;
}

// タスクを実行するメイン処理
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
  await db.update(runs).set({ logPath: taskLogPath }).where(eq(runs.id, runId));

  let worktreeBasePath: string | undefined;
  let worktreePath: string | undefined;

  try {
    const localBranchName = repoMode === "local" ? generateBranchName(agentId, taskId) : undefined;

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

    // Step 3: 選択中のLLM実行エンジンでタスクを実行する
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
      instructionsPath,
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
        // タイムアウトでも変更がある可能性があるため検証へ進む
        console.warn(
          `[Worker] ${runtimeExecutorDisplayName} timed out, but continuing to verify changes...`,
        );
      } else {
        throw new Error(executeResult.error);
      }
    }

    // 実行中に別ブランチへ移動した場合は、PR対象ブランチへ戻してから後続処理を行う
    await restoreExpectedBranchContext(repoPath, branchName, runtimeExecutorDisplayName);

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
      const rawAttempts = Number.parseInt(
        process.env.WORKER_NO_CHANGE_RECOVERY_ATTEMPTS ?? "1",
        10,
      );
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
          taskId,
          runId,
          error: errorMessage,
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
          ...(taskData.context ?? {}),
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
        taskId,
        runId,
        error: errorMessage,
      };
    }

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
