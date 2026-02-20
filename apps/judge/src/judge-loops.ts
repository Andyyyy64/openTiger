import { db } from "@openTiger/db";
import { tasks, runs } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { loadPlugins, registerPlugin, type JudgeHookPendingTarget } from "@openTiger/plugin-sdk";
import { tigerResearchPluginManifest } from "@openTiger/plugin-tiger-research";

registerPlugin(tigerResearchPluginManifest);

import { reviewAndAct } from "./pr-reviewer";
import { createDocserTaskForPR } from "./docser";
import {
  JUDGE_AUTO_FIX_MAX_ATTEMPTS,
  JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES,
  JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES,
  formatJudgeAutoFixLimit,
  type JudgeConfig,
} from "./judge-config";
import { getPendingPRs } from "./judge-pending";
import { safeSetJudgeAgentState } from "./judge-agent";
import { recordJudgeReview } from "./judge-events";
import {
  judgeSinglePR,
  buildJudgeFailureMessage,
  hasActionableLLMFailures,
  isDoomLoopFailure,
  isNonActionableLLMFailure,
} from "./judge-evaluate";
import { createAutoFixTaskForPr } from "./judge-autofix";
import {
  getTaskRetryCount,
  scheduleTaskForJudgeRetry,
  isImportedPrReviewTask,
  recoverAwaitingJudgeBacklog,
  claimRunForJudgement,
} from "./judge-retry";
import { enqueueMergeQueueItem, processMergeQueue } from "./judge-merge-queue";

type JudgeHookEntry = {
  id: string;
  hook: NonNullable<ReturnType<typeof loadPlugins>["enabledPlugins"][number]["judge"]>;
};

function hasActiveAutoFix(reason: string): boolean {
  return (
    reason.startsWith("existing_active_autofix:") ||
    reason.startsWith("existing_active_conflict_autofix:")
  );
}

export async function runJudgeLoop(config: JudgeConfig): Promise<void> {
  const pluginResult = loadPlugins({
    enabledPluginsCsv: process.env.ENABLED_PLUGINS,
  });
  const judgeHooks = pluginResult.enabledPlugins
    .map((plugin) => ({ id: plugin.id, hook: plugin.judge }))
    .filter((entry): entry is JudgeHookEntry => Boolean(entry.hook));

  console.log("=".repeat(60));
  console.log("openTiger Judge started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`Use LLM: ${config.useLlm}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Merge on approve: ${config.mergeOnApprove}`);
  console.log(`Requeue on non-approve: ${config.requeueOnNonApprove}`);
  console.log(`Auto-fix max attempts: ${formatJudgeAutoFixLimit(JUDGE_AUTO_FIX_MAX_ATTEMPTS)}`);
  console.log(
    `Non-approve circuit breaker retries: ${
      Number.isFinite(JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES)
        ? Math.max(1, JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES)
        : 2
    }`,
  );
  console.log("=".repeat(60));

  while (true) {
    try {
      const recoveredAwaiting = await recoverAwaitingJudgeBacklog(config.agentId);
      if (recoveredAwaiting > 0) {
        console.log(
          `[Judge] Recovered ${recoveredAwaiting} awaiting_judge task(s) by restoring runs`,
        );
      }

      if (!config.dryRun) {
        const mergeQueueResult = await processMergeQueue({
          agentId: config.agentId,
          workdir: config.workdir,
        });
        if (mergeQueueResult.processed > 0 || mergeQueueResult.recoveredClaims > 0) {
          console.log(
            `[Judge] Merge queue processed=${mergeQueueResult.processed}, merged=${mergeQueueResult.merged}, retried=${mergeQueueResult.retried}, failed=${mergeQueueResult.failed}, recovered_claims=${mergeQueueResult.recoveredClaims}`,
          );
        }
      }

      // Get PRs awaiting review
      const pendingPRs = await getPendingPRs();

      if (pendingPRs.length > 0) {
        await safeSetJudgeAgentState(config.agentId, "busy");
        console.log(`\nFound ${pendingPRs.length} PRs to review`);

        for (const pr of pendingPRs) {
          try {
            await safeSetJudgeAgentState(config.agentId, "busy", pr.taskId);
            if (!config.dryRun) {
              const claimed = await claimRunForJudgement(pr.runId);
              if (!claimed) {
                console.log(`  Skip PR #${pr.prNumber}: run already judged`);
                await safeSetJudgeAgentState(config.agentId, "busy");
                continue;
              }
            }

            const { result, summary } = await judgeSinglePR(pr, config);
            const effectiveResult = config.mergeOnApprove
              ? result
              : { ...result, autoMerge: false };
            let actionResult: {
              commented: boolean;
              approved: boolean;
              merged: boolean;
              selfAuthored?: boolean;
              mergeDeferred?: boolean;
              mergeDeferredReason?: string;
            } = {
              commented: false,
              approved: false,
              merged: false,
            };

            let actionError: unknown;
            let requeueReason: string | undefined;
            const importedPrReviewTask = isImportedPrReviewTask(pr.taskGoal, pr.taskTitle);

            try {
              if (config.dryRun) {
                console.log("  [Dry run - no action taken]");
              } else {
                // Execute review and actions
                actionResult = await reviewAndAct(pr.prNumber, effectiveResult, summary);
                console.log(
                  `  Actions: commented=${actionResult.commented}, approved=${actionResult.approved}, merged=${actionResult.merged}`,
                );

                // If merged, task is complete
                if (actionResult.merged) {
                  await db
                    .update(tasks)
                    .set({
                      status: "done",
                      blockReason: null,
                      updatedAt: new Date(),
                    })
                    .where(eq(tasks.id, pr.taskId));
                  console.log(`  Task ${pr.taskId} marked as done`);

                  const docserResult = await createDocserTaskForPR({
                    mode: "git",
                    prNumber: pr.prNumber,
                    taskId: pr.taskId,
                    runId: pr.runId,
                    agentId: config.agentId,
                    workdir: config.workdir,
                  });
                  if (docserResult.created) {
                    console.log(`  Docser task created: ${docserResult.docserTaskId}`);
                  }
                } else if (effectiveResult.verdict !== "approve" && config.requeueOnNonApprove) {
                  // On LLM FAIL, create a fix task instead of entering Judge re-evaluation loop
                  if (!summary.llm.pass) {
                    if (hasActionableLLMFailures(summary)) {
                      const failureReason = buildJudgeFailureMessage(effectiveResult);
                      const autoFix = await createAutoFixTaskForPr({
                        prNumber: pr.prNumber,
                        prUrl: pr.prUrl,
                        sourceTaskId: pr.taskId,
                        sourceRunId: pr.runId,
                        sourceTaskTitle: pr.taskTitle,
                        sourceTaskGoal: pr.taskGoal,
                        allowedPaths: pr.allowedPaths,
                        commands: pr.commands,
                        summary,
                        agentId: config.agentId,
                        previousFailureReason: failureReason,
                        allowUnlimitedAttempts: true,
                      });

                      if (autoFix.created) {
                        await db
                          .update(tasks)
                          .set({
                            status: "blocked",
                            blockReason: "needs_rework",
                            updatedAt: new Date(),
                          })
                          .where(eq(tasks.id, pr.taskId));
                        console.log(
                          `  Task ${pr.taskId} blocked as needs_rework; auto-fix task queued: ${autoFix.taskId}`,
                        );
                      } else {
                        if (hasActiveAutoFix(autoFix.reason)) {
                          await db
                            .update(tasks)
                            .set({
                              status: "blocked",
                              blockReason: "needs_rework",
                              updatedAt: new Date(),
                            })
                            .where(eq(tasks.id, pr.taskId));
                          console.log(
                            `  Task ${pr.taskId} remains blocked as needs_rework (active auto-fix in progress: ${autoFix.reason})`,
                          );
                        } else {
                          requeueReason = `${failureReason} | autofix_create_failed:${autoFix.reason}`;
                          await scheduleTaskForJudgeRetry({
                            taskId: pr.taskId,
                            runId: pr.runId,
                            agentId: config.agentId,
                            reason: importedPrReviewTask
                              ? `retry_imported_pr_review:${requeueReason}`
                              : requeueReason,
                            restoreRunImmediately: false,
                          });
                          console.log(
                            `  Task ${pr.taskId} scheduled for judge retry (auto-fix create failed: ${autoFix.reason})`,
                          );
                        }
                      }
                    } else {
                      const doomLoopThreshold = Number.isFinite(
                        JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES,
                      )
                        ? Math.max(1, JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES)
                        : 2;
                      const isDoomLoop = isDoomLoopFailure(summary);
                      const currentRetryCount = await getTaskRetryCount(pr.taskId);
                      const shouldTripCircuitBreaker =
                        isDoomLoop && currentRetryCount >= doomLoopThreshold;

                      if (shouldTripCircuitBreaker) {
                        const failureReason = buildJudgeFailureMessage(effectiveResult);
                        const autoFix = await createAutoFixTaskForPr({
                          prNumber: pr.prNumber,
                          prUrl: pr.prUrl,
                          sourceTaskId: pr.taskId,
                          sourceRunId: pr.runId,
                          sourceTaskTitle: pr.taskTitle,
                          sourceTaskGoal: pr.taskGoal,
                          allowedPaths: pr.allowedPaths,
                          commands: pr.commands,
                          summary,
                          agentId: config.agentId,
                          previousFailureReason: failureReason,
                          allowUnlimitedAttempts: true,
                        });

                        if (autoFix.created) {
                          await db
                            .update(tasks)
                            .set({
                              status: "blocked",
                              blockReason: "needs_rework",
                              updatedAt: new Date(),
                            })
                            .where(eq(tasks.id, pr.taskId));
                          console.log(
                            `  Task ${pr.taskId} hit doom-loop circuit breaker; auto-fix task queued: ${autoFix.taskId}`,
                          );
                        } else {
                          if (hasActiveAutoFix(autoFix.reason)) {
                            await db
                              .update(tasks)
                              .set({
                                status: "blocked",
                                blockReason: "needs_rework",
                                updatedAt: new Date(),
                              })
                              .where(eq(tasks.id, pr.taskId));
                            console.log(
                              `  Task ${pr.taskId} remains blocked as needs_rework (active auto-fix in progress: ${autoFix.reason})`,
                            );
                          } else {
                            requeueReason = `${failureReason} | doom_loop_circuit_breaker_failed:${autoFix.reason}`;
                            await scheduleTaskForJudgeRetry({
                              taskId: pr.taskId,
                              runId: pr.runId,
                              agentId: config.agentId,
                              reason: importedPrReviewTask
                                ? `retry_imported_pr_review:${requeueReason}`
                                : requeueReason,
                              restoreRunImmediately: false,
                            });
                            console.log(
                              `  Task ${pr.taskId} doom-loop breaker fallback to judge retry (${autoFix.reason})`,
                            );
                          }
                        }
                      } else {
                        // LLM failures without code diffs (quota exceeded, execution errors) are re-evaluated after cooldown
                        requeueReason = `${buildJudgeFailureMessage(effectiveResult)} | llm_non_actionable_failure`;
                        await scheduleTaskForJudgeRetry({
                          taskId: pr.taskId,
                          runId: pr.runId,
                          agentId: config.agentId,
                          reason: importedPrReviewTask
                            ? `retry_imported_pr_review:${requeueReason}`
                            : requeueReason,
                          // Don't immediately re-evaluate the same run; Judge will restore the run after a short cooldown
                          restoreRunImmediately: false,
                        });
                        const marker = isNonActionableLLMFailure(summary)
                          ? "non-actionable"
                          : "llm-failed";
                        console.log(
                          `  Task ${pr.taskId} scheduled for judge retry after cooldown (${marker})`,
                        );
                      }
                    }
                  } else {
                    // CI/Policy non-approve: route to AutoFix from first failure
                    const failureReason = buildJudgeFailureMessage(effectiveResult);
                    const autoFix = await createAutoFixTaskForPr({
                      prNumber: pr.prNumber,
                      prUrl: pr.prUrl,
                      sourceTaskId: pr.taskId,
                      sourceRunId: pr.runId,
                      sourceTaskTitle: pr.taskTitle,
                      sourceTaskGoal: pr.taskGoal,
                      allowedPaths: pr.allowedPaths,
                      commands: pr.commands,
                      summary,
                      agentId: config.agentId,
                      allowWhenLlmPass: true,
                      previousFailureReason: failureReason,
                      allowUnlimitedAttempts: true,
                    });

                    if (autoFix.created) {
                      await db
                        .update(tasks)
                        .set({
                          status: "blocked",
                          blockReason: "needs_rework",
                          updatedAt: new Date(),
                        })
                        .where(eq(tasks.id, pr.taskId));
                      console.log(
                        `  Task ${pr.taskId} blocked as needs_rework; auto-fix task queued: ${autoFix.taskId}`,
                      );
                    } else {
                      if (hasActiveAutoFix(autoFix.reason)) {
                        await db
                          .update(tasks)
                          .set({
                            status: "blocked",
                            blockReason: "needs_rework",
                            updatedAt: new Date(),
                          })
                          .where(eq(tasks.id, pr.taskId));
                        console.log(
                          `  Task ${pr.taskId} remains blocked as needs_rework (active auto-fix in progress: ${autoFix.reason})`,
                        );
                      } else {
                        requeueReason = `${failureReason} | autofix_create_failed:${autoFix.reason}`;
                        await scheduleTaskForJudgeRetry({
                          taskId: pr.taskId,
                          runId: pr.runId,
                          agentId: config.agentId,
                          reason: importedPrReviewTask
                            ? `retry_imported_pr_review:${requeueReason}`
                            : requeueReason,
                          restoreRunImmediately: false,
                        });
                        console.warn(
                          `  Task ${pr.taskId} scheduled for judge retry (auto-fix create failed: ${autoFix.reason})`,
                        );
                      }
                    }
                  }
                } else if (effectiveResult.verdict === "approve") {
                  let handledApprovedWithoutMerge = false;
                  if (!effectiveResult.autoMerge && actionResult.commented) {
                    await db
                      .update(tasks)
                      .set({
                        status: "done",
                        blockReason: null,
                        updatedAt: new Date(),
                      })
                      .where(eq(tasks.id, pr.taskId));
                    console.log(
                      `  Task ${pr.taskId} marked as done (approved; auto-merge disabled)`,
                    );
                    handledApprovedWithoutMerge = true;
                  }

                  if (!handledApprovedWithoutMerge) {
                    const mergeQueueReason = actionResult.mergeDeferred
                      ? `Judge approved but merge deferred: ${actionResult.mergeDeferredReason ?? "pending_branch_sync"}`
                      : `Judge approved but merge was not completed${actionResult.mergeDeferredReason ? ` (${actionResult.mergeDeferredReason})` : ""}`;
                    const queueResult = await enqueueMergeQueueItem({
                      prNumber: pr.prNumber,
                      taskId: pr.taskId,
                      runId: pr.runId,
                      priority: pr.priority,
                      agentId: config.agentId,
                      reason: mergeQueueReason,
                    });
                    const duplicateSourceRun =
                      queueResult.reason.startsWith("duplicate_source_run:");
                    const duplicateSourceRunActive =
                      duplicateSourceRun &&
                      (queueResult.existingStatus === "pending" ||
                        queueResult.existingStatus === "processing");
                    if (
                      queueResult.enqueued ||
                      queueResult.reason.startsWith("existing_active_queue:") ||
                      duplicateSourceRunActive
                    ) {
                      await db
                        .update(tasks)
                        .set({
                          status: "blocked",
                          blockReason: "awaiting_judge",
                          updatedAt: new Date(),
                        })
                        .where(eq(tasks.id, pr.taskId));
                      console.warn(
                        `  Task ${pr.taskId} moved to merge queue (${queueResult.reason})`,
                      );
                    } else if (duplicateSourceRun) {
                      if (queueResult.existingStatus === "merged") {
                        await db
                          .update(tasks)
                          .set({
                            status: "done",
                            blockReason: null,
                            updatedAt: new Date(),
                          })
                          .where(eq(tasks.id, pr.taskId));
                        console.warn(
                          `  Task ${pr.taskId} marked done from duplicate source run (status=merged, queue=${queueResult.queueId ?? "unknown"})`,
                        );
                      } else if (
                        queueResult.existingStatus === "failed" ||
                        queueResult.existingStatus === "cancelled"
                      ) {
                        await db
                          .update(tasks)
                          .set({
                            status: "failed",
                            blockReason: null,
                            updatedAt: new Date(),
                          })
                          .where(eq(tasks.id, pr.taskId));
                        console.warn(
                          `  Task ${pr.taskId} marked failed from duplicate source run (status=${queueResult.existingStatus}, queue=${queueResult.queueId ?? "unknown"})`,
                        );
                      } else {
                        await scheduleTaskForJudgeRetry({
                          taskId: pr.taskId,
                          runId: pr.runId,
                          agentId: config.agentId,
                          reason: `judge_merge_queue_duplicate_source_unknown_status:${queueResult.existingStatus ?? "unknown"}`,
                          restoreRunImmediately: false,
                        });
                        console.warn(
                          `  Task ${pr.taskId} scheduled for judge retry (duplicate source run status unknown: ${queueResult.existingStatus ?? "unknown"})`,
                        );
                      }
                    } else {
                      await scheduleTaskForJudgeRetry({
                        taskId: pr.taskId,
                        runId: pr.runId,
                        agentId: config.agentId,
                        reason: `judge_merge_queue_enqueue_failed:${queueResult.reason}`,
                        restoreRunImmediately: false,
                      });
                      console.warn(
                        `  Task ${pr.taskId} scheduled for judge retry (merge queue enqueue failed: ${queueResult.reason})`,
                      );
                    }
                  }
                } else {
                  await db
                    .update(tasks)
                    .set({
                      status: "blocked",
                      blockReason: "needs_rework",
                      updatedAt: new Date(),
                    })
                    .where(eq(tasks.id, pr.taskId));
                }
              }
            } catch (error) {
              actionError = error;
              if (!config.dryRun) {
                requeueReason = buildJudgeFailureMessage(effectiveResult, error);
                await scheduleTaskForJudgeRetry({
                  taskId: pr.taskId,
                  runId: pr.runId,
                  agentId: config.agentId,
                  reason: `judge_action_error:${requeueReason}`,
                });
                console.warn(
                  `  Task ${pr.taskId} scheduled for judge retry due to judge action error`,
                );
              }
            }

            await recordJudgeReview(
              pr,
              effectiveResult,
              summary,
              actionResult,
              config.agentId,
              config.dryRun,
            );

            if (actionError) {
              throw actionError;
            }
          } catch (error) {
            console.error(`  Error processing PR #${pr.prNumber}:`, error);
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

    // Wait until next poll
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
