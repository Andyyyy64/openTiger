import { db } from "@h1ve/db";
import { runs, tasks } from "@h1ve/db/schema";
import { eq, and, gte, lte, sql, count, sum, avg } from "drizzle-orm";
import { recordEvent } from "./event-logger.js";

// コスト追跡設定
interface CostConfig {
  dailyTokenLimit: number; // 日次トークン上限
  hourlyTokenLimit: number; // 時間あたりトークン上限
  warningThreshold: number; // 警告閾値（0-1）
}

const defaultCostConfig: CostConfig = {
  dailyTokenLimit: parseInt(process.env.DAILY_TOKEN_LIMIT ?? "1000000", 10),
  hourlyTokenLimit: parseInt(process.env.HOURLY_TOKEN_LIMIT ?? "100000", 10),
  warningThreshold: 0.8, // 80%で警告
};

// コストサマリー
interface CostSummary {
  period: string;
  totalTokens: number;
  runsCount: number;
  averageTokensPerRun: number;
  successfulRuns: number;
  failedRuns: number;
  costPerSuccessfulTask: number;
}

// 期間別コスト集計
export async function getCostByPeriod(
  startTime: Date,
  endTime: Date
): Promise<CostSummary> {
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
  const costPerSuccessfulTask =
    successfulRuns > 0 ? totalTokens / successfulRuns : 0;

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

// 今日のコスト取得
export async function getTodayCost(): Promise<CostSummary> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return getCostByPeriod(today, tomorrow);
}

// 直近1時間のコスト取得
export async function getLastHourCost(): Promise<CostSummary> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  return getCostByPeriod(oneHourAgo, now);
}

// コスト制限チェック
export async function checkCostLimits(
  config: CostConfig = defaultCostConfig
): Promise<{
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

  // 日次制限チェック
  const dailyUsageRatio = todayCost.totalTokens / config.dailyTokenLimit;
  if (dailyUsageRatio >= 1) {
    warnings.push(
      `Daily token limit exceeded: ${todayCost.totalTokens}/${config.dailyTokenLimit}`
    );
  } else if (dailyUsageRatio >= config.warningThreshold) {
    warnings.push(
      `Daily token usage at ${(dailyUsageRatio * 100).toFixed(1)}%`
    );
  }

  // 時間制限チェック
  const hourlyUsageRatio = hourCost.totalTokens / config.hourlyTokenLimit;
  if (hourlyUsageRatio >= 1) {
    warnings.push(
      `Hourly token limit exceeded: ${hourCost.totalTokens}/${config.hourlyTokenLimit}`
    );
  } else if (hourlyUsageRatio >= config.warningThreshold) {
    warnings.push(
      `Hourly token usage at ${(hourlyUsageRatio * 100).toFixed(1)}%`
    );
  }

  const isWithinLimits = dailyUsageRatio < 1 && hourlyUsageRatio < 1;

  return {
    isWithinLimits,
    dailyUsage: todayCost.totalTokens,
    dailyLimit: config.dailyTokenLimit,
    hourlyUsage: hourCost.totalTokens,
    hourlyLimit: config.hourlyTokenLimit,
    warnings,
  };
}

// コスト効率の分析
export async function analyzeCostEfficiency(
  days: number = 7
): Promise<{
  tokensPerSuccessfulTask: number;
  successRate: number;
  trend: "improving" | "stable" | "degrading";
  recommendations: string[];
}> {
  const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const midTime = new Date(Date.now() - (days / 2) * 24 * 60 * 60 * 1000);
  const endTime = new Date();

  // 前半と後半で比較
  const firstHalf = await getCostByPeriod(startTime, midTime);
  const secondHalf = await getCostByPeriod(midTime, endTime);

  const totalTokens = firstHalf.totalTokens + secondHalf.totalTokens;
  const totalSuccessful = firstHalf.successfulRuns + secondHalf.successfulRuns;
  const totalRuns = firstHalf.runsCount + secondHalf.runsCount;

  const tokensPerSuccessfulTask =
    totalSuccessful > 0 ? totalTokens / totalSuccessful : 0;
  const successRate = totalRuns > 0 ? totalSuccessful / totalRuns : 0;

  // トレンド判定
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

// コストアラートを記録
export async function recordCostAlert(
  alertType: string,
  details: Record<string, unknown>
): Promise<void> {
  await recordEvent({
    type: `cost.${alertType}`,
    entityType: "system",
    entityId: "cost-tracker",
    payload: details,
  });

  console.warn(`[Cost] ${alertType}:`, details);
}
