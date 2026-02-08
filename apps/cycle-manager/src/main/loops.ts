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

const CYCLE_ENDING_CRITICAL_ANOMALIES = new Set(["stuck_task", "cost_spike"]);

// 監視ループ
export async function runMonitorLoop(config: CycleManagerConfig): Promise<void> {
  try {
    const state = getCycleState();

    if (!state.isRunning) {
      return;
    }

    // サイクル終了判定
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

      // サイクル終了処理
      await endCurrentCycle(triggerType);

      // クリーンアップ
      if (state.config.cleanupOnEnd) {
        await performFullCleanup(state.config.preserveTaskState);
      }

      // 新しいサイクルを開始
      await startNewCycle();

      console.log("[CycleManager] New cycle started after cleanup");
    }

    // 異常検知
    const anomalies = await runAllAnomalyChecks();
    if (anomalies.length > 0) {
      console.log(`[CycleManager] Detected ${anomalies.length} anomalies`);

      // クリティカルな異常があればサイクル終了
      const criticalAnomalies = anomalies.filter((a) => a.severity === "critical");
      const endingCriticalAnomalies = criticalAnomalies.filter((anomaly) =>
        CYCLE_ENDING_CRITICAL_ANOMALIES.has(anomaly.type),
      );
      if (endingCriticalAnomalies.length > 0) {
        console.log("[CycleManager] Critical anomalies detected, ending cycle");
        await endCurrentCycle("critical_anomaly");
        await performFullCleanup(true);
        await startNewCycle();
      } else if (criticalAnomalies.length > 0) {
        console.warn(
          "[CycleManager] Critical anomaly detected, but cycle restart skipped (non-recoverable by restart)",
        );
      }
    }

    // コスト制限チェック
    const costStatus = await checkCostLimits();
    if (!costStatus.isWithinLimits) {
      console.warn("[CycleManager] Cost limits exceeded:", costStatus.warnings);
      // コスト超過時は新しいタスクの実行を一時停止（別途Dispatcherに通知）
      await recordEvent({
        type: "cost.limit_exceeded",
        entityType: "system",
        entityId: SYSTEM_ENTITY_ID,
        payload: costStatus,
      });
    }

    // タスク枯渇時はPlannerを再実行する
    // replanInProgress を先にチェックして競合状態を防ぐ
    if (isReplanInProgress()) {
      // Planner 実行中は何もしない
    } else {
      const systemState = await captureSystemState();
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

// クリーンアップループ
export async function runCleanupLoop(config: CycleManagerConfig): Promise<void> {
  try {
    // 期限切れリースをクリーンアップ
    const expiredLeases = await cleanupExpiredLeases();
    if (expiredLeases > 0) {
      console.log(`[Cleanup] Released ${expiredLeases} expired leases`);
    }

    // オフラインエージェントをリセット
    const offlineAgents = await resetOfflineAgents();
    if (offlineAgents > 0) {
      console.log(`[Cleanup] Reset ${offlineAgents} offline agents`);
    }

    // 停滞Runをキャンセル
    const stuckRuns = await cancelStuckRuns(config.stuckRunTimeoutMs);
    if (stuckRuns > 0) {
      console.log(`[Cleanup] Cancelled ${stuckRuns} stuck runs`);
    }

    // 失敗タスクをクールダウン後に再キュー（既定: 無制限）
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

// 統計更新ループ
export async function runStatsLoop(): Promise<void> {
  try {
    const state = getCycleState();

    if (!state.isRunning || !state.cycleId || !state.startedAt) {
      return;
    }

    // サイクル統計を更新
    const stats = await calculateCycleStats(state.startedAt);
    await updateCycleStats(state.cycleId, stats);

    // システム状態をキャプチャして永続化
    const systemState = await captureSystemState();
    await persistState(systemState);

    // コストサマリーを出力
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
