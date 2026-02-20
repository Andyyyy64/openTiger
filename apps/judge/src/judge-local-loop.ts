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
  scheduleTaskForJudgeRetry,
} from "./judge-retry";
import { loadPlugins, registerPlugin, type JudgeHookPendingTarget } from "@openTiger/plugin-sdk";
import { tigerResearchPluginManifest } from "@openTiger/plugin-tiger-research";

registerPlugin(tigerResearchPluginManifest);

type JudgeHookEntry = {
  id: string;
  hook: NonNullable<ReturnType<typeof loadPlugins>["enabledPlugins"][number]["judge"]>;
};

export async function runLocalJudgeLoop(config: JudgeConfig): Promise<void> {
  const pluginResult = loadPlugins({
    enabledPluginsCsv: process.env.ENABLED_PLUGINS,
  });
  const judgeHooks = pluginResult.enabledPlugins
    .map((plugin) => ({ id: plugin.id, hook: plugin.judge }))
    .filter((entry): entry is JudgeHookEntry => Boolean(entry.hook));

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

            const { result, summary, diffFiles } = await judgeSingleWorktree(target, config);
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
                  console.error("[Judge] Failed to merge local branch:", mergeResult.error);
                  requeueReason = buildJudgeFailureMessage(result, mergeResult.error);
                }
                // Log local merge success/failure to facilitate tracking of evaluation results
                console.log(
                  `[Judge] Local merge result: ${mergeResult.success ? "success" : "failed"}`,
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
              mergeResult,
            );
          } catch (error) {
            console.error(`  Error processing worktree ${target.worktreePath}:`, error);
          } finally {
            await safeSetJudgeAgentState(config.agentId, "busy");
          }
        }
      }

      for (const entry of judgeHooks) {
        if (
          !entry.hook.collectPendingTargets ||
          !entry.hook.evaluateTarget ||
          !entry.hook.applyVerdict
        ) {
          continue;
        }
        const pendingTargets = await entry.hook.collectPendingTargets();
        if (pendingTargets.length > 0) {
          await safeSetJudgeAgentState(config.agentId, "busy");
          console.log(`\nFound ${pendingTargets.length} ${entry.id} runs to review`);

          for (const pending of pendingTargets) {
            let taskStateTransitioned = false;
            try {
              await safeSetJudgeAgentState(config.agentId, "busy", pending.taskId);
              if (!config.dryRun) {
                const claimed = await claimRunForJudgement(pending.runId);
                if (!claimed) {
                  console.log(`  Skip ${entry.id} run ${pending.runId}: run already judged`);
                  await safeSetJudgeAgentState(config.agentId, "busy");
                  continue;
                }
              }

              const evaluation = await entry.hook.evaluateTarget(pending);
              await entry.hook.applyVerdict({
                target: pending,
                result: evaluation,
                agentId: config.agentId,
                dryRun: config.dryRun,
              });
              taskStateTransitioned = true;
            } catch (error) {
              if (!config.dryRun && !taskStateTransitioned) {
                const reason =
                  error instanceof Error ? error.message : `unknown_${entry.id}_review_error`;
                await scheduleTaskForJudgeRetry({
                  taskId: pending.taskId,
                  runId: pending.runId,
                  agentId: config.agentId,
                  reason: `judge_plugin_error:${reason}`,
                  restoreRunImmediately: true,
                });
                console.warn(
                  `  ${entry.id} task ${pending.taskId} scheduled for judge retry due to processing error`,
                );
              }
              console.error(`  Error processing ${entry.id} run ${pending.runId}:`, error);
            } finally {
              await safeSetJudgeAgentState(config.agentId, "busy");
            }
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
