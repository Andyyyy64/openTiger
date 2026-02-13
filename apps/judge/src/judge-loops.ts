import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { reviewAndAct } from "./pr-reviewer";
import { createDocserTaskForPR } from "./docser";
import {
  JUDGE_AUTO_FIX_MAX_ATTEMPTS,
  JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES,
  JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES,
  formatJudgeAutoFixLimit,
  type JudgeConfig,
} from "./judge-config";
import { getPendingPRs, getPendingResearchRuns } from "./judge-pending";
import { safeSetJudgeAgentState } from "./judge-agent";
import { recordJudgeReview, recordResearchReview } from "./judge-events";
import {
  judgeSinglePR,
  buildJudgeFailureMessage,
  hasActionableLLMFailures,
  isDoomLoopFailure,
  isNonActionableLLMFailure,
} from "./judge-evaluate";
import { evaluateResearchRun, markResearchJobAfterJudge } from "./judge-research";
import {
  createAutoFixTaskForPr,
  closeConflictPrAndCreateMainlineTask,
  createConflictAutoFixTaskForPr,
  hasMergeConflictSignals,
  isConflictAutoFixAttemptLimitReason,
} from "./judge-autofix";
import {
  getTaskRetryCount,
  scheduleTaskForJudgeRetry,
  isImportedPrReviewTask,
  recoverAwaitingJudgeBacklog,
  claimRunForJudgement,
  requeueTaskAfterJudge,
} from "./judge-retry";

function hasActiveAutoFix(reason: string): boolean {
  return (
    reason.startsWith("existing_active_autofix:") ||
    reason.startsWith("existing_active_conflict_autofix:")
  );
}

function hasActiveMainlineRecreate(reason: string): boolean {
  return reason.startsWith("existing_active_mainline_recreate:");
}

export async function runJudgeLoop(config: JudgeConfig): Promise<void> {
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
                    // If approve but merge didn't complete, send conflict-related ones to AutoFix, others back to judge retry
                    let handledByConflictAutoFix = false;
                    const conflictSignals = hasMergeConflictSignals({
                      summary,
                      mergeDeferredReason: actionResult.mergeDeferredReason,
                    });
                    if (conflictSignals && !actionResult.mergeDeferred) {
                      const conflictAutoFix = await createConflictAutoFixTaskForPr({
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
                        mergeDeferredReason: actionResult.mergeDeferredReason,
                      });

                      if (conflictAutoFix.created) {
                        await db
                          .update(tasks)
                          .set({
                            status: "blocked",
                            blockReason: "needs_rework",
                            updatedAt: new Date(),
                          })
                          .where(eq(tasks.id, pr.taskId));
                        console.warn(
                          `  Task ${pr.taskId} blocked as needs_rework; conflict auto-fix task queued: ${conflictAutoFix.taskId}`,
                        );
                        handledByConflictAutoFix = true;
                      } else {
                        if (hasActiveAutoFix(conflictAutoFix.reason)) {
                          await db
                            .update(tasks)
                            .set({
                              status: "blocked",
                              blockReason: "needs_rework",
                              updatedAt: new Date(),
                            })
                            .where(eq(tasks.id, pr.taskId));
                          console.warn(
                            `  Task ${pr.taskId} remains blocked as needs_rework (active conflict autofix in progress: ${conflictAutoFix.reason})`,
                          );
                          handledByConflictAutoFix = true;
                        } else if (isConflictAutoFixAttemptLimitReason(conflictAutoFix.reason)) {
                          const recreateResult = await closeConflictPrAndCreateMainlineTask({
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
                            conflictAutoFixReason: conflictAutoFix.reason,
                            mergeDeferredReason: actionResult.mergeDeferredReason,
                          });

                          if (
                            recreateResult.created ||
                            hasActiveMainlineRecreate(recreateResult.reason)
                          ) {
                            await db
                              .update(tasks)
                              .set({
                                status: "failed",
                                blockReason: null,
                                updatedAt: new Date(),
                              })
                              .where(eq(tasks.id, pr.taskId));
                            const recreateState = recreateResult.created
                              ? `queued:${recreateResult.taskId}`
                              : recreateResult.reason;
                            const closeState = recreateResult.closed ? "closed" : "close_failed";
                            console.warn(
                              `  Task ${pr.taskId} conflict-autofix limit reached; source task failed, PR ${pr.prNumber} close=${closeState}, recreate=${recreateState}`,
                            );
                            handledByConflictAutoFix = true;
                          } else {
                            const fallbackReason =
                              "Judge approved but conflict autofix attempt limit fallback failed " +
                              `(${recreateResult.reason})`;
                            await scheduleTaskForJudgeRetry({
                              taskId: pr.taskId,
                              runId: pr.runId,
                              agentId: config.agentId,
                              reason: fallbackReason,
                              restoreRunImmediately: false,
                            });
                            console.warn(
                              `  Task ${pr.taskId} scheduled for judge retry (limit fallback failed: ${recreateResult.reason})`,
                            );
                          }
                        } else {
                          const fallbackReason = `Judge approved but merge conflict auto-fix was not queued (${conflictAutoFix.reason})`;
                          await scheduleTaskForJudgeRetry({
                            taskId: pr.taskId,
                            runId: pr.runId,
                            agentId: config.agentId,
                            reason: fallbackReason,
                            restoreRunImmediately: false,
                          });
                          console.warn(
                            `  Task ${pr.taskId} scheduled for judge retry (conflict autofix fallback: ${conflictAutoFix.reason})`,
                          );
                        }
                      }
                      // Keep review record for continuity
                    }

                    if (!handledByConflictAutoFix) {
                      const retryReason = actionResult.mergeDeferred
                        ? `Judge approved but merge deferred: ${actionResult.mergeDeferredReason ?? "pending_branch_sync"}`
                        : `Judge approved but merge was not completed${actionResult.mergeDeferredReason ? ` (${actionResult.mergeDeferredReason})` : ""}`;
                      await scheduleTaskForJudgeRetry({
                        taskId: pr.taskId,
                        runId: pr.runId,
                        agentId: config.agentId,
                        reason: retryReason,
                        // If update-branch was triggered, don't re-evaluate the same run until cooldown
                        restoreRunImmediately: !actionResult.mergeDeferred,
                      });
                      console.warn(
                        `  Task ${pr.taskId} scheduled for judge retry because merge did not complete`,
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

      const pendingResearchRuns = await getPendingResearchRuns();

      if (pendingResearchRuns.length > 0) {
        await safeSetJudgeAgentState(config.agentId, "busy");
        console.log(`\nFound ${pendingResearchRuns.length} research runs to review`);

        for (const pending of pendingResearchRuns) {
          let taskStateTransitioned = false;
          try {
            await safeSetJudgeAgentState(config.agentId, "busy", pending.taskId);
            if (!config.dryRun) {
              const claimed = await claimRunForJudgement(pending.runId);
              if (!claimed) {
                console.log(`  Skip research run ${pending.runId}: run already judged`);
                await safeSetJudgeAgentState(config.agentId, "busy");
                continue;
              }
            }

            const { result, summary, metrics } = await evaluateResearchRun(pending);
            const actionResult = {
              approved: false,
              requeued: false,
              blocked: false,
            };

            if (!config.dryRun) {
              if (result.verdict === "approve") {
                await db
                  .update(tasks)
                  .set({
                    status: "done",
                    blockReason: null,
                    updatedAt: new Date(),
                  })
                  .where(eq(tasks.id, pending.taskId));
                taskStateTransitioned = true;
                await markResearchJobAfterJudge({
                  jobId: pending.researchJobId,
                  verdict: "approve",
                  runId: pending.runId,
                  agentId: config.agentId,
                  notes: result.reasons,
                  statusOverride: "done",
                });
                actionResult.approved = true;
                console.log(`  Research task ${pending.taskId} marked as done`);
              } else {
                await db
                  .update(tasks)
                  .set({
                    status: "blocked",
                    blockReason: "needs_rework",
                    updatedAt: new Date(),
                  })
                  .where(eq(tasks.id, pending.taskId));
                taskStateTransitioned = true;
                await markResearchJobAfterJudge({
                  jobId: pending.researchJobId,
                  verdict: "request_changes",
                  runId: pending.runId,
                  agentId: config.agentId,
                  notes: result.reasons,
                  statusOverride: "blocked",
                });
                actionResult.blocked = true;
                console.log(`  Research task ${pending.taskId} blocked as needs_rework`);
              }
            }

            await recordResearchReview(
              {
                taskId: pending.taskId,
                runId: pending.runId,
                researchJobId: pending.researchJobId,
                role: pending.role,
              },
              result,
              summary,
              actionResult,
              metrics,
              config.agentId,
              config.dryRun,
            );
          } catch (error) {
            if (!config.dryRun && !taskStateTransitioned) {
              const reason =
                error instanceof Error ? error.message : "unknown_research_review_error";
              await scheduleTaskForJudgeRetry({
                taskId: pending.taskId,
                runId: pending.runId,
                agentId: config.agentId,
                reason: `judge_research_error:${reason}`,
                restoreRunImmediately: true,
              });
              console.warn(
                `  Research task ${pending.taskId} scheduled for judge retry due to processing error`,
              );
            }
            console.error(`  Error processing research run ${pending.runId}:`, error);
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

    // Wait until next poll
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
