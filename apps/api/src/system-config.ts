import { config as configTable } from "@openTiger/db/schema";

type ConfigColumn = keyof Omit<
  typeof configTable.$inferSelect,
  "id" | "createdAt" | "updatedAt"
>;

export type ConfigField = {
  key: string;
  column: ConfigColumn;
  defaultValue: string;
};

export const CONFIG_FIELDS: ConfigField[] = [
  { key: "MAX_CONCURRENT_WORKERS", column: "maxConcurrentWorkers", defaultValue: "10" },
  { key: "DAILY_TOKEN_LIMIT", column: "dailyTokenLimit", defaultValue: "50000000" },
  { key: "HOURLY_TOKEN_LIMIT", column: "hourlyTokenLimit", defaultValue: "5000000" },
  { key: "TASK_TOKEN_LIMIT", column: "taskTokenLimit", defaultValue: "1000000" },
  { key: "DISPATCHER_ENABLED", column: "dispatcherEnabled", defaultValue: "true" },
  { key: "JUDGE_ENABLED", column: "judgeEnabled", defaultValue: "true" },
  { key: "CYCLE_MANAGER_ENABLED", column: "cycleManagerEnabled", defaultValue: "true" },
  { key: "WORKER_COUNT", column: "workerCount", defaultValue: "1" },
  { key: "TESTER_COUNT", column: "testerCount", defaultValue: "1" },
  { key: "DOCSER_COUNT", column: "docserCount", defaultValue: "1" },
  { key: "JUDGE_COUNT", column: "judgeCount", defaultValue: "1" },
  { key: "PLANNER_COUNT", column: "plannerCount", defaultValue: "1" },
  { key: "REPO_MODE", column: "repoMode", defaultValue: "git" },
  { key: "REPO_URL", column: "repoUrl", defaultValue: "" },
  { key: "LOCAL_REPO_PATH", column: "localRepoPath", defaultValue: "" },
  { key: "LOCAL_WORKTREE_ROOT", column: "localWorktreeRoot", defaultValue: "" },
  { key: "JUDGE_MODE", column: "judgeMode", defaultValue: "auto" },
  { key: "LOCAL_POLICY_MAX_LINES", column: "localPolicyMaxLines", defaultValue: "5000" },
  { key: "LOCAL_POLICY_MAX_FILES", column: "localPolicyMaxFiles", defaultValue: "100" },
  { key: "BASE_BRANCH", column: "baseBranch", defaultValue: "main" },
  { key: "OPENCODE_MODEL", column: "opencodeModel", defaultValue: "google/gemini-3-flash-preview" },
  { key: "OPENCODE_WAIT_ON_QUOTA", column: "opencodeWaitOnQuota", defaultValue: "true" },
  { key: "OPENCODE_QUOTA_RETRY_DELAY_MS", column: "opencodeQuotaRetryDelayMs", defaultValue: "30000" },
  { key: "OPENCODE_MAX_QUOTA_WAITS", column: "opencodeMaxQuotaWaits", defaultValue: "-1" },
  { key: "PLANNER_MODEL", column: "plannerModel", defaultValue: "google/gemini-3-pro-preview" },
  { key: "JUDGE_MODEL", column: "judgeModel", defaultValue: "google/gemini-3-pro-preview" },
  { key: "WORKER_MODEL", column: "workerModel", defaultValue: "google/gemini-3-flash-preview" },
  { key: "PLANNER_USE_REMOTE", column: "plannerUseRemote", defaultValue: "false" },
  { key: "PLANNER_REPO_URL", column: "plannerRepoUrl", defaultValue: "" },
  { key: "AUTO_REPLAN", column: "autoReplan", defaultValue: "true" },
  { key: "REPLAN_REQUIREMENT_PATH", column: "replanRequirementPath", defaultValue: "requirement.md" },
  { key: "REPLAN_INTERVAL_MS", column: "replanIntervalMs", defaultValue: "60000" },
  { key: "REPLAN_COMMAND", column: "replanCommand", defaultValue: "pnpm --filter @openTiger/planner start" },
  { key: "REPLAN_WORKDIR", column: "replanWorkdir", defaultValue: "" },
  { key: "REPLAN_REPO_URL", column: "replanRepoUrl", defaultValue: "" },
  { key: "GITHUB_TOKEN", column: "githubToken", defaultValue: "" },
  { key: "GITHUB_OWNER", column: "githubOwner", defaultValue: "" },
  { key: "GITHUB_REPO", column: "githubRepo", defaultValue: "" },
  // API Keys for LLM providers
  { key: "ANTHROPIC_API_KEY", column: "anthropicApiKey", defaultValue: "" },
  { key: "GEMINI_API_KEY", column: "geminiApiKey", defaultValue: "" },
  { key: "OPENAI_API_KEY", column: "openaiApiKey", defaultValue: "" },
  { key: "XAI_API_KEY", column: "xaiApiKey", defaultValue: "" },
  { key: "DEEPSEEK_API_KEY", column: "deepseekApiKey", defaultValue: "" },
];

export const CONFIG_KEYS = CONFIG_FIELDS.map((field) => field.key);

export const DEFAULT_CONFIG = CONFIG_FIELDS.reduce<Record<string, string>>((acc, field) => {
  acc[field.key] = field.defaultValue;
  return acc;
}, {});

export function buildConfigRecord(
  values: Record<string, string>,
  options: { includeDefaults?: boolean } = {}
): Partial<typeof configTable.$inferInsert> {
  const includeDefaults = options.includeDefaults ?? false;
  const record: Partial<Record<ConfigColumn, string>> = {};
  for (const field of CONFIG_FIELDS) {
    const rawValue = values[field.key];
    if (rawValue !== undefined) {
      record[field.column] = rawValue;
      continue;
    }
    if (includeDefaults) {
      record[field.column] = field.defaultValue;
    }
  }
  return record as Partial<typeof configTable.$inferInsert>;
}

export function rowToConfig(
  row: typeof configTable.$inferSelect
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of CONFIG_FIELDS) {
    const value = row[field.column];
    result[field.key] =
      typeof value === "string" && value.length > 0 ? value : field.defaultValue;
  }
  return result;
}

export function configToEnv(
  row: typeof configTable.$inferSelect
): Record<string, string> {
  const config = rowToConfig(row);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== "") {
      env[key] = value;
    }
  }
  return env;
}
