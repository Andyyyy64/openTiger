import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { reviewAndAct } from "./pr-reviewer.js";
import { createDocserTaskForPR } from "./docser.js";
import {
  JUDGE_AUTO_FIX_MAX_ATTEMPTS,
  JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES,
  JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES,
  formatJudgeAutoFixLimit,
  type JudgeConfig,
} from "./judge-config.js";
import { getPendingPRs } from "./judge-pending.js";
import { safeSetJudgeAgentState } from "./judge-agent.js";
import { recordJudgeReview } from "./judge-events.js";
import {
  judgeSinglePR,
  buildJudgeFailureMessage,
  hasActionableLLMFailures,
  isDoomLoopFailure,
  isNonActionableLLMFailure,
} from "./judge-evaluate.js";
import {
  createAutoFixTaskForPr,
  createConflictAutoFixTaskForPr,
  hasMergeConflictSignals,
} from "./judge-autofix.js";
import {
  requeueTaskAfterJudge,
  getTaskRetryCount,
  scheduleTaskForJudgeRetry,
  isImportedPrReviewTask,
  recoverAwaitingJudgeBacklog,
  claimRunForJudgement,
} from "./judge-retry.js";

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
    }`
  );
  console.log("=".repeat(60));

  while (true) {
    try {
      const recoveredAwaiting = await recoverAwaitingJudgeBacklog(config.agentId);
      if (recoveredAwaiting > 0) {
        console.log(`[Judge] Recovered ${recoveredAwaiting} awaiting_judge task(s) by restoring runs`);
      }

      // レビュー待ちのPRを取得
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
                // レビューとアクションを実行
                actionResult = await reviewAndAct(pr.prNumber, effectiveResult, summary);
                console.log(
                  `  Actions: commented=${actionResult.commented}, approved=${actionResult.approved}, merged=${actionResult.merged}`
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
                          `  Task ${pr.taskId} blocked as needs_rework; auto-fix task queued: ${autoFix.taskId}`
                        );
                      } else {
                        requeueReason = `${buildJudgeFailureMessage(effectiveResult)} | ${autoFix.reason}`;
                        if (importedPrReviewTask) {
                          await scheduleTaskForJudgeRetry({
                            taskId: pr.taskId,
                            runId: pr.runId,
                            agentId: config.agentId,
                            reason: `retry_imported_pr_review:${requeueReason}`,
                          });
                          console.log(
                            `  Task ${pr.taskId} scheduled for judge retry (${effectiveResult.verdict})`
                          );
                        } else {
                          await requeueTaskAfterJudge({
                            taskId: pr.taskId,
                            runId: pr.runId,
                            agentId: config.agentId,
                            reason: requeueReason,
                          });
                          console.log(
                            `  Task ${pr.taskId} requeued by judge verdict (${effectiveResult.verdict})`
                          );
                        }
                      }
                    } else {
                      const doomLoopThreshold = Number.isFinite(JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES)
                        ? Math.max(1, JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES)
                        : 2;
                      const isDoomLoop = isDoomLoopFailure(summary);
                      const currentRetryCount = await getTaskRetryCount(pr.taskId);
                      const shouldTripCircuitBreaker = isDoomLoop
                        && currentRetryCount >= doomLoopThreshold;

                      if (shouldTripCircuitBreaker) {
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
                            `  Task ${pr.taskId} hit doom-loop circuit breaker; auto-fix task queued: ${autoFix.taskId}`
                          );
                        } else {
                          requeueReason = `${buildJudgeFailureMessage(effectiveResult)} | doom_loop_circuit_breaker_failed:${autoFix.reason}`;
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
                            `  Task ${pr.taskId} doom-loop breaker fallback to judge retry (${autoFix.reason})`
                          );
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
                          `  Task ${pr.taskId} scheduled for judge retry after cooldown (${marker})`
                        );
                      }
                    }
                  } else {
                    // CI/Policy系の非approveは再キューし、閾値超過でAutoFixへ昇格
                    const retryThreshold = Number.isFinite(JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES)
                      ? Math.max(1, JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES)
                      : 2;
                    const currentRetryCount = await getTaskRetryCount(pr.taskId);
                    const shouldEscalate = currentRetryCount >= retryThreshold;

                    if (shouldEscalate) {
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
                          `  Task ${pr.taskId} hit non-approve circuit breaker; auto-fix task queued: ${autoFix.taskId}`
                        );
                      } else {
                        await db
                          .update(tasks)
                          .set({
                            status: "blocked",
                            blockReason: "needs_rework",
                            updatedAt: new Date(),
                          })
                          .where(eq(tasks.id, pr.taskId));
                        console.warn(
                          `  Task ${pr.taskId} blocked as needs_rework; non-approve circuit breaker fallback (${autoFix.reason})`
                        );
                      }
                    } else {
                      requeueReason = buildJudgeFailureMessage(effectiveResult);
                      if (importedPrReviewTask) {
                        await scheduleTaskForJudgeRetry({
                          taskId: pr.taskId,
                          runId: pr.runId,
                          agentId: config.agentId,
                          reason: `retry_imported_pr_review:${requeueReason}`,
                        });
                        console.log(
                          `  Task ${pr.taskId} scheduled for judge retry (${effectiveResult.verdict})`
                        );
                      } else {
                        await requeueTaskAfterJudge({
                          taskId: pr.taskId,
                          runId: pr.runId,
                          agentId: config.agentId,
                          reason: requeueReason,
                        });
                        console.log(
                          `  Task ${pr.taskId} requeued by judge verdict (${effectiveResult.verdict})`
                        );
                      }
                    }
                  }
                } else if (effectiveResult.verdict === "approve") {
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
                        `  Task ${pr.taskId} blocked as needs_rework; conflict auto-fix task queued: ${conflictAutoFix.taskId}`
                      );
                      handledByConflictAutoFix = true;
                    } else {
                      const fallbackReason =
                        `Judge approved but merge conflict auto-fix was not queued (${conflictAutoFix.reason})`;
                      await scheduleTaskForJudgeRetry({
                        taskId: pr.taskId,
                        runId: pr.runId,
                        agentId: config.agentId,
                        reason: fallbackReason,
                        restoreRunImmediately: false,
                      });
                      console.warn(
                        `  Task ${pr.taskId} scheduled for judge retry (conflict autofix fallback: ${conflictAutoFix.reason})`
                      );
                    }
                    // レビュー記録は継続して残す
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
                    console.warn(`  Task ${pr.taskId} scheduled for judge retry because merge did not complete`);
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
                console.warn(`  Task ${pr.taskId} scheduled for judge retry due to judge action error`);
              }
            }

            await recordJudgeReview(
              pr,
              effectiveResult,
              summary,
              actionResult,
              config.agentId,
              config.dryRun
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
    } catch (error) {
      console.error("Judge loop error:", error);
    } finally {
      await safeSetJudgeAgentState(config.agentId, "idle");
    }

    // 次のポーリングまで待機
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}
