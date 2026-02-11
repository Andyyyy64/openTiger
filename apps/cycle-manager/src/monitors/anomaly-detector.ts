import { db } from "@openTiger/db";
import { runs, agents } from "@openTiger/db/schema";
import { eq, and, gte, lt, count, sql } from "drizzle-orm";
import { SYSTEM_ENTITY_ID, type AnomalyAlert } from "@openTiger/core";
import { recordEvent } from "./event-logger";
import { getLastHourCost } from "./cost-tracker";

// Anomaly detection config
interface AnomalyConfig {
  // Failure rate thresholds
  failureRateWarning: number;
  failureRateCritical: number;
  // Cost spike threshold (vs previous hour)
  costSpikeRatio: number;
  // Stuck task threshold (min)
  stuckTaskMinutes: number;
  // No-progress threshold (min)
  noProgressMinutes: number;
  // Agent timeout (min)
  agentTimeoutMinutes: number;
}

const defaultAnomalyConfig: AnomalyConfig = {
  failureRateWarning: 0.2,
  failureRateCritical: 0.4,
  costSpikeRatio: 2.0, // Warn when 2x or more
  stuckTaskMinutes: 60,
  noProgressMinutes: 30,
  agentTimeoutMinutes: 10,
};

// List of detected anomalies
let detectedAnomalies: AnomalyAlert[] = [];
const anomalyLastReportedAt = new Map<string, number>();
const ANOMALY_REPEAT_COOLDOWN_MS = (() => {
  const raw = Number.parseInt(process.env.ANOMALY_REPEAT_COOLDOWN_MS ?? "300000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
})();
const MAX_ANOMALY_SIGNATURES = 200;

function buildAnomalySignature(alert: AnomalyAlert): string {
  const details = alert.details ? JSON.stringify(alert.details) : "";
  return `${alert.type}:${alert.severity}:${details.slice(0, 200)}`;
}

function rememberAnomalySignature(signature: string, nowMs: number): void {
  anomalyLastReportedAt.set(signature, nowMs);
  if (anomalyLastReportedAt.size <= MAX_ANOMALY_SIGNATURES) {
    return;
  }
  const oldest = anomalyLastReportedAt.keys().next().value;
  if (oldest) {
    anomalyLastReportedAt.delete(oldest);
  }
}

// Get anomaly list
export function getDetectedAnomalies(): AnomalyAlert[] {
  return [...detectedAnomalies];
}

// Clear anomaly list
export function clearAnomalies(): void {
  detectedAnomalies = [];
}

// Record anomaly
async function reportAnomaly(alert: AnomalyAlert): Promise<boolean> {
  const signature = buildAnomalySignature(alert);
  const nowMs = Date.now();
  const lastReportedAt = anomalyLastReportedAt.get(signature) ?? 0;
  if (nowMs - lastReportedAt < ANOMALY_REPEAT_COOLDOWN_MS) {
    return false;
  }
  rememberAnomalySignature(signature, nowMs);
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
  return true;
}

// Failure rate check
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
    // Too few samples
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
    const reported = await reportAnomaly(alert);
    return reported ? alert : null;
  }

  if (failureRate >= config.failureRateWarning) {
    const alert: AnomalyAlert = {
      type: "high_failure_rate",
      severity: "warning",
      message: `High failure rate: ${(failureRate * 100).toFixed(1)}% (${failedCount}/${totalCount})`,
      details: { failureRate, failedCount, totalCount },
      timestamp: new Date(),
    };
    const reported = await reportAnomaly(alert);
    return reported ? alert : null;
  }

  return null;
}

// Cost spike check
export async function checkCostSpike(
  config: AnomalyConfig = defaultAnomalyConfig,
): Promise<AnomalyAlert | null> {
  const lastHour = await getLastHourCost();

  // Compare with previous hour
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
    return null; // No baseline
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
    const reported = await reportAnomaly(alert);
    return reported ? alert : null;
  }

  return null;
}

// Stuck task check
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
    const reported = await reportAnomaly(alert);
    if (reported) {
      alerts.push(alert);
    }
  }

  return alerts;
}

// No-progress check
export async function checkNoProgress(
  config: AnomalyConfig = defaultAnomalyConfig,
): Promise<AnomalyAlert | null> {
  const threshold = new Date(Date.now() - config.noProgressMinutes * 60 * 1000);

  // Check recent completed runs
  const [recentCompleted] = await db
    .select({ count: count() })
    .from(runs)
    .where(and(gte(runs.finishedAt, threshold), eq(runs.status, "success")));

  // Check active worker count
  const [activeWorkers] = await db
    .select({ count: count() })
    .from(agents)
    .where(eq(agents.status, "busy"));

  // Workers active but no progress
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
    const reported = await reportAnomaly(alert);
    return reported ? alert : null;
  }

  return null;
}

// Agent timeout check
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
    const reported = await reportAnomaly(alert);
    if (reported) {
      alerts.push(alert);
    }
  }

  return alerts;
}

// Run all anomaly checks
export async function runAllAnomalyChecks(
  config: AnomalyConfig = defaultAnomalyConfig,
): Promise<AnomalyAlert[]> {
  const alerts: AnomalyAlert[] = [];

  // Failure rate check
  const failureAlert = await checkFailureRate(config);
  if (failureAlert) alerts.push(failureAlert);

  // Cost spike check
  const costAlert = await checkCostSpike(config);
  if (costAlert) alerts.push(costAlert);

  // Stuck task check
  const stuckAlerts = await checkStuckTasks(config);
  alerts.push(...stuckAlerts);

  // No-progress check
  const progressAlert = await checkNoProgress(config);
  if (progressAlert) alerts.push(progressAlert);

  // Agent timeout check
  const agentAlerts = await checkAgentTimeouts(config);
  alerts.push(...agentAlerts);

  return alerts;
}
