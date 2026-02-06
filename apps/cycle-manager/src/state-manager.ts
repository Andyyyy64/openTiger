import { db } from "@sebastian-code/db";
import { cycles, tasks, runs, agents } from "@sebastian-code/db/schema";
import { eq, count, sql, and, gte, lte, inArray, lt } from "drizzle-orm";
import type { CycleStats, StateSnapshot } from "@sebastian-code/core";

// システム状態のスナップショット
export interface SystemState {
  timestamp: Date;
  tasks: {
    queued: number;
    running: number;
    done: number;
    failed: number;
    blocked: number;
  };
  runs: {
    running: number;
    success: number;
    failed: number;
    cancelled: number;
  };
  agents: {
    idle: number;
    busy: number;
    offline: number;
  };
  cycle: {
    id: string | null;
    number: number;
    startedAt: Date | null;
  } | null;
}

// 現在のシステム状態を取得
export async function captureSystemState(): Promise<SystemState> {
  // タスク状態の集計
  const taskStats = await db
    .select({
      status: tasks.status,
      count: count(),
    })
    .from(tasks)
    .groupBy(tasks.status);

  const taskCounts = {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
  };
  for (const stat of taskStats) {
    const status = stat.status as keyof typeof taskCounts;
    if (status in taskCounts) {
      taskCounts[status] = stat.count;
    }
  }

  // Run状態の集計
  const runStats = await db
    .select({
      status: runs.status,
      count: count(),
    })
    .from(runs)
    .groupBy(runs.status);

  const runCounts = {
    running: 0,
    success: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const stat of runStats) {
    const status = stat.status as keyof typeof runCounts;
    if (status in runCounts) {
      runCounts[status] = stat.count;
    }
  }

  // エージェント状態の集計
  const agentStats = await db
    .select({
      status: agents.status,
      count: count(),
    })
    .from(agents)
    .groupBy(agents.status);

  const agentCounts = {
    idle: 0,
    busy: 0,
    offline: 0,
  };
  for (const stat of agentStats) {
    const status = stat.status as keyof typeof agentCounts;
    if (status in agentCounts) {
      agentCounts[status] = stat.count;
    }
  }

  // 現在のサイクル情報
  const [currentCycle] = await db
    .select()
    .from(cycles)
    .where(eq(cycles.status, "running"))
    .orderBy(sql`${cycles.startedAt} DESC`)
    .limit(1);

  return {
    timestamp: new Date(),
    tasks: taskCounts,
    runs: runCounts,
    agents: agentCounts,
    cycle: currentCycle
      ? {
          id: currentCycle.id,
          number: currentCycle.number,
          startedAt: currentCycle.startedAt,
        }
      : null,
  };
}

// 状態をファイルに永続化
export async function persistState(state: SystemState): Promise<void> {
  // 現在のサイクルに状態スナップショットを保存
  if (!state.cycle?.id) {
    return;
  }

  const snapshot: StateSnapshot = {
    pendingTaskCount: state.tasks.queued,
    runningTaskCount: state.tasks.running,
    activeAgentCount: state.agents.busy,
    queuedJobCount: 0, // BullMQから取得する場合は別途実装
    timestamp: state.timestamp,
  };

  await db
    .update(cycles)
    .set({
      stateSnapshot: snapshot,
    })
    .where(eq(cycles.id, state.cycle.id));
}

// サイクル統計を更新
export async function updateCycleStats(
  cycleId: string,
  stats: CycleStats
): Promise<void> {
  await db.update(cycles).set({ stats }).where(eq(cycles.id, cycleId));
}

// サイクル履歴を取得
export async function getCycleHistory(
  limit: number = 10
): Promise<Array<typeof cycles.$inferSelect>> {
  return db
    .select()
    .from(cycles)
    .orderBy(sql`${cycles.startedAt} DESC`)
    .limit(limit);
}

// 指定期間のシステムメトリクス
export async function getSystemMetrics(
  startTime: Date,
  endTime: Date
): Promise<{
  tasksCompleted: number;
  tasksFailed: number;
  avgTaskDurationMs: number;
  totalTokens: number;
}> {
  const runMetrics = await db
    .select({
      status: runs.status,
      count: count(),
      avgDuration: sql<number>`AVG(EXTRACT(EPOCH FROM (${runs.finishedAt} - ${runs.startedAt})) * 1000)`,
      totalTokens: sql<number>`COALESCE(SUM(${runs.costTokens}), 0)`,
    })
    .from(runs)
    .where(
      and(
        gte(runs.startedAt, startTime),
        lte(runs.startedAt, endTime)
      )
    )
    .groupBy(runs.status);

  let tasksCompleted = 0;
  let tasksFailed = 0;
  let avgTaskDurationMs = 0;
  let totalTokens = 0;

  for (const row of runMetrics) {
    totalTokens += Number(row.totalTokens) || 0;
    if (row.status === "success") {
      tasksCompleted = row.count;
      avgTaskDurationMs = Number(row.avgDuration) || 0;
    } else if (row.status === "failed") {
      tasksFailed = row.count;
    }
  }

  return {
    tasksCompleted,
    tasksFailed,
    avgTaskDurationMs,
    totalTokens,
  };
}

// ヘルスチェック結果
export interface HealthCheckResult {
  healthy: boolean;
  checks: {
    database: boolean;
    activeAgents: boolean;
    noStuckTasks: boolean;
    queueLatencyWithinSlo: boolean;
    blockedWithinSlo: boolean;
    retryExhaustionWithinLimit: boolean;
    withinCostLimits: boolean;
  };
  details: Record<string, unknown>;
}

// システムヘルスチェック
export async function performHealthCheck(): Promise<HealthCheckResult> {
  const details: Record<string, unknown> = {};

  // DB接続チェック
  let dbHealthy = false;
  try {
    await db.select({ one: sql`1` }).from(tasks).limit(1);
    dbHealthy = true;
  } catch (error) {
    details.dbError = error instanceof Error ? error.message : "Unknown error";
  }

  // アクティブエージェントチェック
  const agentThreshold = new Date(Date.now() - 2 * 60 * 1000);
  const [agentCount] = await db
    .select({ count: count() })
    .from(agents)
    .where(
      and(
        inArray(agents.status, ["idle", "busy"]),
        gte(agents.lastHeartbeat, agentThreshold)
      )
    );
  const activeAgentCount = agentCount?.count ?? 0;
  const hasActiveAgents = activeAgentCount > 0;
  details.activeAgentCount = activeAgentCount;

  // 停滞タスクチェック
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [stuckCount] = await db
    .select({ count: count() })
    .from(runs)
    .where(
      and(
        eq(runs.status, "running"),
        sql`${runs.startedAt} < ${oneHourAgo}`
      )
    );
  const noStuckTasks = (stuckCount?.count ?? 0) === 0;
  details.stuckTaskCount = stuckCount?.count ?? 0;

  // SLO: queued -> running 5分以内
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const [queuedSloViolation] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "queued"),
        lt(tasks.updatedAt, fiveMinutesAgo)
      )
    );
  const queuedSloViolationCount = queuedSloViolation?.count ?? 0;
  const queueLatencyWithinSlo = queuedSloViolationCount === 0;
  details.queuedOver5mCount = queuedSloViolationCount;

  // SLO: blocked 30分以内に自動処理
  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  const [blockedSloViolation] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "blocked"),
        lt(tasks.updatedAt, thirtyMinutesAgo)
      )
    );
  const blockedSloViolationCount = blockedSloViolation?.count ?? 0;
  const blockedWithinSlo = blockedSloViolationCount === 0;
  details.blockedOver30mCount = blockedSloViolationCount;

  const retryLimit = Number.parseInt(process.env.FAILED_TASK_MAX_RETRY_COUNT ?? "3", 10);
  const [retryExhausted] = await db
    .select({ count: count() })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ["failed", "blocked"]),
        gte(tasks.retryCount, Number.isFinite(retryLimit) ? retryLimit : 3)
      )
    );
  const retryExhaustedCount = retryExhausted?.count ?? 0;
  const retryExhaustionWithinLimit = retryExhaustedCount === 0;
  details.retryExhaustedCount = retryExhaustedCount;

  const healthy =
    dbHealthy &&
    hasActiveAgents &&
    noStuckTasks &&
    queueLatencyWithinSlo &&
    blockedWithinSlo;

  return {
    healthy,
    checks: {
      database: dbHealthy,
      activeAgents: hasActiveAgents,
      noStuckTasks,
      queueLatencyWithinSlo,
      blockedWithinSlo,
      retryExhaustionWithinLimit,
      withinCostLimits: true, // 別途実装
    },
    details,
  };
}
