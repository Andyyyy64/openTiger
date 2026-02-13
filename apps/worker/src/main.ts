import { db } from "@openTiger/db";
import { tasks, runs, leases, agents } from "@openTiger/db/schema";
import { and, eq } from "drizzle-orm";
import type { Task } from "@openTiger/core";
import { getRepoMode, getLocalRepoPath } from "@openTiger/core";
import "dotenv/config";
import { createTaskWorker, getTaskQueueName, type TaskJobData } from "@openTiger/queue";
import type { Job } from "bullmq";
import { resolve } from "node:path";
import { acquireTaskRuntimeLock, releaseTaskRuntimeLock } from "./worker-runtime-lock";
import { recoverInterruptedAgentRuns, startHeartbeat } from "./worker-agent-state";
import { setupWorkerShutdownHandlers } from "./worker-shutdown";
import { setupProcessLogging } from "./worker-logging";
import { runWorker } from "./worker-runner";

export { runWorker, type WorkerConfig, type WorkerResult } from "./worker-runner";

const activeTaskIds = new Set<string>();

function isClaudeExecutor(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

function isCodexExecutor(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "codex-cli" || normalized === "codex_cli";
}

function resolveExecutor(value: string | undefined): "opencode" | "claude_code" | "codex" {
  if (isClaudeExecutor(value)) {
    return "claude_code";
  }
  if (isCodexExecutor(value)) {
    return "codex";
  }
  return "opencode";
}

function resolveExecutorProvider(executor: "opencode" | "claude_code" | "codex"): string {
  if (executor === "claude_code") {
    return "claude_code";
  }
  if (executor === "codex") {
    return "codex";
  }
  return "opencode";
}

// Entry point: receive tasks from queue and execute
async function main() {
  const workerIndex = process.env.WORKER_INDEX;
  const agentRole = process.env.AGENT_ROLE ?? "worker";
  const agentId =
    process.env.AGENT_ID ??
    (workerIndex ? `${agentRole}-${workerIndex}` : `${agentRole}-${Date.now()}`);
  const workspacePath = process.env.WORKSPACE_PATH ?? `/tmp/openTiger-workspace/${agentId}`;
  const repoUrl = process.env.REPO_URL ?? "";
  const baseBranch = process.env.BASE_BRANCH ?? "main";
  const repoMode = getRepoMode();
  const llmExecutor = resolveExecutor(process.env.LLM_EXECUTOR);
  const agentModel =
    llmExecutor === "claude_code"
      ? process.env.CLAUDE_CODE_MODEL
      : llmExecutor === "codex"
        ? process.env.CODEX_MODEL
        : agentRole === "tester"
          ? (process.env.TESTER_MODEL ?? process.env.OPENCODE_MODEL)
          : agentRole === "docser"
            ? (process.env.DOCSER_MODEL ?? process.env.OPENCODE_MODEL)
            : (process.env.WORKER_MODEL ?? process.env.OPENCODE_MODEL);
  const effectiveModel =
    agentModel ??
    (llmExecutor === "claude_code"
      ? "claude-opus-4-6"
      : llmExecutor === "codex"
        ? "gpt-5.3-codex"
        : "google/gemini-3-flash-preview");
  // Prefer env if set
  const instructionsPath =
    agentRole === "tester"
      ? (process.env.TESTER_INSTRUCTIONS_PATH ??
        resolve(import.meta.dirname, "../instructions/tester.md"))
      : agentRole === "docser"
        ? (process.env.DOCSER_INSTRUCTIONS_PATH ??
          resolve(import.meta.dirname, "../instructions/docser.md"))
        : (process.env.WORKER_INSTRUCTIONS_PATH ??
          resolve(import.meta.dirname, "../instructions/base.md"));
  const agentLabel =
    agentRole === "tester" ? "Tester" : agentRole === "docser" ? "Docser" : "Worker";

  if (repoMode === "git" && !repoUrl) {
    console.error("REPO_URL environment variable is required for git mode");
    process.exit(1);
  }
  if (repoMode === "local" && !getLocalRepoPath()) {
    console.error("LOCAL_REPO_PATH environment variable is required for local mode");
    process.exit(1);
  }

  const logPath = setupProcessLogging(agentId);

  // Register agent
  // Remove stale agents with same role on startup
  if (workerIndex) {
    await db.delete(agents).where(eq(agents.id, agentId));
  }

  const recoveredRuns = await recoverInterruptedAgentRuns(agentId);
  if (recoveredRuns > 0) {
    console.warn(`[Recovery] Requeued ${recoveredRuns} interrupted run(s) for ${agentId}`);
  }

  await db
    .insert(agents)
    .values({
      id: agentId,
      role: agentRole,
      status: "idle", // Register as idle at startup
      lastHeartbeat: new Date(),
      metadata: {
        model: effectiveModel, // Record model per role
        provider: resolveExecutorProvider(llmExecutor),
      },
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        status: "idle",
        lastHeartbeat: new Date(),
      },
    });

  // Start heartbeat
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

  // TODO: Implement task receipt from BullMQ
  // For now treat TASK_ID from env as one-shot execution
  const taskId = process.env.TASK_ID;

  if (taskId) {
    // One-shot mode
    const [taskData] = await db.select().from(tasks).where(eq(tasks.id, taskId));

    if (!taskData) {
      console.error(`Task not found: ${taskId}`);
      process.exit(1);
    }

    const runtimeLock = await acquireTaskRuntimeLock(taskId);
    if (!runtimeLock) {
      console.warn(`[Worker] Task ${taskId} is already running elsewhere. Skipping.`);
      process.exit(0);
    }

    const result = await runWorker(taskData as unknown as Task, {
      agentId,
      role: agentRole,
      workspacePath,
      repoUrl,
      baseBranch,
      instructionsPath,
      model: effectiveModel,
      logPath,
    }).finally(async () => {
      await releaseTaskRuntimeLock(runtimeLock);
    });

    disposeShutdownHandlers();
    process.exit(result.success ? 0 : 1);
  }

  // Queue wait mode (resident)
  console.log(`${agentLabel} ${agentId} entering queue mode...`);

  queueWorker = createTaskWorker(async (job: Job<TaskJobData>) => {
    if (job.data.agentId && job.data.agentId !== agentId) {
      throw new Error(`Task ${job.data.taskId} is assigned to ${job.data.agentId}, not ${agentId}`);
    }

    console.log(`[Queue] Received task ${job.data.taskId} for ${agentId}`);

    if (activeTaskIds.has(job.data.taskId)) {
      console.warn(
        `[Queue] Task ${job.data.taskId} is already running on ${agentId}. Skipping duplicate job.`,
      );
      return;
    }

    const [taskData] = await db.select().from(tasks).where(eq(tasks.id, job.data.taskId));

    if (!taskData) {
      // Ignore leftover jobs after DB cleanup
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
        // Right after lock contention, another worker may be creating run
        // Skip quietly if recently updated to avoid wrong recovery
        const updatedAtMs = taskData.updatedAt?.getTime?.() ?? 0;
        const recentlyUpdated = Date.now() - updatedAtMs < 2 * 60 * 1000;
        if (taskData.status === "running" && recentlyUpdated) {
          console.warn(
            `[Queue] Task ${job.data.taskId} lock conflict during startup window. Skipping this duplicate job.`,
          );
          return;
        }

        // Recover as mismatch if run missing and update is stale
        await db.delete(leases).where(eq(leases.taskId, job.data.taskId));
        await db
          .update(tasks)
          .set({ status: "queued", blockReason: null, updatedAt: new Date() })
          .where(eq(tasks.id, job.data.taskId));
        console.warn(
          `[Queue] Task ${job.data.taskId} lock conflict without running run. Reset to queued for retry.`,
        );
        return;
      }

      console.warn(
        `[Queue] Task ${job.data.taskId} is already running on another agent/process. Skipping duplicate dispatch.`,
      );
      return;
    }

    activeTaskIds.add(job.data.taskId);
    try {
      await runWorker(taskData as unknown as Task, {
        agentId,
        role: agentRole,
        workspacePath,
        repoUrl,
        baseBranch,
        instructionsPath,
        model: effectiveModel,
        logPath,
      });
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
