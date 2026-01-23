import { db } from "@h1ve/db";
import { tasks, runs, artifacts, leases, agents } from "@h1ve/db/schema";
import { eq, and } from "drizzle-orm";
import type { Task, Policy } from "@h1ve/core";
import { DEFAULT_POLICY } from "@h1ve/core";
import "dotenv/config";

import {
  checkoutRepository,
  createWorkBranch,
  executeTask,
  verifyChanges,
  commitAndPush,
  createTaskPR,
} from "./steps/index.js";

// ハートビートの間隔（ミリ秒）
const HEARTBEAT_INTERVAL = 30000; // 30秒

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
  workspacePath: string;
  repoUrl: string;
  baseBranch?: string;
  instructionsPath?: string;
  policy?: Policy;
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
    workspacePath,
    repoUrl,
    baseBranch = "main",
    instructionsPath,
    policy = DEFAULT_POLICY,
  } = config;

  const taskId = taskData.id;

  console.log("=".repeat(60));
  console.log(`Worker ${agentId} starting task: ${taskData.title}`);
  console.log("=".repeat(60));

  // 実行記録を作成
  const runRecords = await db
    .insert(runs)
    .values({
      taskId,
      agentId,
      status: "running",
    })
    .returning();

  const runRecord = runRecords[0];
  if (!runRecord) {
    throw new Error("Failed to create run record");
  }

  const runId = runRecord.id;

  try {
    // Step 1: リポジトリをチェックアウト
    console.log("\n[1/6] Checking out repository...");
    const checkoutResult = await checkoutRepository({
      repoUrl,
      workspacePath,
      taskId,
      baseBranch,
      githubToken: process.env.GITHUB_TOKEN,
    });

    if (!checkoutResult.success) {
      throw new Error(checkoutResult.error);
    }

    const repoPath = checkoutResult.repoPath;

    // Step 2: 作業ブランチを作成
    console.log("\n[2/6] Creating work branch...");
    const branchResult = await createWorkBranch({
      repoPath,
      agentId,
      taskId,
      baseBranch,
    });

    if (!branchResult.success) {
      throw new Error(branchResult.error);
    }

    const branchName = branchResult.branchName;

    // ブランチをartifactとして記録
    await db.insert(artifacts).values({
      runId,
      type: "branch",
      ref: branchName,
    });

    // Step 3: OpenCodeでタスクを実行
    console.log("\n[3/6] Executing task with OpenCode...");
    const executeResult = await executeTask({
      repoPath,
      task: taskData,
      instructionsPath,
    });

    if (!executeResult.success) {
      throw new Error(executeResult.error);
    }

    // Step 4: 変更を検証
    console.log("\n[4/6] Verifying changes...");
    const verifyResult = await verifyChanges({
      repoPath,
      commands: taskData.commands,
      allowedPaths: taskData.allowedPaths,
      policy,
    });

    if (!verifyResult.success) {
      throw new Error(verifyResult.error);
    }

    // Step 5: コミットしてプッシュ
    console.log("\n[5/6] Committing and pushing...");
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

    // Step 6: PRを作成
    console.log("\n[6/6] Creating PR...");
    const prResult = await createTaskPR({
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
    await db.insert(artifacts).values({
      runId,
      type: "pr",
      ref: String(prResult.pr!.number),
      url: prResult.pr!.url,
      metadata: {
        title: prResult.pr!.title,
        state: prResult.pr!.state,
      },
    });

    // 実行成功を記録
    await db
      .update(runs)
      .set({
        status: "success",
        finishedAt: new Date(),
        costTokens: executeResult.openCodeResult.durationMs, // TODO: 実際のトークン数
      })
      .where(eq(runs.id, runId));

    // タスクを完了に更新
    await db
      .update(tasks)
      .set({
        status: "done",
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, taskId));

    // リースを解放
    await db.delete(leases).where(eq(leases.taskId, taskId));

    console.log("\n" + "=".repeat(60));
    console.log("Task completed successfully!");
    console.log(`PR: ${prResult.pr!.url}`);
    console.log("=".repeat(60));

    return {
      success: true,
      taskId,
      runId,
      prUrl: prResult.pr!.url,
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

    return {
      success: false,
      taskId,
      runId,
      error: errorMessage,
    };
  }
}

// キューからタスクを受け取って実行するワーカープロセス
async function main() {
  const agentId = process.env.AGENT_ID ?? `worker-${Date.now()}`;
  const workspacePath = process.env.WORKSPACE_PATH ?? "/tmp/h1ve-workspace";
  const repoUrl = process.env.REPO_URL ?? "";
  const baseBranch = process.env.BASE_BRANCH ?? "main";

  if (!repoUrl) {
    console.error("REPO_URL environment variable is required");
    process.exit(1);
  }

  // エージェント登録（既存の状態を維持しつつハートビートのみ更新）
  await db.insert(agents).values({
    id: agentId,
    role: "worker",
    status: "busy", // 起動時は作業中として登録
    lastHeartbeat: new Date(),
    metadata: {
      model: process.env.OPENCODE_MODEL ?? "google/gemini-3-flash-preview",
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

  console.log(`Worker ${agentId} started`);
  console.log(`Workspace: ${workspacePath}`);
  console.log(`Repository: ${repoUrl}`);
  console.log(`Base branch: ${baseBranch}`);
  console.log("Waiting for tasks...");

  // TODO: BullMQキューからタスクを受け取る
  // 現時点では環境変数からタスクIDを受け取る簡易版
  const taskId = process.env.TASK_ID;

  if (taskId) {
    // 指定されたタスクを実行
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
        workspacePath,
        repoUrl,
        baseBranch,
      }
    );

    process.exit(result.success ? 0 : 1);
  }

  // キュー待機モード（未実装）
  console.log("Queue mode not implemented yet. Set TASK_ID to run a specific task.");
}

main().catch((error) => {
  console.error("Worker crashed:", error);
  process.exit(1);
});
