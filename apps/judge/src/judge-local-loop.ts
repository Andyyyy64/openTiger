import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { createDocserTaskForLocal } from "./docser";
import { resolveBaseRepoRecoveryRules, type JudgeConfig } from "./judge-config";
import { getPendingWorktrees } from "./judge-pending";
import { safeSetJudgeAgentState } from "./judge-agent";
import { recordLocalReview } from "./judge-events";
import { judgeSingleWorktree, buildJudgeFailureMessage } from "./judge-evaluate";
import { mergeLocalBranch } from "./judge-local-merge";
import {
  requeueTaskAfterJudge,
  claimRunForJudgement,
} from "./judge-retry";

export async function runLocalJudgeLoop(config: JudgeConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("openTiger Judge (local mode) started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`Use LLM: ${config.useLlm}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Requeue on non-approve: ${config.requeueOnNonApprove}`);
  console.log("=".repeat(60));

  while (true) {
    try {
      const recoveryRules = resolveBaseRepoRecoveryRules(config.policy, config);
      const pendingWorktrees = await getPendingWorktrees();

      if (pendingWorktrees.length > 0) {
        await safeSetJudgeAgentState(config.agentId, "busy");
        console.log(`\nFound ${pendingWorktrees.length} worktrees to review`);

        for (const target of pendingWorktrees) {
          try {
            await safeSetJudgeAgentState(config.agentId, "busy", target.taskId);
            if (!config.dryRun) {
              const claimed = await claimRunForJudgement(target.runId);
              if (!claimed) {
                console.log(`  Skip worktree ${target.worktreePath}: run already judged`);
                await safeSetJudgeAgentState(config.agentId, "busy");
                continue;
              }
            }

            const { result, summary, diffFiles } = await judgeSingleWorktree(
              target,
              config
            );
            let mergeResult: { success: boolean; error?: string } | undefined;

            if (!config.dryRun) {
              let nextStatus: "done" | "queued" | "blocked";
              let requeueReason: string | undefined;
              let nextBlockReason: "needs_rework" | null = null;
              if (result.verdict === "approve") {
                mergeResult = await mergeLocalBranch({
                  baseRepoPath: target.baseRepoPath,
                  baseBranch: target.baseBranch,
                  branchName: target.branchName,
                  runId: target.runId,
                  taskId: target.taskId,
                  agentId: config.agentId,
                  workdir: config.workdir,
                  instructionsPath: config.instructionsPath,
                  useLlm: config.useLlm,
                  recoveryMode: config.baseRepoRecoveryMode,
                  recoveryRules,
                });
                nextStatus = mergeResult.success ? "done" : "queued";
                if (!mergeResult.success) {
                  console.error(
                    "[Judge] Failed to merge local branch:",
                    mergeResult.error
                  );
                  requeueReason = buildJudgeFailureMessage(result, mergeResult.error);
                }
                // Log local merge success/failure to facilitate tracking of evaluation results
                console.log(
                  `[Judge] Local merge result: ${mergeResult.success ? "success" : "failed"}`
                );

                if (mergeResult.success) {
                  const docserResult = await createDocserTaskForLocal({
                    mode: "local",
                    worktreePath: target.worktreePath,
                    baseBranch: target.baseBranch,
                    branchName: target.branchName,
                    baseRepoPath: target.baseRepoPath,
                    taskId: target.taskId,
                    runId: target.runId,
                    agentId: config.agentId,
                    workdir: config.workdir,
                    diffFiles,
                  });
                  if (docserResult.created) {
                    console.log(`  Docser task created: ${docserResult.docserTaskId}`);
                  } else if (docserResult.reason) {
                    console.log(`  Docser task skipped: ${docserResult.reason}`);
                  }
                }
              } else {
                nextStatus = config.requeueOnNonApprove ? "queued" : "blocked";
                if (config.requeueOnNonApprove) {
                  requeueReason = buildJudgeFailureMessage(result);
                } else {
                  nextBlockReason = "needs_rework";
                }
              }
              await db
                .update(tasks)
                .set({
                  status: nextStatus,
                  blockReason: nextStatus === "blocked" ? nextBlockReason : null,
                  updatedAt: new Date(),
                })
                .where(eq(tasks.id, target.taskId));

              if (requeueReason) {
                await requeueTaskAfterJudge({
                  taskId: target.taskId,
                  runId: target.runId,
                  agentId: config.agentId,
                  reason: requeueReason,
                });
                console.log(`  Task ${target.taskId} requeued in local judge loop`);
              }
            }

            await recordLocalReview(
              {
                taskId: target.taskId,
                runId: target.runId,
                worktreePath: target.worktreePath,
                baseBranch: target.baseBranch,
                branchName: target.branchName,
                baseRepoPath: target.baseRepoPath,
              },
              result,
              summary,
              config.agentId,
              config.dryRun,
              mergeResult
            );
          } catch (error) {
            console.error(`  Error processing worktree ${target.worktreePath}:`, error);
          } finally {
            await safeSetJudgeAgentState(config.agentId, "busy");
          }
        }
      }
    } catch (error) {
      console.error("Judge loop error:", error);
    } finally {
      await safeSetJudgeAgentState(config.agentId, "idle");
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
