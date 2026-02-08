import { db } from "@openTiger/db";
import { runs, tasks, agents, leases } from "@openTiger/db/schema";
import { eq, and, gte, lt, count, sql } from "drizzle-orm";
import { SYSTEM_ENTITY_ID, type AnomalyAlert } from "@openTiger/core";
import { recordEvent } from "./event-logger";
import { getLastHourCost, getTodayCost } from "./cost-tracker";

// 異常検知設定
interface AnomalyConfig {
  // 失敗率閾値
  failureRateWarning: number;
  failureRateCritical: number;
  // コスト急増閾値（前時間比）
  costSpikeRatio: number;
  // タスク停滞時間（分）
  stuckTaskMinutes: number;
  // 進捗なし判定時間（分）
  noProgressMinutes: number;
  // エージェントタイムアウト（分）
  agentTimeoutMinutes: number;
}

const defaultAnomalyConfig: AnomalyConfig = {
  failureRateWarning: 0.2,
  failureRateCritical: 0.4,
  costSpikeRatio: 2.0, // 2倍以上で警告
  stuckTaskMinutes: 60,
  noProgressMinutes: 30,
  agentTimeoutMinutes: 10,
};

// 検知された異常のリスト
let detectedAnomalies: AnomalyAlert[] = [];

// 異常リストを取得
export function getDetectedAnomalies(): AnomalyAlert[] {
  return [...detectedAnomalies];
}

// 異常リストをクリア
export function clearAnomalies(): void {
  detectedAnomalies = [];
}

// 異常を記録
async function reportAnomaly(alert: AnomalyAlert): Promise<void> {
  detectedAnomalies.push(alert);

  await recordEvent({
    type: `anomaly.${alert.type}`,
    entityType: "system",
    entityId: SYSTEM_ENTITY_ID,
    payload: {
      severity: alert.severity,
      message: alert.message,
      details: alert.details,
    },
  });

  const prefix = alert.severity === "critical" ? "[CRITICAL]" : "[WARNING]";
  console.warn(`${prefix} ${alert.message}`);
}

// 失敗率チェック
export async function checkFailureRate(
  config: AnomalyConfig = defaultAnomalyConfig,
): Promise<AnomalyAlert | null> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const result = await db
    .select({
      status: runs.status,
      count: count(),
    })
    .from(runs)
    .where(gte(runs.startedAt, oneHourAgo))
    .groupBy(runs.status);

  let successCount = 0;
  let failedCount = 0;

  for (const row of result) {
    if (row.status === "success") {
      successCount = row.count;
    } else if (row.status === "failed") {
      failedCount = row.count;
    }
  }

  const totalCount = successCount + failedCount;
  if (totalCount < 5) {
    // サンプルが少なすぎる
    return null;
  }

  const failureRate = failedCount / totalCount;

  if (failureRate >= config.failureRateCritical) {
    const alert: AnomalyAlert = {
      type: "high_failure_rate",
      severity: "critical",
      message: `Critical failure rate: ${(failureRate * 100).toFixed(1)}% (${failedCount}/${totalCount})`,
      details: { failureRate, failedCount, totalCount },
      timestamp: new Date(),
    };
    await reportAnomaly(alert);
    return alert;
  }

  if (failureRate >= config.failureRateWarning) {
    const alert: AnomalyAlert = {
      type: "high_failure_rate",
      severity: "warning",
      message: `High failure rate: ${(failureRate * 100).toFixed(1)}% (${failedCount}/${totalCount})`,
      details: { failureRate, failedCount, totalCount },
      timestamp: new Date(),
    };
    await reportAnomaly(alert);
    return alert;
  }

  return null;
}

// コスト急増チェック
export async function checkCostSpike(
  config: AnomalyConfig = defaultAnomalyConfig,
): Promise<AnomalyAlert | null> {
  const lastHour = await getLastHourCost();

  // 前の1時間と比較
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const previousResult = await db
    .select({
      tokens: sql<number>`COALESCE(SUM(${runs.costTokens}), 0)`,
    })
    .from(runs)
    .where(and(gte(runs.startedAt, twoHoursAgo), lt(runs.startedAt, oneHourAgo)));

  const previousTokens = Number(previousResult[0]?.tokens) || 0;

  if (previousTokens === 0) {
    return null; // 比較対象がない
  }

  const ratio = lastHour.totalTokens / previousTokens;

  if (ratio >= config.costSpikeRatio) {
    const alert: AnomalyAlert = {
      type: "cost_spike",
      severity: ratio >= config.costSpikeRatio * 1.5 ? "critical" : "warning",
      message: `Cost spike detected: ${ratio.toFixed(1)}x increase (${previousTokens} -> ${lastHour.totalTokens} tokens)`,
      details: {
        currentTokens: lastHour.totalTokens,
        previousTokens,
        ratio,
      },
      timestamp: new Date(),
    };
    await reportAnomaly(alert);
    return alert;
  }

  return null;
}

// 停滞タスクチェック
export async function checkStuckTasks(
  config: AnomalyConfig = defaultAnomalyConfig,
): Promise<AnomalyAlert[]> {
  const threshold = new Date(Date.now() - config.stuckTaskMinutes * 60 * 1000);

  const stuckRuns = await db
    .select({
      id: runs.id,
      taskId: runs.taskId,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .where(and(eq(runs.status, "running"), lt(runs.startedAt, threshold)));

  const alerts: AnomalyAlert[] = [];

  for (const run of stuckRuns) {
    const durationMinutes = Math.round((Date.now() - run.startedAt.getTime()) / 60000);

    const alert: AnomalyAlert = {
      type: "stuck_task",
      severity: durationMinutes > config.stuckTaskMinutes * 2 ? "critical" : "warning",
      message: `Task stuck for ${durationMinutes} minutes (run: ${run.id.substring(0, 8)})`,
      details: {
        runId: run.id,
        taskId: run.taskId,
        durationMinutes,
      },
      timestamp: new Date(),
    };
    await reportAnomaly(alert);
    alerts.push(alert);
  }

  return alerts;
}

// 進捗なしチェック
export async function checkNoProgress(
  config: AnomalyConfig = defaultAnomalyConfig,
): Promise<AnomalyAlert | null> {
  const threshold = new Date(Date.now() - config.noProgressMinutes * 60 * 1000);

  // 直近の完了Runを確認
  const [recentCompleted] = await db
    .select({ count: count() })
    .from(runs)
    .where(and(gte(runs.finishedAt, threshold), eq(runs.status, "success")));

  // アクティブなワーカー数を確認
  const [activeWorkers] = await db
    .select({ count: count() })
    .from(agents)
    .where(eq(agents.status, "busy"));

  // ワーカーがいるのに進捗がない場合
  if ((activeWorkers?.count ?? 0) > 0 && (recentCompleted?.count ?? 0) === 0) {
    const alert: AnomalyAlert = {
      type: "no_progress",
      severity: "warning",
      message: `No completed tasks in last ${config.noProgressMinutes} minutes with ${activeWorkers?.count} active workers`,
      details: {
        activeWorkers: activeWorkers?.count ?? 0,
        noProgressMinutes: config.noProgressMinutes,
      },
      timestamp: new Date(),
    };
    await reportAnomaly(alert);
    return alert;
  }

  return null;
}

// エージェントタイムアウトチェック
export async function checkAgentTimeouts(
  config: AnomalyConfig = defaultAnomalyConfig,
): Promise<AnomalyAlert[]> {
  const threshold = new Date(Date.now() - config.agentTimeoutMinutes * 60 * 1000);

  const timedOutAgents = await db
    .select({
      id: agents.id,
      lastHeartbeat: agents.lastHeartbeat,
    })
    .from(agents)
    .where(and(eq(agents.status, "busy"), lt(agents.lastHeartbeat, threshold)));

  const alerts: AnomalyAlert[] = [];

  for (const agent of timedOutAgents) {
    const lastHeartbeat = agent.lastHeartbeat;
    const minutesSinceHeartbeat = lastHeartbeat
      ? Math.round((Date.now() - lastHeartbeat.getTime()) / 60000)
      : 0;

    const alert: AnomalyAlert = {
      type: "agent_timeout",
      severity: "warning",
      message: `Agent ${agent.id} timeout: no heartbeat for ${minutesSinceHeartbeat} minutes`,
      details: {
        agentId: agent.id,
        lastHeartbeat: lastHeartbeat?.toISOString(),
        minutesSinceHeartbeat,
      },
      timestamp: new Date(),
    };
    await reportAnomaly(alert);
    alerts.push(alert);
  }

  return alerts;
}

// 全異常検知を実行
export async function runAllAnomalyChecks(
  config: AnomalyConfig = defaultAnomalyConfig,
): Promise<AnomalyAlert[]> {
  const alerts: AnomalyAlert[] = [];

  // 失敗率チェック
  const failureAlert = await checkFailureRate(config);
  if (failureAlert) alerts.push(failureAlert);

  // コスト急増チェック
  const costAlert = await checkCostSpike(config);
  if (costAlert) alerts.push(costAlert);

  // 停滞タスクチェック
  const stuckAlerts = await checkStuckTasks(config);
  alerts.push(...stuckAlerts);

  // 進捗なしチェック
  const progressAlert = await checkNoProgress(config);
  if (progressAlert) alerts.push(progressAlert);

  // エージェントタイムアウトチェック
  const agentAlerts = await checkAgentTimeouts(config);
  alerts.push(...agentAlerts);

  return alerts;
}
