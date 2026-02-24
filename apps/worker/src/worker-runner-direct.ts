import { db } from "@openTiger/db";
import { artifacts, runs } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import type { Task } from "@openTiger/core";
import {
  FAILURE_CODE,
  DEFAULT_POLICY,
  getLocalRepoPath,
  applyRepoModePolicyOverrides,
} from "@openTiger/core";
import { takeSnapshot, diffSnapshots } from "@openTiger/vcs";
import { executeTask } from "./steps/index";
import { validateExpectedFiles, shouldAllowNoChanges, sanitizeRetryHint } from "./worker-task-helpers";
import { buildTaskLogPath, setTaskLogPath, resolveLogDir } from "./worker-logging";
import { finalizeTaskState } from "./worker-runner-state";
import { getRuntimeExecutorDisplayName, isExecutionTimeout } from "./worker-runner-utils";
import { isQuotaFailure } from "./worker-task-helpers";
import type { WorkerConfig, WorkerResult } from "./worker-runner-types";
import { and, desc, inArray, isNotNull, ne } from "drizzle-orm";
import { resolveWorkerTaskKindPlugin } from "./plugins";

const DEFAULT_LOG_DIR = resolve(import.meta.dirname, "../../../raw-logs");

export async function runDirectModeWorker(
  taskData: Task,
  config: WorkerConfig,
): Promise<WorkerResult> {
  const {
    agentId,
    role,
    baseBranch = "main",
    instructionsPath,
    model,
    policy = DEFAULT_POLICY,
    logPath,
  } = config;
  const effectivePolicy = applyRepoModePolicyOverrides(policy);
  const projectPath = getLocalRepoPath();

  // Resolve plugin for non-code task kinds (e.g., research)
  const taskKindPlugin = resolveWorkerTaskKindPlugin(taskData.kind);

  if (!projectPath) {
    return {
      success: false,
      taskId: taskData.id,
      error: "LOCAL_REPO_PATH is required for direct mode",
    };
  }

  const taskId = taskData.id;
  const agentLabel = role === "tester" ? "Tester" : role === "docser" ? "Docser" : "Worker";

  console.log("=".repeat(60));
  console.log(`${agentLabel} ${agentId} starting direct-mode task: ${taskData.title}`);
  console.log("=".repeat(60));
  console.log(`[Worker] Direct mode: editing files in ${projectPath}`);

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
  const logDir = resolveLogDir(DEFAULT_LOG_DIR);
  const taskLogPath = buildTaskLogPath(logDir, taskId, runId, agentId);
  setTaskLogPath(taskLogPath);
  await db.update(runs).set({ logPath: taskLogPath }).where(eq(runs.id, runId));

  try {
    // Handle plugin-based task kinds (e.g., research)
    if (!taskKindPlugin && taskData.kind !== "code") {
      const unsupportedKindMessage =
        `Unsupported task kind without enabled plugin handler: ${taskData.kind}. ` +
        "Enable the matching plugin via system config ENABLED_PLUGINS and restart processes before dispatch.";
      await finalizeTaskState({
        runId,
        taskId,
        agentId,
        runStatus: "failed",
        taskStatus: "failed",
        blockReason: null,
        errorMessage: unsupportedKindMessage,
        errorMeta: {
          source: "execution",
          failureCode: FAILURE_CODE.EXECUTION_FAILED,
        },
      });
      return {
        success: false,
        taskId,
        runId,
        error: unsupportedKindMessage,
      };
    }

    if (taskKindPlugin) {
      console.log(`\n[Plugin:${taskKindPlugin.kind}] Running plugin execution path (direct mode)...`);
      return await taskKindPlugin.run({
        task: taskData,
        runId,
        agentId,
        workspacePath: projectPath,
        model,
        instructionsPath: taskKindPlugin.resolveInstructionsPath
          ? taskKindPlugin.resolveInstructionsPath(taskData, config.instructionsPath)
          : config.instructionsPath,
      });
    }

    // Step 1: Take pre-execution snapshot
    console.log("\n[1/5] Taking pre-execution snapshot...");
    const beforeSnapshot = await takeSnapshot(projectPath);
    console.log(`[Worker] Snapshot: ${beforeSnapshot.entries.size} files tracked`);

    // Step 2: Execute task
    const runtimeExecutorDisplayName = getRuntimeExecutorDisplayName();
    console.log(`\n[2/5] Executing task with ${runtimeExecutorDisplayName}...`);

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
      repoPath: projectPath,
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
        console.warn(
          `[Worker] ${runtimeExecutorDisplayName} timed out, but continuing to check changes...`,
        );
      } else {
        throw new Error(executeResult.error);
      }
    }

    // Step 3: Take post-execution snapshot and diff
    console.log("\n[3/5] Detecting changes via snapshot diff...");
    const afterSnapshot = await takeSnapshot(projectPath);
    const snapshotDiff = await diffSnapshots(beforeSnapshot, afterSnapshot);

    const allChangedFiles = [
      ...snapshotDiff.changedFiles,
      ...snapshotDiff.addedFiles,
    ];
    const allAffectedFiles = [
      ...allChangedFiles,
      ...snapshotDiff.removedFiles,
    ];

    console.log(
      `[Worker] Changes detected: ${snapshotDiff.changedFiles.length} modified, ` +
        `${snapshotDiff.addedFiles.length} added, ${snapshotDiff.removedFiles.length} removed`,
    );

    if (allAffectedFiles.length === 0) {
      if (shouldAllowNoChanges(taskData)) {
        console.log("[Worker] No changes detected, but task allows no-op completion.");
      } else {
        console.log("[Worker] No changes detected. Marking as no-op success.");
      }

      await finalizeTaskState({
        runId,
        taskId,
        agentId,
        runStatus: "success",
        taskStatus: "done",
        blockReason: null,
        costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
      });

      return {
        success: true,
        taskId,
        runId,
      };
    }

    // Step 4: Validate expected files
    console.log("\n[4/5] Checking expected files...");
    const missingFiles = await validateExpectedFiles(projectPath, taskData);
    if (missingFiles.length > 0) {
      console.warn(`[Worker] Warning: Expected files not found: ${missingFiles.join(", ")}`);
    }

    // Step 5: Run verification commands (if any)
    console.log("\n[5/5] Running verification commands...");
    const verificationCommands = taskData.commands ?? [];
    const commandResults: Array<{ command: string; success: boolean }> = [];

    if (verificationCommands.length > 0) {
      const { spawnSync } = await import("node:child_process");
      for (const command of verificationCommands) {
        const parts = command.split(/\s+/);
        const cmd = parts[0] ?? command;
        const args = parts.slice(1);
        console.log(`  Running: ${command}`);
        const result = spawnSync(cmd, args, {
          cwd: projectPath,
          timeout: 300_000,
          encoding: "utf-8",
          env: { ...process.env },
        });
        const success = result.status === 0;
        commandResults.push({ command, success });
        if (!success) {
          console.warn(`  FAILED: ${command} (exit ${result.status})`);
          if (result.stderr) {
            console.warn(`  stderr: ${result.stderr.slice(0, 500)}`);
          }
        } else {
          console.log(`  PASSED: ${command}`);
        }
      }
    }

    // Check if any verification commands failed
    const hasVerificationFailure = commandResults.some((r) => !r.success);

    // Record artifact
    await db.insert(artifacts).values({
      runId,
      type: "direct_edit",
      ref: projectPath,
      metadata: {
        changedFiles: allChangedFiles,
        removedFiles: snapshotDiff.removedFiles,
        stats: snapshotDiff.stats,
        verificationResults: commandResults,
      },
    });

    if (hasVerificationFailure) {
      const failedCommands = commandResults
        .filter((r) => !r.success)
        .map((r) => r.command)
        .join(", ");
      const errorMessage = `Verification commands failed: ${failedCommands}`;
      console.error(`[Worker] ${errorMessage}`);

      await finalizeTaskState({
        runId,
        taskId,
        agentId,
        runStatus: "failed",
        taskStatus: "failed",
        blockReason: null,
        errorMessage,
        costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
        errorMeta: {
          source: "verification",
          failureCode: FAILURE_CODE.EXECUTION_FAILED,
        },
      });

      return {
        success: false,
        taskId,
        runId,
        error: errorMessage,
      };
    }

    // Direct mode: task goes directly to done (no judge review)
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
    console.log("Task completed successfully (direct mode)!");
    console.log(`Changed files: ${allAffectedFiles.length}`);
    console.log(`Stats: +${snapshotDiff.stats.additions} -${snapshotDiff.stats.deletions}`);
    console.log("=".repeat(60));

    return {
      success: true,
      taskId,
      runId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const quotaFailure = isQuotaFailure(errorMessage);
    const nextTaskStatus: "failed" | "blocked" = quotaFailure ? "blocked" : "failed";
    const nextBlockReason = quotaFailure ? "quota_wait" : null;

    console.error("\n" + "=".repeat(60));
    console.error("Task failed:", errorMessage);
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
        failureCode: quotaFailure
          ? FAILURE_CODE.QUOTA_FAILURE
          : FAILURE_CODE.EXECUTION_FAILED,
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
  }
}
