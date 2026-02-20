import { SYSTEM_ENTITY_ID } from "@openTiger/core";
import {
  startNewCycle,
  endCurrentCycle,
  checkCycleEnd,
  getCycleState,
  calculateCycleStats,
} from "../cycle-controller";
import {
  performFullCleanup,
  cleanupExpiredLeases,
  resetOfflineAgents,
  cancelStuckRuns,
  recoverStaleMergeQueueClaims,
  requeueFailedTasksWithCooldown,
  requeueBlockedTasksWithCooldown,
} from "../cleaners/index";
import {
  recordEvent,
  getCostSummary,
  runAllAnomalyChecks,
  checkCostLimits,
} from "../monitors/index";
import { captureSystemState, persistState, updateCycleStats } from "../state-manager";
import type { CycleManagerConfig } from "./config";
import {
  isReplanInProgress,
  markReplanSkipped,
  shouldTriggerReplan,
  triggerReplan,
} from "./replan";
import { syncIssueBacklogViaPreflight } from "./backlog-preflight";
import { hasCycleManagerPluginBacklog, runCycleManagerPluginMonitorTicks } from "../plugins";

const CYCLE_ENDING_CRITICAL_ANOMALIES = new Set(["stuck_task"]);
const CRITICAL_ANOMALY_RESTART_COOLDOWN_MS = (() => {
  const raw = Number.parseInt(
    process.env.CYCLE_CRITICAL_ANOMALY_RESTART_COOLDOWN_MS ?? "300000",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();
const CYCLE_MIN_AGE_FOR_CRITICAL_RESTART_MS = (() => {
  const raw = Number.parseInt(process.env.CYCLE_MIN_AGE_FOR_CRITICAL_RESTART_MS ?? "120000", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2 * 60 * 1000;
})();
const lastCriticalRestartByType = new Map<string, number>();

function hasTaskBacklog(state: Awaited<ReturnType<typeof captureSystemState>>): boolean {
  return (
    state.tasks.queued > 0 ||
    state.tasks.running > 0 ||
    state.tasks.blocked > 0 ||
    state.tasks.failed > 0
  );
}

function getCycleAgeMs(startedAt: Date | null): number {
  if (!startedAt) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Date.now() - startedAt.getTime());
}

function selectRestartableCriticalAnomalies(
  anomalies: Array<{ type: string; severity: "warning" | "critical" }>,
): Array<{ type: string; severity: "warning" | "critical" }> {
  const nowMs = Date.now();
  return anomalies.filter((anomaly) => {
    const lastRestartAt = lastCriticalRestartByType.get(anomaly.type) ?? 0;
    return nowMs - lastRestartAt >= CRITICAL_ANOMALY_RESTART_COOLDOWN_MS;
  });
}

function markCriticalRestarted(anomalies: Array<{ type: string }>): void {
  const nowMs = Date.now();
  for (const anomaly of anomalies) {
    lastCriticalRestartByType.set(anomaly.type, nowMs);
  }
}

// Monitor loop
export async function runMonitorLoop(config: CycleManagerConfig): Promise<void> {
  try {
    const state = getCycleState();

    if (!state.isRunning) {
      return;
    }

    // Cycle end check
    const { shouldEnd, triggerType } = await checkCycleEnd();

    if (shouldEnd && triggerType) {
      console.log(`[CycleManager] Cycle end triggered by: ${triggerType}`);

      await recordEvent({
        type: "cycle.end_triggered",
        entityType: state.cycleId ? "cycle" : "system",
        entityId: state.cycleId ?? SYSTEM_ENTITY_ID,
        payload: {
          triggerType,
          usedSystemEntityFallback: !state.cycleId,
        },
      });

      // Cycle end handling
      await endCurrentCycle(triggerType);

      // Cleanup
      if (state.config.cleanupOnEnd) {
        await performFullCleanup(state.config.preserveTaskState);
      }

      // Start new cycle
      await startNewCycle();

      console.log("[CycleManager] New cycle started after cleanup");
    }

    // Anomaly detection
    const anomalies = await runAllAnomalyChecks();
    if (anomalies.length > 0) {
      console.log(`[CycleManager] Detected ${anomalies.length} anomalies`);

      // End cycle if critical anomaly
      const criticalAnomalies = anomalies.filter((a) => a.severity === "critical");
      const endingCriticalAnomalies = criticalAnomalies.filter((anomaly) =>
        CYCLE_ENDING_CRITICAL_ANOMALIES.has(anomaly.type),
      );
      if (endingCriticalAnomalies.length > 0) {
        const cycleAgeMs = getCycleAgeMs(state.startedAt);
        const restartableAnomalies = selectRestartableCriticalAnomalies(endingCriticalAnomalies);
        if (cycleAgeMs < CYCLE_MIN_AGE_FOR_CRITICAL_RESTART_MS) {
          console.warn(
            `[CycleManager] Critical anomaly restart deferred: cycle age ${cycleAgeMs}ms < min ${CYCLE_MIN_AGE_FOR_CRITICAL_RESTART_MS}ms`,
          );
        } else if (restartableAnomalies.length > 0) {
          console.log("[CycleManager] Critical anomalies detected, ending cycle");
          markCriticalRestarted(restartableAnomalies);
          await endCurrentCycle("critical_anomaly");
          await performFullCleanup(true);
          await startNewCycle();
        } else {
          console.warn(
            "[CycleManager] Critical anomalies detected, but restart suppressed by cooldown window",
          );
        }
      } else if (criticalAnomalies.length > 0) {
        const nonRestartingTypes = criticalAnomalies.map((anomaly) => anomaly.type).join(", ");
        console.warn(
          `[CycleManager] Critical anomaly detected, but cycle restart skipped (non-restart type: ${nonRestartingTypes})`,
        );
      }
    }

    // Cost limit check
    const costStatus = await checkCostLimits();
    if (!costStatus.isWithinLimits) {
      console.warn("[CycleManager] Cost limits exceeded:", costStatus.warnings);
      // Pause new task execution on cost over; notify Dispatcher separately
      await recordEvent({
        type: "cost.limit_exceeded",
        entityType: "system",
        entityId: SYSTEM_ENTITY_ID,
        payload: costStatus,
      });
    }

    await runCycleManagerPluginMonitorTicks();

    // When task backlog depleted:
    // 1) Continue while local tasks remain
    // 2) When empty, sync issue/preflight to refill issues
    // 3) If no issues, run planner again
    // Check replanInProgress first to avoid race
    if (isReplanInProgress()) {
      // Do nothing while planner runs
    } else {
      let systemState = await captureSystemState();
      let pluginHasBacklog = await hasCycleManagerPluginBacklog();

      if (!hasTaskBacklog(systemState) && !pluginHasBacklog) {
        const issueSyncResult = await syncIssueBacklogViaPreflight(config);
        if (!issueSyncResult.success) {
          console.warn(
            `[CycleManager] Skip replan: issue preflight failed (${issueSyncResult.reason ?? "unknown"})`,
            issueSyncResult.warnings,
          );
          return;
        }

        if (issueSyncResult.generatedTaskCount > 0) {
          console.log(
            `[CycleManager] Issue preflight created ${issueSyncResult.generatedTaskCount} task(s). Prioritizing issue backlog.`,
          );
        }

        if (issueSyncResult.hasIssueBacklog) {
          console.log(
            `[CycleManager] Issue backlog detected (${issueSyncResult.issueTaskBacklogCount}). Replan deferred.`,
          );
          return;
        }

        // Re-fetch state in case preflight created tasks
        systemState = await captureSystemState();
        pluginHasBacklog = await hasCycleManagerPluginBacklog();
        if (hasTaskBacklog(systemState) || pluginHasBacklog) {
          return;
        }
      }

      if (pluginHasBacklog) {
        return;
      }

      const replanDecision = await shouldTriggerReplan(systemState, config);
      if (replanDecision.shouldRun) {
        await triggerReplan(systemState, replanDecision.signature, config);
      } else if (replanDecision.reason === "no_diff") {
        markReplanSkipped();
        await recordEvent({
          type: "planner.replan_skipped",
          entityType: "system",
          entityId: SYSTEM_ENTITY_ID,
          payload: {
            reason: "no_diff",
            signature: replanDecision.signature?.signature,
            requirementHash: replanDecision.signature?.requirementHash,
            repoHeadSha: replanDecision.signature?.repoHeadSha,
          },
        });
      }
    }
  } catch (error) {
    console.error("[CycleManager] Monitor loop error:", error);
  }
}

// Cleanup loop
export async function runCleanupLoop(config: CycleManagerConfig): Promise<void> {
  try {
    // Clean up expired leases
    const expiredLeases = await cleanupExpiredLeases();
    if (expiredLeases > 0) {
      console.log(`[Cleanup] Released ${expiredLeases} expired leases`);
    }

    // Reset offline agents
    const offlineAgents = await resetOfflineAgents();
    if (offlineAgents > 0) {
      console.log(`[Cleanup] Reset ${offlineAgents} offline agents`);
    }

    // Cancel stuck runs
    const stuckRuns = await cancelStuckRuns(config.stuckRunTimeoutMs);
    if (stuckRuns > 0) {
      console.log(`[Cleanup] Cancelled ${stuckRuns} stuck runs`);
    }

    const recoveredMergeQueueClaims = await recoverStaleMergeQueueClaims();
    if (recoveredMergeQueueClaims > 0) {
      console.log(`[Cleanup] Recovered ${recoveredMergeQueueClaims} stale merge queue claims`);
    }

    // Requeue failed tasks after cooldown (default: unlimited)
    const requeuedTasks = await requeueFailedTasksWithCooldown(config.failedTaskRetryCooldownMs);
    if (requeuedTasks > 0) {
      console.log(`[Cleanup] Requeued ${requeuedTasks} failed tasks`);
    }

    const requeuedBlockedTasks = await requeueBlockedTasksWithCooldown(
      config.blockedTaskRetryCooldownMs,
    );
    if (requeuedBlockedTasks > 0) {
      console.log(`[Cleanup] Requeued ${requeuedBlockedTasks} blocked tasks`);
    }
  } catch (error) {
    console.error("[CycleManager] Cleanup loop error:", error);
  }
}

// Stats update loop
export async function runStatsLoop(): Promise<void> {
  try {
    const state = getCycleState();

    if (!state.isRunning || !state.cycleId || !state.startedAt) {
      return;
    }

    // Update cycle stats
    const stats = await calculateCycleStats(state.startedAt);
    await updateCycleStats(state.cycleId, stats);

    // Capture and persist system state
    const systemState = await captureSystemState();
    await persistState(systemState);

    // Output cost summary
    const costSummary = await getCostSummary(state.startedAt);

    console.log(
      `[Stats] Cycle #${state.cycleNumber}: ` +
        `completed=${stats.tasksCompleted}, ` +
        `failed=${stats.tasksFailed}, ` +
        `tokens=${costSummary.totalTokens}`,
    );
  } catch (error) {
    console.error("[CycleManager] Stats loop error:", error);
  }
}
