import { db } from "@openTiger/db";
import { tasks, runs, artifacts, leases, agents } from "@openTiger/db/schema";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Task, Policy } from "@openTiger/core";
import {
  DEFAULT_POLICY,
  getRepoMode,
  getLocalRepoPath,
  getLocalWorktreeRoot,
  applyRepoModePolicyOverrides,
} from "@openTiger/core";
import "dotenv/config";
import {
  createTaskWorker,
  getTaskQueueName,
  type TaskJobData,
} from "@openTiger/queue";
import type { Job } from "bullmq";
import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { access, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

// Heartbeat interval (milliseconds)
const HEARTBEAT_INTERVAL = 30000; // 30秒

const logStreams = new Set<ReturnType<typeof createWriteStream>>();
let taskLogStream: ReturnType<typeof createWriteStream> | null = null;
const activeTaskIds = new Set<string>();

interface TaskRuntimeLock {
  path: string;
  handle: FileHandle;
}

function resolveTaskLockDir(): string {
  return process.env.OPENTIGER_TASK_LOCK_DIR ?? "/tmp/openTiger-task-locks";
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function acquireTaskRuntimeLock(taskId: string): Promise<TaskRuntimeLock | null> {
  const lockDir = resolveTaskLockDir();
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, `${taskId}.lock`);

  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(
      JSON.stringify(
        {
          taskId,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf-8"
    );
    return { path: lockPath, handle };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const raw = await readFile(lockPath, "utf-8");
        const parsed = JSON.parse(raw) as { pid?: number };
        if (typeof parsed.pid === "number" && !isPidAlive(parsed.pid)) {
          await rm(lockPath, { force: true });
          return acquireTaskRuntimeLock(taskId);
        }
      } catch {
        // Handle invalid lock info as-is; skip as duplicate execution at upper level
      }
      return null;
    }
    throw error;
  }
}

async function releaseTaskRuntimeLock(lock: TaskRuntimeLock | null): Promise<void> {
  if (!lock) {
    return;
  }
  try {
    await lock.handle.close();
  } finally {
    await rm(lock.path, { force: true }).catch(() => undefined);
  }
}

async function recoverInterruptedAgentRuns(agentId: string): Promise<number> {
  const staleRuns = await db
    .select({
      runId: runs.id,
      taskId: runs.taskId,
    })
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.status, "running")));

  if (staleRuns.length === 0) {
    return 0;
  }

  for (const run of staleRuns) {
    await db
      .update(runs)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        errorMessage: "Agent process restarted before task completion",
      })
      .where(eq(runs.id, run.runId));

    await db
      .update(tasks)
      .set({
        status: "queued",
        blockReason: null,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, run.taskId), eq(tasks.status, "running")));

    await db.delete(leases).where(eq(leases.taskId, run.taskId));
  }

  return staleRuns.length;
}

// Function to send heartbeat
function startHeartbeat(agentId: string): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await db
        .update(agents)
        .set({
          lastHeartbeat: new Date(),
          // Allow recovery from offline status
          // Only revert to idle when offline to avoid overwriting busy status
          status: sql`CASE WHEN ${agents.status} = 'offline' THEN 'idle' ELSE ${agents.status} END`,
        })
        .where(eq(agents.id, agentId));
    } catch (error) {
      console.error(`[Heartbeat] Failed to send heartbeat for ${agentId}:`, error);
    }
  }, HEARTBEAT_INTERVAL);
}

async function markAgentOffline(agentId: string): Promise<void> {
  await db
    .update(agents)
    .set({
      status: "offline",
      currentTaskId: null,
      lastHeartbeat: new Date(),
    })
    .where(eq(agents.id, agentId));
}

function setupWorkerShutdownHandlers(params: {
  agentId: string;
  heartbeatTimer: NodeJS.Timeout;
  getQueueWorker: () => ReturnType<typeof createTaskWorker> | null;
}): () => void {
  const { agentId, heartbeatTimer, getQueueWorker } = params;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.warn(`[Shutdown] ${agentId} received ${signal}. Draining worker...`);

    clearInterval(heartbeatTimer);
    const hardExitTimer = setTimeout(() => {
      console.error(`[Shutdown] ${agentId} forced exit after timeout`);
      process.exit(1);
    }, 15000);
    hardExitTimer.unref();

    try {
      const queueWorker = getQueueWorker();
      if (queueWorker) {
        await queueWorker.close();
      }
    } catch (error) {
      console.error(`[Shutdown] Failed to close queue worker for ${agentId}:`, error);
    }

    try {
      const recovered = await recoverInterruptedAgentRuns(agentId);
      if (recovered > 0) {
        console.warn(`[Shutdown] Requeued ${recovered} interrupted run(s) for ${agentId}`);
      }
    } catch (error) {
      console.error(`[Shutdown] Failed to recover interrupted runs for ${agentId}:`, error);
    }

    try {
      await markAgentOffline(agentId);
    } catch (error) {
      console.error(`[Shutdown] Failed to mark ${agentId} offline:`, error);
    }

    clearTimeout(hardExitTimer);
    process.exit(0);
  };

  const listeners = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((signal) => {
    const listener = () => {
      void shutdown(signal);
    };
    process.on(signal, listener);
    return { signal, listener };
  });

  return () => {
    for (const { signal, listener } of listeners) {
      process.off(signal, listener);
    }
  };
}

// Worker configuration
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

// Execution result
export interface WorkerResult {
  success: boolean;
  taskId: string;
  runId?: string;
  prUrl?: string;
  error?: string;
  costTokens?: number;
}

interface TaskPrContext {
  number: number;
  headRef?: string;
  baseRef?: string;
}

function resolveTaskPrContext(task: Task): TaskPrContext | null {
  if (!task.context || typeof task.context !== "object") {
    return null;
  }
  const contextRecord = task.context as Record<string, unknown>;
  const pr = contextRecord.pr;
  if (!pr || typeof pr !== "object") {
    return null;
  }
  const prRecord = pr as Record<string, unknown>;
  const number = prRecord.number;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
    return null;
  }
  const headRef = typeof prRecord.headRef === "string" && prRecord.headRef.trim().length > 0
    ? prRecord.headRef.trim()
    : undefined;
  const baseRef = typeof prRecord.baseRef === "string" && prRecord.baseRef.trim().length > 0
    ? prRecord.baseRef.trim()
    : undefined;
  return { number, headRef, baseRef };
}

function buildPrFetchRefspecs(prContext: TaskPrContext | null): string[] {
  if (!prContext) {
    return [];
  }
  if (prContext.headRef) {
    return [`+refs/heads/${prContext.headRef}:refs/remotes/origin/${prContext.headRef}`];
  }
  return [`+refs/pull/${prContext.number}/head:refs/remotes/origin/pull/${prContext.number}`];
}

function resolveBranchBaseRef(prContext: TaskPrContext | null, fallbackBaseBranch: string): string {
  if (!prContext) {
    return fallbackBaseBranch;
  }
  if (prContext.headRef) {
    return `origin/${prContext.headRef}`;
  }
  return `origin/pull/${prContext.number}`;
}

function sanitizeRetryHint(message: string): string {
  return message
    .replace(/\x1B\[[0-9;]*m/g, "")
    .replace(/\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g, "<path>")
    .replace(/external_directory\s*\([^)]*\)/gi, "external_directory(<path>)")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoCommitsBetweenError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("no commits between");
}

// Worker main processing
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

  // Create execution record
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

    // Step 1: Check out repository
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

    // Step 3: Execute task with OpenCode
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
        // Continue if there are changes even on timeout (evaluated in verification step)
        console.warn("[Worker] OpenCode timed out, but continuing to verify changes...");
      } else {
        throw new Error(executeResult.error);
      }
    }

    // Step 4: Check expected files
    console.log("\n[4/7] Checking expected files...");
    const missingFiles = await validateExpectedFiles(repoPath, taskData);
    if (missingFiles.length > 0) {
      // Continue with warning if expected files not found (verification commands will determine if actually needed)
      console.warn(`[Worker] Warning: Expected files not found: ${missingFiles.join(", ")}`);
      console.warn("[Worker] Continuing with verification commands...");
    }

    // Step 5: Verify changes
    console.log("\n[5/7] Verifying changes...");
    const verifyResult = await verifyChanges({
      repoPath,
      commands: taskData.commands,
      allowedPaths: taskData.allowedPaths,
      policy: effectivePolicy,
      baseBranch,
      headBranch: branchName,
      // Always allow lockfile changes from pnpm install
      allowLockfileOutsidePaths: true,
      // Don't stop on .env.example creation in local mode
      allowEnvExampleOutsidePaths: repoMode === "local",
      allowNoChanges: shouldAllowNoChanges(taskData),
    });

    if (!verifyResult.success) {
      throw new Error(verifyResult.error);
    }

    if (verifyResult.changedFiles.length === 0) {
      console.log("\n[6/7] Skipping commit/PR...");
      console.log("[Worker] No repository diff detected after verification. Marking task as no-op success.");

      await db
        .update(runs)
        .set({
          status: "success",
          finishedAt: new Date(),
          costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
        })
        .where(eq(runs.id, runId));

      await db
        .update(tasks)
        .set({
          status: "done",
          blockReason: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      await db.delete(leases).where(eq(leases.taskId, taskId));

      await db
        .update(agents)
        .set({ status: "idle", currentTaskId: null })
        .where(eq(agents.id, agentId));

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
      console.log("[Worker] Commit step produced no new commit. Marking task as no-op success.");

      await db
        .update(runs)
        .set({
          status: "success",
          finishedAt: new Date(),
          costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
        })
        .where(eq(runs.id, runId));

      await db
        .update(tasks)
        .set({
          status: "done",
          blockReason: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      await db.delete(leases).where(eq(leases.taskId, taskId));

      await db
        .update(agents)
        .set({ status: "idle", currentTaskId: null })
        .where(eq(agents.id, agentId));

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
    // Empty repository countermeasure: ensure base branch after agent branch push completes
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

        await db
          .update(runs)
          .set({
            status: "success",
            finishedAt: new Date(),
            costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
            errorMessage: "No commits between branches; PR creation skipped as no-op.",
          })
          .where(eq(runs.id, runId));

        await db
          .update(tasks)
          .set({
            status: "done",
            blockReason: null,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, taskId));

        await db.delete(leases).where(eq(leases.taskId, taskId));

        await db
          .update(agents)
          .set({ status: "idle", currentTaskId: null })
          .where(eq(agents.id, agentId));

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
      // Record if directly pushed
      await db.insert(artifacts).values({
        runId,
        type: "commit",
        ref: baseBranch,
        metadata: {
          message: "Direct push to base branch (base branch did not exist)",
        },
      });
    }

    // Record execution success
    await db
      .update(runs)
      .set({
        status: "success",
        finishedAt: new Date(),
        costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
      })
      .where(eq(runs.id, runId));

    // Set to await automatic Judge review if PR exists
    const needsReview = repoMode === "local" || Boolean(prResult.pr);
    const nextStatus = needsReview ? "blocked" : "done";
    await db
      .update(tasks)
      .set({
        status: nextStatus,
        blockReason: needsReview ? "awaiting_judge" : null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    // Release lease
    await db.delete(leases).where(eq(leases.taskId, taskId));

    // Return agent to idle
    await db
      .update(agents)
      .set({ status: "idle", currentTaskId: null })
      .where(eq(agents.id, agentId));

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

    console.error("\n" + "=".repeat(60));
    console.error("Task failed:", errorMessage);
    console.error("=".repeat(60));

    // 失敗を記録
    await db
      .update(runs)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorMessage,
      })
      .where(eq(runs.id, runId));

    // Update task to failed
    await db
      .update(tasks)
      .set({
        status: "failed",
        blockReason: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    // Release lease
    await db.delete(leases).where(eq(leases.taskId, taskId));

    // Return agent to idle
    await db
      .update(agents)
      .set({ status: "idle", currentTaskId: null })
      .where(eq(agents.id, agentId));

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

function hasGlobPattern(path: string): boolean {
  return /[*?[\]]/.test(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function shouldAllowNoChanges(task: Task): boolean {
  const text = `${task.title} ${task.goal}`.toLowerCase();
  const commands = task.commands ?? [];
  const allowHints = [
    "検証",
    "ビルド",
    "確認",
    "verification",
    "verify",
    "validation",
    "check",
    "inspect",
    "typecheck",
    "lint",
    "test",
    "build",
    "check",
  ];
  const denyHints = [
    "実装",
    "追加",
    "作成",
    "修正",
    "変更",
    "更新",
    "導入",
    "構築",
    "開発",
    "implement",
    "add",
    "create",
    "modify",
    "change",
    "update",
    "refactor",
    "remove",
    "fix",
  ];

  const allows = allowHints.some((hint) => text.includes(hint));
  const denies = denyHints.some((hint) => text.includes(hint));
  const verificationOnly = isVerificationOnlyCommands(commands);

  // Continue evaluation for verification-only tasks even without changes
  return (allows && !denies) || verificationOnly;
}

function isVerificationOnlyCommands(commands: string[]): boolean {
  if (commands.length === 0) {
    return false;
  }

  const dbCommandPattern =
    /\bdrizzle-kit\b|\bdb:(push|generate|migrate|studio)\b|\bpnpm\b[^\n]*--filter[^\n]*\bdb\b[^\n]*\b(push|generate|migrate|studio)\b/i;
  const verificationPatterns = [
    /\b(pnpm|npm|yarn|bun)\b[^\n]*\b(install|i|build|test|lint|typecheck|check|dev)\b/i,
    /\b(vitest|jest|playwright)\b/i,
    dbCommandPattern,
  ];

  // Treat tasks with only verification commands as successful even without changes
  return commands.every((command) =>
    verificationPatterns.some((pattern) => pattern.test(command))
  );
}

async function validateExpectedFiles(
  repoPath: string,
  task: Task
): Promise<string[]> {
  // Pre-check if expected files for the task exist
  const files = task.context?.files ?? [];
  if (files.length === 0) {
    return [];
  }

  const missing: string[] = [];

  for (const file of files) {
    const normalizedFile = file.trim();
    if (!normalizedFile) {
      continue;
    }

    // Exclude .env from expected file validation as it's generated by operations
    if (/(^|\/)\.env(\.|$)/.test(normalizedFile)) {
      continue;
    }

    if (hasGlobPattern(normalizedFile)) {
      continue;
    }

    const targetPath = join(repoPath, normalizedFile);

    if (normalizedFile.endsWith("/")) {
      try {
        const stats = await stat(targetPath);
        if (!stats.isDirectory()) {
          missing.push(normalizedFile);
        }
      } catch {
        missing.push(normalizedFile);
      }
      continue;
    }

    // First check the specified path
    if (await pathExists(targetPath)) {
      continue;
    }

    // If not found, try common patterns (src/ subdirectory)
    const pathParts = normalizedFile.split("/");
    const foundAlternative = await (async () => {
      // packages/xxx/file.ts -> packages/xxx/src/file.ts
      if (pathParts[0] === "packages" && pathParts.length >= 3) {
        const withSrc = [pathParts[0], pathParts[1], "src", ...pathParts.slice(2)].join("/");
        if (await pathExists(join(repoPath, withSrc))) {
          console.log(`[Worker] Found alternative path: ${withSrc} (original: ${normalizedFile})`);
          return true;
        }
      }
      // apps/xxx/file.ts -> apps/xxx/src/file.ts
      if (pathParts[0] === "apps" && pathParts.length >= 3) {
        const withSrc = [pathParts[0], pathParts[1], "src", ...pathParts.slice(2)].join("/");
        if (await pathExists(join(repoPath, withSrc))) {
          console.log(`[Worker] Found alternative path: ${withSrc} (original: ${normalizedFile})`);
          return true;
        }
      }
      return false;
    })();

    if (!foundAlternative) {
      missing.push(normalizedFile);
    }
  }

  return missing;
}

function setTaskLogPath(logPath?: string): void {
  // Separate logs per task
  if (taskLogStream) {
    logStreams.delete(taskLogStream);
    taskLogStream.end();
    taskLogStream = null;
  }

  if (!logPath) {
    return;
  }

  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create task log dir: ${logPath}`, error);
    return;
  }

  taskLogStream = createWriteStream(logPath, { flags: "a" });
  logStreams.add(taskLogStream);
  console.log(`[Logger] Task logs are written to ${logPath}`);
}

function setupProcessLogging(agentId: string): string | undefined {
  const logDir = process.env.OPENTIGER_LOG_DIR ?? "/tmp/openTiger-logs";

  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create log dir: ${logDir}`, error);
    return;
  }

  const logPath = join(logDir, `${agentId}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });
  logStreams.add(stream);

  // Also record stdout/stderr to file
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk, encoding, callback) => {
    for (const target of logStreams) {
      target.write(chunk);
    }
    return stdoutWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk, encoding, callback) => {
    for (const target of logStreams) {
      target.write(chunk);
    }
    return stderrWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stderr.write;

  process.on("exit", () => {
    for (const target of logStreams) {
      target.end();
    }
  });

  console.log(`[Logger] Worker logs are written to ${logPath}`);
  return logPath;
}

function buildTaskLogPath(
  logDir: string,
  taskId: string,
  runId: string,
  agentId: string
): string {
  return join(logDir, "tasks", taskId, `${agentId}-${runId}.log`);
}

// Worker process that receives and executes tasks from queue
async function main() {
  const workerIndex = process.env.WORKER_INDEX;
  const agentRole = process.env.AGENT_ROLE ?? "worker";
  const agentId = process.env.AGENT_ID
    ?? (workerIndex ? `${agentRole}-${workerIndex}` : `${agentRole}-${Date.now()}`);
  const workspacePath = process.env.WORKSPACE_PATH ?? `/tmp/openTiger-workspace/${agentId}`;
  const repoUrl = process.env.REPO_URL ?? "";
  const baseBranch = process.env.BASE_BRANCH ?? "main";
  const repoMode = getRepoMode();
  const agentModel =
    agentRole === "tester"
      ? process.env.TESTER_MODEL ?? process.env.OPENCODE_MODEL
      : agentRole === "docser"
        ? process.env.DOCSER_MODEL ?? process.env.OPENCODE_MODEL
        : process.env.WORKER_MODEL ?? process.env.OPENCODE_MODEL;
  const effectiveModel = agentModel ?? "google/gemini-3-flash-preview";
  // Prioritize instructions file if environment variable is set
  const instructionsPath =
    agentRole === "tester"
      ? process.env.TESTER_INSTRUCTIONS_PATH
        ?? resolve(import.meta.dirname, "../instructions/tester.md")
      : agentRole === "docser"
        ? process.env.DOCSER_INSTRUCTIONS_PATH
          ?? resolve(import.meta.dirname, "../instructions/docser.md")
        : process.env.WORKER_INSTRUCTIONS_PATH
          ?? resolve(import.meta.dirname, "../instructions/base.md");
  const agentLabel = agentRole === "tester"
    ? "Tester"
    : agentRole === "docser"
      ? "Docser"
      : "Worker";

  if (repoMode === "git" && !repoUrl) {
    console.error("REPO_URL environment variable is required for git mode");
    process.exit(1);
  }
  if (repoMode === "local" && !getLocalRepoPath()) {
    console.error("LOCAL_REPO_PATH environment variable is required for local mode");
    process.exit(1);
  }

  const logPath = setupProcessLogging(agentId);

  // Agent registration
  // Clean up old agents with the same role (offline ones, etc.) at startup
  if (workerIndex) {
    await db.delete(agents).where(eq(agents.id, agentId));
  }

  const recoveredRuns = await recoverInterruptedAgentRuns(agentId);
  if (recoveredRuns > 0) {
    console.warn(
      `[Recovery] Requeued ${recoveredRuns} interrupted run(s) for ${agentId}`
    );
  }

  await db.insert(agents).values({
    id: agentId,
    role: agentRole,
    status: "idle", // Register as idle at startup
    lastHeartbeat: new Date(),
    metadata: {
      model: effectiveModel, // 役割ごとのモデルを記録する
      provider: "gemini",
    },
  }).onConflictDoUpdate({
    target: agents.id,
    set: {
      status: "idle",
      lastHeartbeat: new Date(),
    },
  });

  // ハートビート開始
  const heartbeatTimer = startHeartbeat(agentId);
  let queueWorker: ReturnType<typeof createTaskWorker> | null = null;
  const disposeShutdownHandlers = setupWorkerShutdownHandlers({
    agentId,
    heartbeatTimer,
    getQueueWorker: () => queueWorker,
  });

  console.log(`${agentLabel} ${agentId} started`);
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Repository: ${repoUrl || "(local mode)"}`);
  console.log(`Base branch: ${baseBranch}`);
  console.log("Waiting for tasks...");

  // TODO: Receive tasks from BullMQ queue
  // Currently a simple version that receives task ID from environment variable
  const taskId = process.env.TASK_ID;

  if (taskId) {
    // Execute specified task (single execution mode)
    const [taskData] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    if (!taskData) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }

    const runtimeLock = await acquireTaskRuntimeLock(taskId);
    if (!runtimeLock) {
      console.warn(`[Worker] Task ${taskId} is already running elsewhere. Skipping.`);
      process.exit(0);
    }

    const result = await runWorker(
      taskData as unknown as Task,
      {
        agentId,
        role: agentRole,
        workspacePath,
        repoUrl,
        baseBranch,
        instructionsPath,
        model: effectiveModel,
        logPath,
      }
    ).finally(async () => {
      await releaseTaskRuntimeLock(runtimeLock);
    });

    disposeShutdownHandlers();
    process.exit(result.success ? 0 : 1);
  }

  // キュー待機モード（常駐モード）
  console.log(`${agentLabel} ${agentId} entering queue mode...`);
  
  queueWorker = createTaskWorker(async (job: Job<TaskJobData>) => {
    if (job.data.agentId && job.data.agentId !== agentId) {
      throw new Error(
        `Task ${job.data.taskId} is assigned to ${job.data.agentId}, not ${agentId}`
      );
    }

    console.log(`[Queue] Received task ${job.data.taskId} for ${agentId}`);

    if (activeTaskIds.has(job.data.taskId)) {
      console.warn(
        `[Queue] Task ${job.data.taskId} is already running on ${agentId}. Skipping duplicate job.`
      );
      return;
    }
    
    const [taskData] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, job.data.taskId));

    if (!taskData) {
      // Skip jobs remaining in queue after DB cleanup
      console.warn(`[Queue] Task not found in DB (likely cleaned up): ${job.data.taskId}`);
      return;
    }

    const runtimeLock = await acquireTaskRuntimeLock(job.data.taskId);
    if (!runtimeLock) {
      const activeRuns = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.taskId, job.data.taskId), eq(runs.status, "running")))
        .limit(1);

      if (activeRuns.length === 0) {
        // Right after lock conflict, another worker may be before run creation
        // If recently updated, skip this job silently to avoid false recovery
        const updatedAtMs = taskData.updatedAt?.getTime?.() ?? 0;
        const recentlyUpdated = Date.now() - updatedAtMs < 2 * 60 * 1000;
        if (taskData.status === "running" && recentlyUpdated) {
          console.warn(
            `[Queue] Task ${job.data.taskId} lock conflict during startup window. Skipping this duplicate job.`
          );
          return;
        }

        // Recover as state inconsistency if no running Run and update is old
        await db.delete(leases).where(eq(leases.taskId, job.data.taskId));
        await db
          .update(tasks)
          .set({ status: "queued", blockReason: null, updatedAt: new Date() })
          .where(eq(tasks.id, job.data.taskId));
        console.warn(
          `[Queue] Task ${job.data.taskId} lock conflict without running run. Reset to queued for retry.`
        );
        return;
      }

      console.warn(
        `[Queue] Task ${job.data.taskId} is already running on another agent/process. Skipping duplicate dispatch.`
      );
      return;
    }

    activeTaskIds.add(job.data.taskId);
    try {
      await runWorker(
        taskData as unknown as Task,
        {
          agentId,
          role: agentRole,
          workspacePath,
          repoUrl,
          baseBranch,
          instructionsPath,
          model: effectiveModel,
          logPath,
        }
      );
    } finally {
      activeTaskIds.delete(job.data.taskId);
      await releaseTaskRuntimeLock(runtimeLock);
    }
  }, getTaskQueueName(agentId));

  queueWorker.on("failed", (job: Job<TaskJobData> | undefined, err: Error) => {
    console.error(`[Queue] Job ${job?.id} failed:`, err);
  });

  queueWorker.on("error", (err: Error) => {
    console.error(`[Queue] Worker runtime error for ${agentId}:`, err);
  });

  console.log(`${agentLabel} is ready and waiting for tasks from queue.`);
}

main().catch((error) => {
  console.error("Worker crashed:", error);
  process.exit(1);
});
