import { db } from "@openTiger/db";
import { runs } from "@openTiger/db/schema";
import { and, gte, lte, count, sum } from "drizzle-orm";
import { SYSTEM_ENTITY_ID } from "@openTiger/core";
import { recordEvent } from "./event-logger";

// Cost tracking config
interface CostConfig {
  dailyTokenLimit: number; // daily token limit
  hourlyTokenLimit: number; // hourly token limit
  warningThreshold: number; // warning threshold (0-1)
}

const defaultCostConfig: CostConfig = {
  dailyTokenLimit: parseInt(process.env.DAILY_TOKEN_LIMIT ?? "-1", 10),
  hourlyTokenLimit: parseInt(process.env.HOURLY_TOKEN_LIMIT ?? "-1", 10),
  warningThreshold: 0.8, // warn at 80%
};

// Cost summary
interface CostSummary {
  period: string;
  totalTokens: number;
  runsCount: number;
  averageTokensPerRun: number;
  successfulRuns: number;
  failedRuns: number;
  costPerSuccessfulTask: number;
}

// Cost aggregation by period
export async function getCostByPeriod(startTime: Date, endTime: Date): Promise<CostSummary> {
  const result = await db
    .select({
      status: runs.status,
      count: count(),
      tokens: sum(runs.costTokens),
    })
    .from(runs)
    .where(and(gte(runs.startedAt, startTime), lte(runs.startedAt, endTime)))
    .groupBy(runs.status);

  let totalTokens = 0;
  let runsCount = 0;
  let successfulRuns = 0;
  let failedRuns = 0;

  for (const row of result) {
    const tokens = Number(row.tokens) || 0;
    totalTokens += tokens;
    runsCount += row.count;
    if (row.status === "success") {
      successfulRuns = row.count;
    } else if (row.status === "failed") {
      failedRuns = row.count;
    }
  }

  const averageTokensPerRun = runsCount > 0 ? totalTokens / runsCount : 0;
  const costPerSuccessfulTask = successfulRuns > 0 ? totalTokens / successfulRuns : 0;

  return {
    period: `${startTime.toISOString()} - ${endTime.toISOString()}`,
    totalTokens,
    runsCount,
    averageTokensPerRun,
    successfulRuns,
    failedRuns,
    costPerSuccessfulTask,
  };
}

// Get today's cost
export async function getTodayCost(): Promise<CostSummary> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return getCostByPeriod(today, tomorrow);
}

// Get last hour cost
export async function getLastHourCost(): Promise<CostSummary> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  return getCostByPeriod(oneHourAgo, now);
}

// Check cost limits
export async function checkCostLimits(config: CostConfig = defaultCostConfig): Promise<{
  isWithinLimits: boolean;
  dailyUsage: number;
  dailyLimit: number;
  hourlyUsage: number;
  hourlyLimit: number;
  warnings: string[];
}> {
  const todayCost = await getTodayCost();
  const hourCost = await getLastHourCost();

  const warnings: string[] = [];

  const dailyLimit = config.dailyTokenLimit;
  const hourlyLimit = config.hourlyTokenLimit;

  // Treat limit <= 0 as unlimited
  const dailyUsageRatio = dailyLimit > 0 ? todayCost.totalTokens / dailyLimit : 0;
  if (dailyLimit > 0) {
    if (dailyUsageRatio >= 1) {
      warnings.push(`Daily token limit exceeded: ${todayCost.totalTokens}/${dailyLimit}`);
    } else if (dailyUsageRatio >= config.warningThreshold) {
      warnings.push(`Daily token usage at ${(dailyUsageRatio * 100).toFixed(1)}%`);
    }
  }

  const hourlyUsageRatio = hourlyLimit > 0 ? hourCost.totalTokens / hourlyLimit : 0;
  if (hourlyLimit > 0) {
    if (hourlyUsageRatio >= 1) {
      warnings.push(`Hourly token limit exceeded: ${hourCost.totalTokens}/${hourlyLimit}`);
    } else if (hourlyUsageRatio >= config.warningThreshold) {
      warnings.push(`Hourly token usage at ${(hourlyUsageRatio * 100).toFixed(1)}%`);
    }
  }

  const isWithinLimits =
    (dailyLimit <= 0 || dailyUsageRatio < 1) && (hourlyLimit <= 0 || hourlyUsageRatio < 1);

  return {
    isWithinLimits,
    dailyUsage: todayCost.totalTokens,
    dailyLimit,
    hourlyUsage: hourCost.totalTokens,
    hourlyLimit,
    warnings,
  };
}

// Analyze cost efficiency
export async function analyzeCostEfficiency(days: number = 7): Promise<{
  tokensPerSuccessfulTask: number;
  successRate: number;
  trend: "improving" | "stable" | "degrading";
  recommendations: string[];
}> {
  const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const midTime = new Date(Date.now() - (days / 2) * 24 * 60 * 60 * 1000);
  const endTime = new Date();

  // Compare first and second half
  const firstHalf = await getCostByPeriod(startTime, midTime);
  const secondHalf = await getCostByPeriod(midTime, endTime);

  const totalTokens = firstHalf.totalTokens + secondHalf.totalTokens;
  const totalSuccessful = firstHalf.successfulRuns + secondHalf.successfulRuns;
  const totalRuns = firstHalf.runsCount + secondHalf.runsCount;

  const tokensPerSuccessfulTask = totalSuccessful > 0 ? totalTokens / totalSuccessful : 0;
  const successRate = totalRuns > 0 ? totalSuccessful / totalRuns : 0;

  // Determine trend
  let trend: "improving" | "stable" | "degrading" = "stable";
  const recommendations: string[] = [];

  if (firstHalf.costPerSuccessfulTask > 0 && secondHalf.costPerSuccessfulTask > 0) {
    const costChange =
      (secondHalf.costPerSuccessfulTask - firstHalf.costPerSuccessfulTask) /
      firstHalf.costPerSuccessfulTask;

    if (costChange < -0.1) {
      trend = "improving";
    } else if (costChange > 0.1) {
      trend = "degrading";
      recommendations.push("Cost per task is increasing. Consider reviewing task complexity.");
    }
  }

  if (successRate < 0.7) {
    recommendations.push("Success rate is below 70%. Review failing task patterns.");
  }

  if (tokensPerSuccessfulTask > 50000) {
    recommendations.push("High token usage per task. Consider task decomposition.");
  }

  return {
    tokensPerSuccessfulTask,
    successRate,
    trend,
    recommendations,
  };
}

// Record cost alert
export async function recordCostAlert(
  alertType: string,
  details: Record<string, unknown>,
): Promise<void> {
  await recordEvent({
    type: `cost.${alertType}`,
    entityType: "system",
    entityId: SYSTEM_ENTITY_ID,
    payload: details,
  });

  console.warn(`[Cost] ${alertType}:`, details);
}
