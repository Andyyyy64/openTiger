import type { config as configTable } from "@openTiger/db/schema";

type ConfigColumn = string;

export type ConfigField = {
  key: string;
  column: ConfigColumn;
  defaultValue: string;
};

export const CONFIG_FIELDS: ConfigField[] = [
  { key: "MAX_CONCURRENT_WORKERS", column: "maxConcurrentWorkers", defaultValue: "-1" },
  { key: "DAILY_TOKEN_LIMIT", column: "dailyTokenLimit", defaultValue: "-1" },
  { key: "HOURLY_TOKEN_LIMIT", column: "hourlyTokenLimit", defaultValue: "-1" },
  { key: "TASK_TOKEN_LIMIT", column: "taskTokenLimit", defaultValue: "-1" },
  { key: "DISPATCHER_ENABLED", column: "dispatcherEnabled", defaultValue: "true" },
  { key: "JUDGE_ENABLED", column: "judgeEnabled", defaultValue: "true" },
  { key: "CYCLE_MANAGER_ENABLED", column: "cycleManagerEnabled", defaultValue: "true" },
  { key: "EXECUTION_ENVIRONMENT", column: "executionEnvironment", defaultValue: "host" },
  { key: "WORKER_COUNT", column: "workerCount", defaultValue: "4" },
  { key: "TESTER_COUNT", column: "testerCount", defaultValue: "4" },
  { key: "DOCSER_COUNT", column: "docserCount", defaultValue: "4" },
  { key: "JUDGE_COUNT", column: "judgeCount", defaultValue: "4" },
  { key: "PLANNER_COUNT", column: "plannerCount", defaultValue: "1" },
  { key: "ENABLED_PLUGINS", column: "enabledPlugins", defaultValue: "" },
  {
    key: "WORKER_NO_CHANGE_RECOVERY_ATTEMPTS",
    column: "workerNoChangeRecoveryAttempts",
    defaultValue: "5",
  },
  {
    key: "WORKER_POLICY_RECOVERY_ATTEMPTS",
    column: "workerPolicyRecoveryAttempts",
    defaultValue: "5",
  },
  {
    key: "WORKER_VERIFY_RECOVERY_ATTEMPTS",
    column: "workerVerifyRecoveryAttempts",
    defaultValue: "5",
  },
  {
    key: "BLOCKED_NEEDS_REWORK_IN_PLACE_RETRY_LIMIT",
    column: "blockedNeedsReworkInPlaceRetryLimit",
    defaultValue: "5",
  },
  {
    key: "DISPATCH_CONFLICT_LANE_MAX_SLOTS",
    column: "dispatchConflictLaneMaxSlots",
    defaultValue: "2",
  },
  {
    key: "DISPATCH_FEATURE_LANE_MIN_SLOTS",
    column: "dispatchFeatureLaneMinSlots",
    defaultValue: "1",
  },
  {
    key: "DISPATCH_DOCSER_LANE_MAX_SLOTS",
    column: "dispatchDocserLaneMaxSlots",
    defaultValue: "1",
  },
  {
    key: "WORKER_SETUP_IN_PROCESS_RECOVERY",
    column: "workerSetupInProcessRecovery",
    defaultValue: "true",
  },
  {
    key: "WORKER_VERIFY_LLM_INLINE_RECOVERY",
    column: "workerVerifyLlmInlineRecovery",
    defaultValue: "true",
  },
  {
    key: "WORKER_VERIFY_LLM_INLINE_RECOVERY_ATTEMPTS",
    column: "workerVerifyLlmInlineRecoveryAttempts",
    defaultValue: "3",
  },
  { key: "REPO_MODE", column: "repoMode", defaultValue: "git" },
  { key: "REPO_URL", column: "repoUrl", defaultValue: "" },
  { key: "LOCAL_REPO_PATH", column: "localRepoPath", defaultValue: "" },
  { key: "LOCAL_WORKTREE_ROOT", column: "localWorktreeRoot", defaultValue: "" },
  { key: "BASE_BRANCH", column: "baseBranch", defaultValue: "main" },
  { key: "LLM_EXECUTOR", column: "llmExecutor", defaultValue: "codex" },
  { key: "WORKER_LLM_EXECUTOR", column: "workerLlmExecutor", defaultValue: "inherit" },
  { key: "TESTER_LLM_EXECUTOR", column: "testerLlmExecutor", defaultValue: "inherit" },
  { key: "DOCSER_LLM_EXECUTOR", column: "docserLlmExecutor", defaultValue: "inherit" },
  { key: "JUDGE_LLM_EXECUTOR", column: "judgeLlmExecutor", defaultValue: "inherit" },
  { key: "PLANNER_LLM_EXECUTOR", column: "plannerLlmExecutor", defaultValue: "inherit" },
  { key: "OPENCODE_MODEL", column: "opencodeModel", defaultValue: "google/gemini-3-flash-preview" },
  {
    key: "OPENCODE_SMALL_MODEL",
    column: "opencodeSmallModel",
    defaultValue: "google/gemini-2.5-flash",
  },
  { key: "OPENCODE_WAIT_ON_QUOTA", column: "opencodeWaitOnQuota", defaultValue: "true" },
  {
    key: "OPENCODE_QUOTA_RETRY_DELAY_MS",
    column: "opencodeQuotaRetryDelayMs",
    defaultValue: "30000",
  },
  { key: "OPENCODE_MAX_QUOTA_WAITS", column: "opencodeMaxQuotaWaits", defaultValue: "-1" },
  { key: "CODEX_MODEL", column: "codexModel", defaultValue: "gpt-5.3-codex" },
  { key: "CODEX_MAX_RETRIES", column: "codexMaxRetries", defaultValue: "3" },
  { key: "CODEX_RETRY_DELAY_MS", column: "codexRetryDelayMs", defaultValue: "5000" },
  {
    key: "CLAUDE_CODE_PERMISSION_MODE",
    column: "claudeCodePermissionMode",
    defaultValue: "bypassPermissions",
  },
  {
    key: "CLAUDE_CODE_MODEL",
    column: "claudeCodeModel",
    defaultValue: "claude-opus-4-6",
  },
  { key: "CLAUDE_CODE_MAX_TURNS", column: "claudeCodeMaxTurns", defaultValue: "0" },
  { key: "CLAUDE_CODE_ALLOWED_TOOLS", column: "claudeCodeAllowedTools", defaultValue: "" },
  {
    key: "CLAUDE_CODE_DISALLOWED_TOOLS",
    column: "claudeCodeDisallowedTools",
    defaultValue: "",
  },
  {
    key: "CLAUDE_CODE_APPEND_SYSTEM_PROMPT",
    column: "claudeCodeAppendSystemPrompt",
    defaultValue: "",
  },
  { key: "PLANNER_MODEL", column: "plannerModel", defaultValue: "google/gemini-3-pro-preview" },
  { key: "JUDGE_MODEL", column: "judgeModel", defaultValue: "google/gemini-3-pro-preview" },
  {
    key: "JUDGE_MERGE_QUEUE_MAX_ATTEMPTS",
    column: "judgeMergeQueueMaxAttempts",
    defaultValue: "3",
  },
  {
    key: "JUDGE_MERGE_QUEUE_RETRY_DELAY_MS",
    column: "judgeMergeQueueRetryDelayMs",
    defaultValue: "30000",
  },
  {
    key: "JUDGE_MERGE_QUEUE_CLAIM_TTL_MS",
    column: "judgeMergeQueueClaimTtlMs",
    defaultValue: "120000",
  },
  { key: "WORKER_MODEL", column: "workerModel", defaultValue: "google/gemini-3-flash-preview" },
  { key: "TESTER_MODEL", column: "testerModel", defaultValue: "google/gemini-3-flash-preview" },
  { key: "DOCSER_MODEL", column: "docserModel", defaultValue: "google/gemini-3-flash-preview" },
  { key: "PLANNER_USE_REMOTE", column: "plannerUseRemote", defaultValue: "true" },
  { key: "PLANNER_REPO_URL", column: "plannerRepoUrl", defaultValue: "" },
  { key: "AUTO_REPLAN", column: "autoReplan", defaultValue: "true" },
  {
    key: "REPLAN_REQUIREMENT_PATH",
    column: "replanRequirementPath",
    defaultValue: "docs/requirement.md",
  },
  { key: "REPLAN_INTERVAL_MS", column: "replanIntervalMs", defaultValue: "60000" },
  {
    key: "REPLAN_COMMAND",
    column: "replanCommand",
    defaultValue: "pnpm --filter @openTiger/planner run start:fresh",
  },
  { key: "REPLAN_WORKDIR", column: "replanWorkdir", defaultValue: "" },
  { key: "REPLAN_REPO_URL", column: "replanRepoUrl", defaultValue: "" },
  { key: "GITHUB_AUTH_MODE", column: "githubAuthMode", defaultValue: "gh" },
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
  options: { includeDefaults?: boolean } = {},
): Partial<typeof configTable.$inferInsert> {
  const includeDefaults = options.includeDefaults ?? false;
  const record: Record<string, string> = {};
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

export function rowToConfig(row: typeof configTable.$inferSelect): Record<string, string> {
  const result: Record<string, string> = {};
  const source = row as unknown as Record<string, string | undefined>;
  for (const field of CONFIG_FIELDS) {
    const value = source[field.column];
    result[field.key] = typeof value === "string" && value.length > 0 ? value : field.defaultValue;
  }
  return result;
}

export function configToEnv(row: typeof configTable.$inferSelect): Record<string, string> {
  const config = rowToConfig(row);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== "") {
      env[key] = value;
    }
  }
  return env;
}
