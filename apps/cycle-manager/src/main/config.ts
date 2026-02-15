import type { CycleConfig } from "@openTiger/core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

// Cycle Manager config
export interface CycleManagerConfig {
  cycleConfig: CycleConfig;
  monitorIntervalMs: number; // Monitor interval
  cleanupIntervalMs: number; // Cleanup interval
  statsIntervalMs: number; // Stats update interval
  autoStartCycle: boolean; // Auto-start cycle
  autoReplan: boolean; // Replan when task backlog depleted
  replanIntervalMs: number; // Min replan interval
  replanRequirementPath?: string; // Requirement file path
  replanCommand: string; // Planner command
  replanWorkdir: string; // Planner workdir
  replanRepoUrl?: string; // Repo URL for diff check
  replanBaseBranch: string; // Base branch for diff check
  systemApiBaseUrl: string; // System API endpoint
  issueSyncIntervalMs: number; // Issue backlog sync interval
  issueSyncTimeoutMs: number; // Issue backlog sync timeout
  failedTaskRetryCooldownMs: number; // Cooldown before requeue failed
  blockedTaskRetryCooldownMs: number; // Cooldown before requeue blocked
  stuckRunTimeoutMs: number; // Stuck run threshold
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseRepoOwnerAndName(repoUrl: string): { owner?: string; repo?: string } {
  const trimmed = repoUrl.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith("git@")) {
    const sshMatch = /^git@[^:]+:(.+)$/u.exec(trimmed);
    if (!sshMatch?.[1]) {
      return {};
    }
    const [owner, repo] = sshMatch[1].replace(/\.git$/u, "").split("/");
    return {
      owner: owner?.trim(),
      repo: repo?.trim(),
    };
  }
  try {
    const parsed = new URL(trimmed);
    const [owner, repo] = parsed.pathname
      .replace(/^\/+/u, "")
      .replace(/\.git$/u, "")
      .split("/");
    return {
      owner: owner?.trim(),
      repo: repo?.trim(),
    };
  } catch {
    return {};
  }
}

function resolveManagedRequirementPath(
  requirementPath: string,
  repoUrl: string,
): string | undefined {
  if (isAbsolute(requirementPath)) {
    return undefined;
  }
  const parsed = parseRepoOwnerAndName(repoUrl);
  if (!parsed.owner || !parsed.repo) {
    return undefined;
  }
  const cacheRoot = resolve(
    process.env.OPENTIGER_REQUIREMENT_REPO_ROOT?.trim() || `${homedir()}/.opentiger/repos`,
  );
  const repoRoot = resolve(
    cacheRoot,
    sanitizePathSegment(parsed.owner),
    sanitizePathSegment(parsed.repo),
  );
  const candidate = resolve(repoRoot, requirementPath);
  if (existsSync(candidate)) {
    return candidate;
  }
  return undefined;
}

function resolveRequirementPath(
  requirementPath: string | undefined,
  workdir: string,
  repoUrl: string | undefined,
): string | undefined {
  if (!requirementPath) {
    return undefined;
  }
  if (isAbsolute(requirementPath)) {
    return requirementPath;
  }

  // Search parent dirs if not under launch dir
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

  if (repoUrl) {
    const managedCandidate = resolveManagedRequirementPath(requirementPath, repoUrl);
    if (managedCandidate) {
      return managedCandidate;
    }
  }

  // Return deterministic path; error explicitly later if not found
  return resolve(workdir, requirementPath);
}

const defaultReplanWorkdir = process.env.REPLAN_WORKDIR ?? process.cwd();
const defaultReplanRepoUrl = process.env.REPLAN_REPO_URL ?? process.env.REPO_URL;
const defaultReplanRequirementPath = resolveRequirementPath(
  process.env.REPLAN_REQUIREMENT_PATH ?? process.env.REQUIREMENT_PATH,
  defaultReplanWorkdir,
  defaultReplanRepoUrl,
);

// Default config
export const DEFAULT_CONFIG: CycleManagerConfig = {
  cycleConfig: {
    maxDurationMs: parseInt(process.env.CYCLE_MAX_DURATION_MS ?? String(4 * 60 * 60 * 1000), 10), // 4h
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

// Log main config summary
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
