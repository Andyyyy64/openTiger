import type { CycleConfig } from "@openTiger/core";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

// Cycle Manager設定
export interface CycleManagerConfig {
  cycleConfig: CycleConfig;
  monitorIntervalMs: number; // 監視間隔
  cleanupIntervalMs: number; // クリーンアップ間隔
  statsIntervalMs: number; // 統計更新間隔
  autoStartCycle: boolean; // 自動サイクル開始
  autoReplan: boolean; // タスク枯渇時に再計画
  replanIntervalMs: number; // 再計画の最小間隔
  replanRequirementPath?: string; // 要件ファイルのパス
  replanCommand: string; // Planner実行コマンド
  replanWorkdir: string; // Planner実行ディレクトリ
  replanRepoUrl?: string; // 差分判定に使うリポジトリURL
  replanBaseBranch: string; // 差分判定に使うベースブランチ
  systemApiBaseUrl: string; // system API エンドポイント
  issueSyncIntervalMs: number; // issue backlog 同期間隔
  issueSyncTimeoutMs: number; // issue backlog 同期タイムアウト
  failedTaskRetryCooldownMs: number; // failedタスク再投入までの待機時間
  blockedTaskRetryCooldownMs: number; // blockedタスク再投入までの待機時間
  stuckRunTimeoutMs: number; // 停滞run判定までの時間
}

function resolveRequirementPath(
  requirementPath: string | undefined,
  workdir: string,
): string | undefined {
  if (!requirementPath) {
    return undefined;
  }
  if (isAbsolute(requirementPath)) {
    return requirementPath;
  }

  // 起動ディレクトリ配下に無い場合は上位ディレクトリも順に探索する
  let currentDir = resolve(workdir);
  while (true) {
    const candidate = resolve(currentDir, requirementPath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  // 見つからない場合も決定的なパスを返し、後段で明示的にエラーを出す
  return resolve(workdir, requirementPath);
}

const defaultReplanWorkdir = process.env.REPLAN_WORKDIR ?? process.cwd();
const defaultReplanRequirementPath = resolveRequirementPath(
  process.env.REPLAN_REQUIREMENT_PATH ?? process.env.REQUIREMENT_PATH,
  defaultReplanWorkdir,
);

// デフォルト設定
export const DEFAULT_CONFIG: CycleManagerConfig = {
  cycleConfig: {
    maxDurationMs: parseInt(process.env.CYCLE_MAX_DURATION_MS ?? String(4 * 60 * 60 * 1000), 10), // 4時間
    maxTasksPerCycle: parseInt(process.env.CYCLE_MAX_TASKS ?? "100", 10),
    maxFailureRate: parseFloat(process.env.CYCLE_MAX_FAILURE_RATE ?? "0.3"),
    minTasksForFailureCheck: 10,
    cleanupOnEnd: true,
    preserveTaskState: true,
    statsIntervalMs: 60000,
    healthCheckIntervalMs: 30000,
  },
  monitorIntervalMs: parseInt(process.env.MONITOR_INTERVAL_MS ?? "30000", 10),
  cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS ?? "60000", 10),
  statsIntervalMs: parseInt(process.env.STATS_INTERVAL_MS ?? "60000", 10),
  autoStartCycle: process.env.AUTO_START_CYCLE !== "false",
  autoReplan: process.env.AUTO_REPLAN !== "false",
  replanIntervalMs: parseInt(process.env.REPLAN_INTERVAL_MS ?? "300000", 10),
  replanRequirementPath: defaultReplanRequirementPath,
  replanCommand: process.env.REPLAN_COMMAND ?? "pnpm --filter @openTiger/planner run start:fresh",
  replanWorkdir: defaultReplanWorkdir,
  replanRepoUrl: process.env.REPLAN_REPO_URL ?? process.env.REPO_URL,
  replanBaseBranch: process.env.REPLAN_BASE_BRANCH ?? process.env.BASE_BRANCH ?? "main",
  systemApiBaseUrl:
    process.env.SYSTEM_API_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT?.trim() || "4301"}`,
  issueSyncIntervalMs: parseInt(process.env.ISSUE_SYNC_INTERVAL_MS ?? "30000", 10),
  issueSyncTimeoutMs: parseInt(process.env.ISSUE_SYNC_TIMEOUT_MS ?? "15000", 10),
  failedTaskRetryCooldownMs: parseInt(process.env.FAILED_TASK_RETRY_COOLDOWN_MS ?? "30000", 10),
  blockedTaskRetryCooldownMs: parseInt(process.env.BLOCKED_TASK_RETRY_COOLDOWN_MS ?? "120000", 10),
  stuckRunTimeoutMs: parseInt(process.env.STUCK_RUN_TIMEOUT_MS ?? "900000", 10),
};

// 主要設定のログをまとめて出力する
export function logConfigSummary(config: CycleManagerConfig): void {
  console.log(`Monitor interval: ${config.monitorIntervalMs}ms`);
  console.log(`Cleanup interval: ${config.cleanupIntervalMs}ms`);
  console.log(`Failed task retry cooldown: ${config.failedTaskRetryCooldownMs}ms`);
  console.log(`Blocked task retry cooldown: ${config.blockedTaskRetryCooldownMs}ms`);
  console.log(`Stats interval: ${config.statsIntervalMs}ms`);
  console.log(`Max cycle duration: ${config.cycleConfig.maxDurationMs}ms`);
  console.log(`Max tasks per cycle: ${config.cycleConfig.maxTasksPerCycle}`);
  console.log(`Max failure rate: ${config.cycleConfig.maxFailureRate}`);
  console.log(`Auto replan: ${config.autoReplan}`);
  console.log(`System API base: ${config.systemApiBaseUrl}`);
  console.log(`Issue sync interval: ${config.issueSyncIntervalMs}ms`);
  console.log(`Issue sync timeout: ${config.issueSyncTimeoutMs}ms`);
  if (config.autoReplan) {
    console.log(`Replan interval: ${config.replanIntervalMs}ms`);
    console.log(`Replan requirement: ${config.replanRequirementPath ?? "not set"}`);
    console.log(`Replan repo: ${config.replanRepoUrl ?? "not set"} (${config.replanBaseBranch})`);
  }
}
