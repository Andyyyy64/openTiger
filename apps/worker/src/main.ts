import { db } from "@h1ve/db";
import { tasks, runs, artifacts, leases, agents } from "@h1ve/db/schema";
import { eq, and } from "drizzle-orm";
import type { Task, Policy } from "@h1ve/core";
import {
  DEFAULT_POLICY,
  getRepoMode,
  getLocalRepoPath,
  getLocalWorktreeRoot,
  applyRepoModePolicyOverrides,
} from "@h1ve/core";
import "dotenv/config";
import {
  createTaskWorker,
  getTaskQueueName,
  type TaskJobData,
} from "@h1ve/queue";
import type { Job } from "bullmq";
import { createWriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  checkoutRepository,
  createWorkBranch,
  executeTask,
  verifyChanges,
  commitAndPush,
  createTaskPR,
} from "./steps/index.js";
import { generateBranchName } from "./steps/branch.js";

// ハートビートの間隔（ミリ秒）
const HEARTBEAT_INTERVAL = 30000; // 30秒

const logStreams = new Set<ReturnType<typeof createWriteStream>>();
let taskLogStream: ReturnType<typeof createWriteStream> | null = null;

// ハートビートを送信する関数
async function startHeartbeat(agentId: string) {
  return setInterval(async () => {
    try {
      await db
        .update(agents)
        .set({
          lastHeartbeat: new Date(),
        })
        .where(eq(agents.id, agentId));
    } catch (error) {
      console.error(`[Heartbeat] Failed to send heartbeat for ${agentId}:`, error);
    }
  }, HEARTBEAT_INTERVAL);
}

// Worker設定
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

// Workerのメイン処理
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

  const taskId = taskData.id;
  const agentLabel = role === "tester" ? "Tester" : "Worker";

  console.log("=".repeat(60));
  console.log(`${agentLabel} ${agentId} starting task: ${taskData.title}`);
  console.log("=".repeat(60));

  // 実行記録を作成
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
  const logDir = process.env.H1VE_LOG_DIR ?? "/tmp/h1ve-logs";
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

    // Step 1: リポジトリをチェックアウト
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
    });

    if (!checkoutResult.success) {
      throw new Error(checkoutResult.error);
    }

    const repoPath = checkoutResult.repoPath;
    worktreeBasePath = checkoutResult.baseRepoPath;
    worktreePath = checkoutResult.worktreePath;

    // Step 2: 作業ブランチを作成
    let branchName: string;
    if (repoMode === "local") {
      branchName = localBranchName ?? generateBranchName(agentId, taskId);
    } else {
      console.log("\n[2/7] Creating work branch...");
      const branchResult = await createWorkBranch({
        repoPath,
        agentId,
        taskId,
        baseBranch,
      });

      if (!branchResult.success) {
        throw new Error(branchResult.error);
      }

      branchName = branchResult.branchName;
    }

    // ブランチをartifactとして記録
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

    // Step 3: OpenCodeでタスクを実行
    console.log("\n[3/7] Executing task with OpenCode...");
    const executeResult = await executeTask({
      repoPath,
      task: taskData,
      instructionsPath,
      model,
    });

    if (!executeResult.success) {
      throw new Error(executeResult.error);
    }

    // Step 4: 期待ファイルのチェック
    console.log("\n[4/7] Checking expected files...");
    const missingFiles = await validateExpectedFiles(repoPath, taskData);
    if (missingFiles.length > 0) {
      throw new Error(`Missing expected files: ${missingFiles.join(", ")}`);
    }

    // Step 5: 変更を検証
    console.log("\n[5/7] Verifying changes...");
    const verifyResult = await verifyChanges({
      repoPath,
      commands: taskData.commands,
      allowedPaths: taskData.allowedPaths,
      policy: effectivePolicy,
      baseBranch,
      headBranch: branchName,
      // local modeではロックファイルの変更で止めない
      allowLockfileOutsidePaths: repoMode === "local",
      // local modeでは.env.exampleの作成で止めない
      allowEnvExampleOutsidePaths: repoMode === "local",
      allowNoChanges: shouldAllowNoChanges(taskData),
    });

    if (!verifyResult.success) {
      throw new Error(verifyResult.error);
    }

    // Step 6: コミットしてプッシュ
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

    // コミットをartifactとして記録
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

    // Step 7: PRを作成
    console.log("\n[7/7] Creating PR...");
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
      throw new Error(prResult.error);
    }

    // PRをartifactとして記録
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
      // 直接プッシュした場合はその旨を記録
      await db.insert(artifacts).values({
        runId,
        type: "commit",
        ref: baseBranch,
        metadata: {
          message: "Direct push to base branch (base branch did not exist)",
        },
      });
    }

    // 実行成功を記録
    await db
      .update(runs)
      .set({
        status: "success",
        finishedAt: new Date(),
        costTokens: executeResult.openCodeResult.durationMs, // TODO: 実際のトークン数
      })
      .where(eq(runs.id, runId));

    // PRがある場合はJudgeの自動レビュー待ちにする
    const needsReview = repoMode === "local" || Boolean(prResult.pr);
    const nextStatus = needsReview ? "blocked" : "done";
    await db
      .update(tasks)
      .set({
        status: nextStatus,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    // リースを解放
    await db.delete(leases).where(eq(leases.taskId, taskId));

    // エージェントをidleに戻す
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

    // タスクをfailedに更新
    await db
      .update(tasks)
      .set({
        status: "failed",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    // リースを解放
    await db.delete(leases).where(eq(leases.taskId, taskId));

    // エージェントをidleに戻す
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
      const { removeWorktree } = await import("@h1ve/vcs");
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
  ];

  const allows = allowHints.some((hint) => text.includes(hint));
  const denies = denyHints.some((hint) => text.includes(hint));
  const verificationOnly = isVerificationOnlyCommands(commands);

  // 検証目的のタスクは変更なしでも評価を継続する
  return (allows && !denies) || verificationOnly;
}

function isVerificationOnlyCommands(commands: string[]): boolean {
  if (commands.length === 0) {
    return false;
  }

  const verificationPatterns = [
    /\b(pnpm|npm|yarn|bun)\b[^\n]*\b(install|i|build|test|lint|typecheck|check|dev)\b/i,
    /\b(vitest|jest|playwright)\b/i,
  ];

  // 検証系コマンドのみのタスクは変更なしでも成功扱いにする
  return commands.every((command) =>
    verificationPatterns.some((pattern) => pattern.test(command))
  );
}

async function validateExpectedFiles(
  repoPath: string,
  task: Task
): Promise<string[]> {
  // タスクの想定ファイルが存在するかを事前に確認する
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

    // .envは運用側で生成されるため期待ファイルの検証対象から外す
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

    if (!(await pathExists(targetPath))) {
      missing.push(normalizedFile);
    }
  }

  return missing;
}

function setTaskLogPath(logPath?: string): void {
  // タスク単位のログを出し分ける
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
  const logDir = process.env.H1VE_LOG_DIR ?? "/tmp/h1ve-logs";

  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create log dir: ${logDir}`, error);
    return;
  }

  const logPath = join(logDir, `${agentId}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });
  logStreams.add(stream);

  // 標準出力/標準エラーをファイルにも記録する
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

// キューからタスクを受け取って実行するワーカープロセス
async function main() {
  const workerIndex = process.env.WORKER_INDEX;
  const agentRole = process.env.AGENT_ROLE ?? "worker";
  const agentId = process.env.AGENT_ID
    ?? (workerIndex ? `${agentRole}-${workerIndex}` : `${agentRole}-${Date.now()}`);
  const workspacePath = process.env.WORKSPACE_PATH ?? `/tmp/h1ve-workspace/${agentId}`;
  const repoUrl = process.env.REPO_URL ?? "";
  const baseBranch = process.env.BASE_BRANCH ?? "main";
  const repoMode = getRepoMode();
  const agentModel =
    agentRole === "tester"
      ? process.env.TESTER_MODEL ?? process.env.OPENCODE_MODEL
      : process.env.WORKER_MODEL ?? process.env.OPENCODE_MODEL;
  const effectiveModel = agentModel ?? "google/gemini-3-flash-preview";
  // 指示ファイルは環境変数があれば優先する
  const instructionsPath =
    agentRole === "tester"
      ? process.env.TESTER_INSTRUCTIONS_PATH
        ?? resolve(import.meta.dirname, "../instructions/tester.md")
      : process.env.WORKER_INSTRUCTIONS_PATH
        ?? resolve(import.meta.dirname, "../instructions/base.md");
  const agentLabel = agentRole === "tester" ? "Tester" : "Worker";

  if (repoMode === "git" && !repoUrl) {
    console.error("REPO_URL environment variable is required for git mode");
    process.exit(1);
  }
  if (repoMode === "local" && !getLocalRepoPath()) {
    console.error("LOCAL_REPO_PATH environment variable is required for local mode");
    process.exit(1);
  }

  const logPath = setupProcessLogging(agentId);

  // エージェント登録
  // 起動時に自分と同じ役割の古いエージェント（オフラインのものなど）を掃除する
  if (workerIndex) {
    await db.delete(agents).where(eq(agents.id, agentId));
  }

  await db.insert(agents).values({
    id: agentId,
    role: agentRole,
    status: "idle", // 起動時は待機中として登録
    lastHeartbeat: new Date(),
    metadata: {
      model: effectiveModel, // 役割ごとのモデルを記録する
      provider: "gemini",
    },
  }).onConflictDoUpdate({
    target: agents.id,
    set: {
      lastHeartbeat: new Date(),
    },
  });

  // ハートビート開始
  const heartbeatTimer = startHeartbeat(agentId);

  console.log(`${agentLabel} ${agentId} started`);
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Repository: ${repoUrl || "(local mode)"}`);
  console.log(`Base branch: ${baseBranch}`);
  console.log("Waiting for tasks...");

  // TODO: BullMQキューからタスクを受け取る
  // 現時点では環境変数からタスクIDを受け取る簡易版
  const taskId = process.env.TASK_ID;

  if (taskId) {
    // 指定されたタスクを実行（単発実行モード）
    const [taskData] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    if (!taskData) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
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
    );

    process.exit(result.success ? 0 : 1);
  }

  // キュー待機モード（常駐モード）
  console.log(`${agentLabel} ${agentId} entering queue mode...`);
  
  const worker = createTaskWorker(async (job: Job<TaskJobData>) => {
    if (job.data.agentId && job.data.agentId !== agentId) {
      throw new Error(
        `Task ${job.data.taskId} is assigned to ${job.data.agentId}, not ${agentId}`
      );
    }

    console.log(`[Queue] Received task ${job.data.taskId} for ${agentId}`);
    
    const [taskData] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, job.data.taskId));

    if (!taskData) {
      throw new Error(`Task not found: ${job.data.taskId}`);
    }

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
  }, getTaskQueueName(agentId));

  worker.on("failed", (job: Job<TaskJobData> | undefined, err: Error) => {
    console.error(`[Queue] Job ${job?.id} failed:`, err);
  });

  console.log(`${agentLabel} is ready and waiting for tasks from queue.`);
}

main().catch((error) => {
  console.error("Worker crashed:", error);
  process.exit(1);
});
