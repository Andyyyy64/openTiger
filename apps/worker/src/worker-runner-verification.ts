import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import {
  FAILURE_CODE,
  extractPolicyViolationPaths,
  loadPolicyRecoveryConfig,
  type Policy,
  type Task,
} from "@openTiger/core";
import { discardChangesForPaths } from "@openTiger/vcs";
import { eq } from "drizzle-orm";
import { executeTask, verifyChanges, type ExecuteResult, type VerifyResult } from "./steps/index";
import { persistGeneratedPathHints } from "./steps/verify/paths";
import { shouldAllowNoChanges } from "./worker-task-helpers";
import { finalizeTaskState } from "./worker-runner-state";
import { persistVisualProbeArtifacts } from "./worker-runner-artifacts";
import {
  appendContextNotes,
  buildExecuteFailureHint,
  buildVerifyRecoveryHint,
  encodeVerifyReworkMarker,
  isExecutionTimeout,
  isSetupBootstrapFailure,
  parseRecoveryAttempts,
  restoreExpectedBranchContext,
  shouldAttemptVerifyRecovery,
  summarizeVerificationFailure,
} from "./worker-runner-utils";
import type { WorkerResult } from "./worker-runner-types";
import { recordContextDeltaFailure } from "./context/context-delta";
import {
  applyAllowedPathAdjustments,
  parsePositiveIntEnv,
  recordPolicyRecoveryEvent,
  runPolicyRecoveryLlm,
  tryAutoAllowViolationPaths,
} from "./worker-runner-policy-recovery";
import {
  attemptGeneratedArtifactRecovery,
  buildLlmInlineRecoveryHandler,
  hasMeaningfulVerificationPass,
  resolveVerificationCommands,
  shouldEnableNoChangeVerificationFallback,
  summarizeVisualProbeResults,
} from "./worker-runner-verification-helpers";
// Re-export for backwards compatibility (used by tests)
export { selectGeneratedArtifactRecoveryCandidates } from "./worker-runner-verification-helpers";

interface RunVerificationPhaseOptions {
  repoPath: string;
  taskData: Task;
  taskId: string;
  runId: string;
  agentId: string;
  branchName: string;
  baseBranch: string;
  repoMode: "git" | "local";
  verificationAllowedPaths: string[];
  effectivePolicy: Policy;
  instructionsPath?: string;
  model?: string;
  retryHints: string[];
  executeResult: ExecuteResult;
  runtimeExecutorDisplayName: string;
}

type VerificationPhaseResult =
  | {
      success: true;
      verifyResult: VerifyResult;
      executeResult: ExecuteResult;
    }
  | {
      success: false;
      result: WorkerResult;
    };

export async function runVerificationPhase(
  options: RunVerificationPhaseOptions,
): Promise<VerificationPhaseResult> {
  const {
    repoPath,
    taskData,
    taskId,
    runId,
    agentId,
    branchName,
    baseBranch,
    repoMode,
    verificationAllowedPaths,
    effectivePolicy,
    instructionsPath,
    model,
    retryHints,
    runtimeExecutorDisplayName,
  } = options;
  let executeResult = options.executeResult;

  const llmInlineRecoveryEnabled =
    (process.env.WORKER_VERIFY_LLM_INLINE_RECOVERY ?? "true").toLowerCase() !== "false";
  const llmInlineRecoveryHandler = llmInlineRecoveryEnabled
    ? buildLlmInlineRecoveryHandler({
        repoPath,
        taskData,
        instructionsPath,
        model,
        effectivePolicy,
        branchName,
        runtimeExecutorDisplayName,
        retryHints,
      })
    : undefined;
  let effectiveAllowedPaths = [...verificationAllowedPaths];
  const verificationCommands = resolveVerificationCommands(taskData);
  const policyRecoveryConfig = await loadPolicyRecoveryConfig(repoPath);

  console.log("\n[5/7] Verifying changes...");
  let verifyResult = await verifyChanges({
    repoPath,
    commands: verificationCommands,
    allowedPaths: effectiveAllowedPaths,
    policy: effectivePolicy,
    baseBranch,
    headBranch: branchName,
    // Allow lockfile changes from pnpm install
    allowLockfileOutsidePaths: true,
    // Allow .env.example creation in local mode
    allowEnvExampleOutsidePaths: repoMode === "local",
    allowNoChanges: shouldAllowNoChanges(taskData),
    llmInlineRecoveryHandler,
  });

  const isNoChangeFailure = (message: string | undefined): boolean => {
    if (verifyResult.failureCode === FAILURE_CODE.NO_ACTIONABLE_CHANGES) {
      return true;
    }
    const normalized = (message ?? "").toLowerCase();
    return (
      normalized.includes("no changes were made") ||
      normalized.includes("no relevant changes were made")
    );
  };

  // Attempt self-repair within same process even when failing with no changes.
  // Skip recovery when the agent succeeded but intentionally made no changes
  // (e.g., the task was already implemented). The no-change verification
  // fallback below will still run and accept the result if verification passes.
  if (!verifyResult.success && isNoChangeFailure(verifyResult.error) && executeResult.success) {
    console.log(
      "[Worker] Agent completed successfully with no changes; skipping no-change recovery.",
    );
  } else if (!verifyResult.success && isNoChangeFailure(verifyResult.error)) {
    const noChangeRecoveryAttempts = parseRecoveryAttempts("WORKER_NO_CHANGE_RECOVERY_ATTEMPTS", 5);
    for (let attempt = 1; attempt <= noChangeRecoveryAttempts; attempt += 1) {
      const recoveryHint = "No changes detected. Make changes required to meet the task goal.";
      const recoveryHints = [recoveryHint, ...retryHints];
      console.warn(
        `[Worker] No changes detected; recovery attempt ${attempt}/${noChangeRecoveryAttempts}`,
      );
      executeResult = await executeTask({
        repoPath,
        task: taskData,
        instructionsPath,
        model,
        retryHints: recoveryHints,
        policy: effectivePolicy,
      });
      if (!executeResult.success) {
        continue;
      }
      verifyResult = await verifyChanges({
        repoPath,
        commands: verificationCommands,
        allowedPaths: effectiveAllowedPaths,
        policy: effectivePolicy,
        baseBranch,
        headBranch: branchName,
        allowLockfileOutsidePaths: true,
        allowEnvExampleOutsidePaths: repoMode === "local",
        allowNoChanges: shouldAllowNoChanges(taskData),
      });
      if (verifyResult.success) {
        break;
      }
    }
  }

  // Treat as no-op success when verification passes despite zero diff
  if (
    !verifyResult.success &&
    isNoChangeFailure(verifyResult.error) &&
    shouldEnableNoChangeVerificationFallback() &&
    verificationCommands.length > 0
  ) {
    console.warn(
      "[Worker] No diff detected after recovery attempts; running no-change verification fallback.",
    );
    const fallbackVerifyResult = await verifyChanges({
      repoPath,
      commands: verificationCommands,
      allowedPaths: effectiveAllowedPaths,
      policy: effectivePolicy,
      baseBranch,
      headBranch: branchName,
      allowLockfileOutsidePaths: true,
      allowEnvExampleOutsidePaths: repoMode === "local",
      allowNoChanges: true,
    });

    if (fallbackVerifyResult.success && hasMeaningfulVerificationPass(fallbackVerifyResult)) {
      console.log(
        "[Worker] No-change fallback verified successfully. Accepting no-op completion for this task.",
      );
      verifyResult = fallbackVerifyResult;
    } else if (!fallbackVerifyResult.success) {
      verifyResult = fallbackVerifyResult;
    } else {
      console.warn(
        "[Worker] No-change fallback skipped acceptance because no verification command produced a passing result.",
      );
    }
  }

  // On allowedPaths violation, attempt self-repair within same process instead of immediate fail
  if (!verifyResult.success && verifyResult.policyViolations.length > 0) {
    const nextAllowedPaths = await tryAutoAllowViolationPaths({
      taskData,
      taskId,
      allowedPaths: effectiveAllowedPaths,
      policyViolations: verifyResult.policyViolations,
      policyRecoveryConfig,
    });
    const autoAdjustedAllowedPaths = nextAllowedPaths !== effectiveAllowedPaths;
    effectiveAllowedPaths = nextAllowedPaths;

    if (autoAdjustedAllowedPaths) {
      verifyResult = await verifyChanges({
        repoPath,
        commands: verificationCommands,
        allowedPaths: effectiveAllowedPaths,
        policy: effectivePolicy,
        baseBranch,
        headBranch: branchName,
        allowLockfileOutsidePaths: true,
        allowEnvExampleOutsidePaths: repoMode === "local",
        allowNoChanges: shouldAllowNoChanges(taskData),
      });
    }

    if (!verifyResult.success && verifyResult.policyViolations.length > 0) {
      const policyRecoveryAttempts = parseRecoveryAttempts("WORKER_POLICY_RECOVERY_ATTEMPTS", 5);
      let llmDeniedRecovery = false;
      for (let attempt = 1; attempt <= policyRecoveryAttempts; attempt += 1) {
        await restoreExpectedBranchContext(repoPath, branchName, runtimeExecutorDisplayName);
        const llmRecovery = await runPolicyRecoveryLlm({
          repoPath,
          taskData,
          taskId,
          allowedPaths: effectiveAllowedPaths,
          deniedPaths: effectivePolicy.deniedPaths,
          policyViolations: verifyResult.policyViolations,
          changedFiles: verifyResult.changedFiles,
          model,
        });
        if (llmRecovery) {
          const llmApplied =
            llmRecovery.allowPaths.length > 0 || llmRecovery.discardPaths.length > 0;
          const decisionSummary = {
            allowCount: llmRecovery.allowPaths.length,
            discardCount: llmRecovery.discardPaths.length,
            denyCount: llmRecovery.denyPaths.length,
            droppedCount: llmRecovery.droppedPaths.length,
          };
          await recordPolicyRecoveryEvent({
            type: "task.policy_recovery_decided",
            taskId,
            runId,
            agentId,
            payload: {
              attempt,
              confidence: llmRecovery.confidence,
              summary: llmRecovery.summary ?? null,
              violatingPaths: llmRecovery.violatingPaths,
              model: llmRecovery.model,
              latencyMs: llmRecovery.latencyMs,
              decisionSummary,
              allowPaths: llmRecovery.allowPaths,
              discardPaths: llmRecovery.discardPaths,
              denyPaths: llmRecovery.denyPaths,
              droppedPaths: llmRecovery.droppedPaths,
              policyViolations: verifyResult.policyViolations,
            },
          });

          if (llmRecovery.discardPaths.length > 0) {
            const discardResult = await discardChangesForPaths(repoPath, llmRecovery.discardPaths);
            if (!discardResult.success) {
              console.warn(
                `[Worker] Failed to discard LLM-selected paths: ${discardResult.stderr || "(no stderr)"}`,
              );
            } else {
              console.log(
                `[Worker] Discarded LLM-selected paths: ${llmRecovery.discardPaths.join(", ")}`,
              );
              const learnedPaths = await persistGeneratedPathHints(
                repoPath,
                llmRecovery.discardPaths,
              );
              if (learnedPaths.length > 0) {
                console.log(
                  `[Worker] Learned generated artifact path hints: ${learnedPaths.join(", ")}`,
                );
              }
            }
          }

          if (llmRecovery.allowPaths.length > 0) {
            effectiveAllowedPaths = await applyAllowedPathAdjustments({
              taskId,
              allowedPaths: effectiveAllowedPaths,
              extraPaths: llmRecovery.allowPaths,
            });
          }

          if (llmApplied) {
            const appliedAction =
              llmRecovery.allowPaths.length > 0 && llmRecovery.discardPaths.length > 0
                ? "allow+discard"
                : llmRecovery.allowPaths.length > 0
                  ? "allow"
                  : "discard";
            await recordPolicyRecoveryEvent({
              type: "task.policy_recovery_applied",
              taskId,
              runId,
              agentId,
              payload: {
                attempt,
                action: appliedAction,
                violatingPaths: llmRecovery.violatingPaths,
                model: llmRecovery.model,
                latencyMs: llmRecovery.latencyMs,
                decisionSummary,
                allowedPaths: llmRecovery.allowPaths,
                discardedPaths: llmRecovery.discardPaths,
                nextAllowedPaths: effectiveAllowedPaths,
              },
            });
          }

          if (llmRecovery.denyPaths.length > 0 && !llmApplied) {
            llmDeniedRecovery = true;
            await recordPolicyRecoveryEvent({
              type: "task.policy_recovery_denied",
              taskId,
              runId,
              agentId,
              payload: {
                attempt,
                denyPaths: llmRecovery.denyPaths,
                summary: llmRecovery.summary ?? null,
                violatingPaths: llmRecovery.violatingPaths,
                model: llmRecovery.model,
                latencyMs: llmRecovery.latencyMs,
                decisionSummary,
              },
            });
            break;
          }

          if (llmApplied) {
            verifyResult = await verifyChanges({
              repoPath,
              commands: verificationCommands,
              allowedPaths: effectiveAllowedPaths,
              policy: effectivePolicy,
              baseBranch,
              headBranch: branchName,
              allowLockfileOutsidePaths: true,
              allowEnvExampleOutsidePaths: repoMode === "local",
              allowNoChanges: shouldAllowNoChanges(taskData),
            });
            if (verifyResult.success) {
              break;
            }
            if (verifyResult.policyViolations.length === 0) {
              console.log(
                "[Worker] Policy violations were resolved after LLM recovery; continuing with verification recovery.",
              );
              break;
            }
            continue;
          }
        }

        const violatingPaths = extractPolicyViolationPaths(verifyResult.policyViolations);
        if (violatingPaths.length > 0) {
          const cleanupResult = await discardChangesForPaths(repoPath, violatingPaths);
          if (!cleanupResult.success) {
            console.warn(
              `[Worker] Failed to clean policy-violating paths before recovery: ${cleanupResult.stderr || "(no stderr)"}`,
            );
          } else {
            console.log(
              `[Worker] Cleaned policy-violating paths before recovery: ${violatingPaths.join(", ")}`,
            );
            const learnedPaths = await persistGeneratedPathHints(repoPath, violatingPaths);
            if (learnedPaths.length > 0) {
              console.log(
                `[Worker] Learned generated artifact path hints: ${learnedPaths.join(", ")}`,
              );
            }
          }

          const verifyAfterCleanup = await verifyChanges({
            repoPath,
            commands: verificationCommands,
            allowedPaths: effectiveAllowedPaths,
            policy: effectivePolicy,
            baseBranch,
            headBranch: branchName,
            allowLockfileOutsidePaths: true,
            allowEnvExampleOutsidePaths: repoMode === "local",
            allowNoChanges: shouldAllowNoChanges(taskData),
          });
          verifyResult = verifyAfterCleanup;
          if (verifyResult.success) {
            console.log(
              "[Worker] Verification passed after cleaning policy-violating paths; skipping recovery execution.",
            );
            break;
          }
          if (verifyResult.policyViolations.length === 0) {
            console.log(
              "[Worker] Policy violations cleared after cleanup; deferring remaining failures to standard verification recovery.",
            );
            break;
          }
        }

        const policyHint = `Remove changes outside allowedPaths and confine edits to allowed paths only: ${verifyResult.policyViolations.join(", ")}`;
        const recoveryHints = [policyHint, ...retryHints];
        console.warn(
          `[Worker] Policy violations detected; recovery attempt ${attempt}/${policyRecoveryAttempts}`,
        );
        executeResult = await executeTask({
          repoPath,
          task: taskData,
          instructionsPath,
          model,
          retryHints: recoveryHints,
          policy: effectivePolicy,
        });
        if (!executeResult.success) {
          continue;
        }
        verifyResult = await verifyChanges({
          repoPath,
          commands: verificationCommands,
          allowedPaths: effectiveAllowedPaths,
          policy: effectivePolicy,
          baseBranch,
          headBranch: branchName,
          allowLockfileOutsidePaths: true,
          allowEnvExampleOutsidePaths: repoMode === "local",
          allowNoChanges: shouldAllowNoChanges(taskData),
        });
        if (verifyResult.success) {
          break;
        }
      }
      if (llmDeniedRecovery && !verifyResult.success && verifyResult.policyViolations.length > 0) {
        console.warn(
          "[Worker] Policy recovery was denied by LLM decision; escalating to blocked for explicit follow-up.",
        );
      }
    }
  }

  if (!verifyResult.success && verifyResult.policyViolations.length > 0) {
    const generatedArtifactRecovery = await attemptGeneratedArtifactRecovery({
      repoPath,
      verifyResult,
      verificationCommands,
      allowedPaths: effectiveAllowedPaths,
      policy: effectivePolicy,
      baseBranch,
      headBranch: branchName,
      repoMode,
      allowNoChanges: shouldAllowNoChanges(taskData),
    });
    if (generatedArtifactRecovery) {
      verifyResult = generatedArtifactRecovery;
    }
  }

  const verifyRecoveryAttempts = parseRecoveryAttempts("WORKER_VERIFY_RECOVERY_ATTEMPTS", 5);
  const allowExplicitVerifyRecovery =
    (process.env.WORKER_VERIFY_RECOVERY_ALLOW_EXPLICIT ?? "true").toLowerCase() !== "false";

  if (
    !verifyResult.success &&
    shouldAttemptVerifyRecovery(verifyResult, allowExplicitVerifyRecovery)
  ) {
    let lastExecuteFailureHint: string | undefined;
    for (let attempt = 1; attempt <= verifyRecoveryAttempts; attempt += 1) {
      const failedCommand = verifyResult.failedCommand ?? "(unknown command)";
      const isSetupFailure = isSetupBootstrapFailure(verifyResult);
      const recoveryHint = buildVerifyRecoveryHint({
        verifyResult,
        attempt,
        maxAttempts: verifyRecoveryAttempts,
      });
      const recoveryHints = [
        recoveryHint,
        ...(lastExecuteFailureHint ? [lastExecuteFailureHint] : []),
        ...retryHints,
      ];
      const failureLabel = isSetupFailure ? "setup/bootstrap" : "verification";
      console.warn(
        `[Worker] ${failureLabel} failed at ${failedCommand}; recovery attempt ${attempt}/${verifyRecoveryAttempts}`,
      );
      executeResult = await executeTask({
        repoPath,
        task: taskData,
        instructionsPath,
        model,
        retryHints: recoveryHints,
        policy: effectivePolicy,
        verificationRecovery: {
          attempt,
          failedCommand,
          failedCommandSource: verifyResult.failedCommandSource,
          failedCommandStderr: verifyResult.failedCommandStderr,
        },
      });

      if (!executeResult.success) {
        const isTimeout = isExecutionTimeout(
          executeResult.openCodeResult.stderr,
          executeResult.openCodeResult.exitCode,
        );
        if (isTimeout) {
          console.warn(
            "[Worker] Verification recovery execution timed out; continuing to re-verify changes.",
          );
          lastExecuteFailureHint = undefined;
        } else {
          lastExecuteFailureHint = buildExecuteFailureHint(
            executeResult.openCodeResult.stderr,
            executeResult.error,
          );
          console.warn(`[Worker] Recovery execution failed; context will carry to next attempt.`);
          continue;
        }
      } else {
        lastExecuteFailureHint = undefined;
      }

      await restoreExpectedBranchContext(repoPath, branchName, runtimeExecutorDisplayName);
      verifyResult = await verifyChanges({
        repoPath,
        commands: verificationCommands,
        allowedPaths: effectiveAllowedPaths,
        policy: effectivePolicy,
        baseBranch,
        headBranch: branchName,
        allowLockfileOutsidePaths: true,
        allowEnvExampleOutsidePaths: repoMode === "local",
        allowNoChanges: shouldAllowNoChanges(taskData),
        llmInlineRecoveryHandler,
      });
      if (verifyResult.success) {
        break;
      }
      if (!shouldAttemptVerifyRecovery(verifyResult, allowExplicitVerifyRecovery)) {
        break;
      }
    }
  }

  for (const probe of verifyResult.visualProbeResults ?? []) {
    try {
      const persisted = await persistVisualProbeArtifacts({
        runId,
        repoPath,
        probeId: probe.id,
        status: probe.status,
        message: probe.message,
        artifactPaths: probe.artifactPaths,
        metrics: probe.metrics,
      });
      if (persisted > 0) {
        console.log(`[Worker] Saved ${persisted} visual probe artifact(s) for ${probe.id}.`);
      }
    } catch (error) {
      console.warn(
        `[Worker] Failed to persist visual probe artifacts for ${probe.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (!verifyResult.success) {
    const visualProbes = summarizeVisualProbeResults(verifyResult);
    if (verifyResult.policyViolations.length > 0) {
      const errorMessage =
        verifyResult.error ?? `Policy violations: ${verifyResult.policyViolations.join(", ")}`;
      console.warn("[Worker] Policy violations detected; deferring to rework flow.");
      await recordContextDeltaFailure({
        message: errorMessage,
        failedCommand: verifyResult.failedCommand,
      }).catch(() => undefined);
      await finalizeTaskState({
        runId,
        taskId,
        agentId,
        runStatus: "failed",
        taskStatus: "blocked",
        blockReason: "needs_rework",
        costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
        errorMessage,
        errorMeta: {
          source: "verification",
          failureCode: verifyResult.failureCode ?? FAILURE_CODE.POLICY_VIOLATION,
          failedCommand: verifyResult.failedCommand ?? null,
          failedCommandSource: verifyResult.failedCommandSource ?? null,
          failedCommandStderr: summarizeVerificationFailure(
            verifyResult.failedCommandStderr ?? verifyResult.error,
          ),
          policyViolations: verifyResult.policyViolations,
          visualProbes,
        },
      });
      return {
        success: false,
        result: {
          success: false,
          taskId,
          runId,
          error: errorMessage,
        },
      };
    }
    if (!verifyResult.failedCommand?.trim()) {
      const fallbackFailureCode =
        verifyResult.failureCode ?? FAILURE_CODE.VERIFICATION_COMMAND_FAILED;
      const errorMessage = verifyResult.error ?? "Verification commands failed";
      console.warn("[Worker] Verification failed without failed command metadata.");
      await finalizeTaskState({
        runId,
        taskId,
        agentId,
        runStatus: "failed",
        taskStatus: "blocked",
        blockReason: "needs_rework",
        costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
        errorMessage,
        errorMeta: {
          source: "verification",
          failureCode: fallbackFailureCode,
          failedCommand: null,
          failedCommandSource: verifyResult.failedCommandSource ?? null,
          failedCommandStderr: summarizeVerificationFailure(
            verifyResult.failedCommandStderr ?? verifyResult.error,
          ),
          policyViolations: verifyResult.policyViolations,
          visualProbes,
        },
      });
      return {
        success: false,
        result: {
          success: false,
          taskId,
          runId,
          error: errorMessage,
        },
      };
    }
    const failedCommand = verifyResult.failedCommand ?? "(unknown command)";
    const failedSource = verifyResult.failedCommandSource ?? "explicit";
    const stderrSummary = summarizeVerificationFailure(
      verifyResult.failedCommandStderr ?? verifyResult.error,
    );
    const verifyMarker = encodeVerifyReworkMarker({
      failedCommand,
      failedCommandSource: failedSource,
      stderrSummary,
    });
    const existingNotes = taskData.context?.notes;
    const markerPrefix = "[verify-rework-json]";
    const hasVerifyMarker = existingNotes?.includes(markerPrefix) ?? false;
    const notesToAppend = hasVerifyMarker
      ? []
      : [
          "[verify-rework] Verification command failure requires focused rework.",
          `failed_command: ${failedCommand}`,
          `failed_source: ${failedSource}`,
          `failed_stderr: ${stderrSummary}`,
          verifyMarker,
        ];
    if (notesToAppend.length > 0) {
      const updatedContext = {
        ...taskData.context,
        notes: appendContextNotes(existingNotes, notesToAppend),
      };
      await db
        .update(tasks)
        .set({
          context: updatedContext,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
    }

    const errorMessage =
      verifyResult.error ??
      `Verification failed at ${failedCommand} [${failedSource}]: ${stderrSummary}`;
    console.warn("[Worker] Verification failure detected; deferring to rework flow.");
    await recordContextDeltaFailure({
      message: errorMessage,
      failedCommand,
    }).catch(() => undefined);
    await finalizeTaskState({
      runId,
      taskId,
      agentId,
      runStatus: "failed",
      taskStatus: "blocked",
      blockReason: "needs_rework",
      costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
      errorMessage,
      errorMeta: {
        source: "verification",
        failureCode: verifyResult.failureCode ?? FAILURE_CODE.VERIFICATION_COMMAND_FAILED,
        failedCommand,
        failedCommandSource: failedSource,
        failedCommandStderr: stderrSummary,
        visualProbes,
      },
    });
    return {
      success: false,
      result: {
        success: false,
        taskId,
        runId,
        error: errorMessage,
      },
    };
  }

  return {
    success: true,
    verifyResult,
    executeResult,
  };
}
