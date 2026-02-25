import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db, closeDb, sql } from "../packages/db/src/client.ts";
import { config as configTable } from "../packages/db/src/schema.ts";
import { getBootstrapLlmExecutor } from "../apps/api/src/bootstrap-llm-executor.ts";

type ConfigColumn = string;

type ConfigField = {
  key: string;
  column: ConfigColumn;
  defaultValue: string;
};

const CONFIG_FIELDS: ConfigField[] = [
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
  { key: "REPO_MODE", column: "repoMode", defaultValue: "github" },
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

const CONFIG_KEYS = CONFIG_FIELDS.map((field) => field.key);

const DEFAULT_CONFIG = CONFIG_FIELDS.reduce<Record<string, string>>((acc, field) => {
  acc[field.key] = field.defaultValue;
  return acc;
}, {});

function buildConfigRecord(
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

function rowToConfig(row: typeof configTable.$inferSelect): Record<string, string> {
  const result: Record<string, string> = {};
  const source = row as unknown as Record<string, string | undefined>;
  for (const field of CONFIG_FIELDS) {
    const value = source[field.column];
    result[field.key] = typeof value === "string" && value.length > 0 ? value : field.defaultValue;
  }
  return result;
}

function encodeEnvValue(value: string): string {
  if (value.length === 0) {
    return "";
  }
  if (/[\s#"']/u.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function replaceConfigLines(
  source: string,
  values: Record<string, string>,
): { content: string; updatedKeys: string[] } {
  const lines = source.length > 0 ? source.split(/\r?\n/) : [];
  const remaining = new Set(CONFIG_KEYS);
  const updatedKeys: string[] = [];

  const replaced = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    const key = match?.[1];
    if (!key || !remaining.has(key)) {
      return line;
    }

    remaining.delete(key);
    updatedKeys.push(key);
    return `${key}=${encodeEnvValue(values[key] ?? "")}`;
  });

  const missingKeys = CONFIG_KEYS.filter((key) => remaining.has(key));
  if (missingKeys.length > 0) {
    if (replaced.length > 0 && replaced[replaced.length - 1] !== "") {
      replaced.push("");
    }
    replaced.push("# --- openTiger config (synced from DB) ---");
    for (const key of missingKeys) {
      replaced.push(`${key}=${encodeEnvValue(values[key] ?? "")}`);
      updatedKeys.push(key);
    }
  }

  return {
    content: `${replaced.join("\n").replace(/\n+$/u, "")}\n`,
    updatedKeys,
  };
}

function sanitizeLegacyLogDirPlaceholder(source: string): { content: string; updated: boolean } {
  const lines = source.length > 0 ? source.split(/\r?\n/) : [];
  let updated = false;
  const replaced = lines.map((line) => {
    if (/^\s*OPENTIGER_LOG_DIR\s*=\s*\/absolute\/path\/to\/openTiger\/raw-logs\s*$/u.test(line)) {
      updated = true;
      return "# OPENTIGER_LOG_DIR (optional; defaults to <repo-root>/raw-logs when unset)";
    }
    return line;
  });
  return {
    content: `${replaced.join("\n").replace(/\n+$/u, "")}\n`,
    updated,
  };
}

const LEGACY_REPLAN_COMMANDS = new Set([
  "",
  "pnpm --filter @openTiger/planner start",
  "pnpm --filter @sebastian-code/planner start",
]);

const DEFAULT_REPLAN_COMMAND = "pnpm --filter @openTiger/planner run start:fresh";

async function ensureConfigColumns(): Promise<void> {
  // Repair missing columns so it works even when system_config is broken
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_wait_on_quota" text DEFAULT 'true' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "execution_environment" text DEFAULT 'host' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_quota_retry_delay_ms" text DEFAULT '30000' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_max_quota_waits" text DEFAULT '-1' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "codex_model" text DEFAULT 'gpt-5.3-codex' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "codex_max_retries" text DEFAULT '3' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "codex_retry_delay_ms" text DEFAULT '5000' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_small_model" text DEFAULT 'google/gemini-2.5-flash' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "llm_executor" text DEFAULT 'codex' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "worker_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "tester_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "docser_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "planner_llm_executor" text DEFAULT 'inherit' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_permission_mode" text DEFAULT 'bypassPermissions' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_model" text DEFAULT 'claude-opus-4-6' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_max_turns" text DEFAULT '0' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_allowed_tools" text DEFAULT '' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_disallowed_tools" text DEFAULT '' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "claude_code_append_system_prompt" text DEFAULT '' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_count" text DEFAULT '1' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "planner_count" text DEFAULT '1' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "dispatch_conflict_lane_max_slots" text DEFAULT '2' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "dispatch_feature_lane_min_slots" text DEFAULT '1' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "dispatch_docser_lane_max_slots" text DEFAULT '1' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_merge_queue_max_attempts" text DEFAULT '3' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_merge_queue_retry_delay_ms" text DEFAULT '30000' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_merge_queue_claim_ttl_ms" text DEFAULT '120000' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "github_auth_mode" text DEFAULT 'gh' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "tester_model" text DEFAULT 'google/gemini-3-flash-preview' NOT NULL`,
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "docser_model" text DEFAULT 'google/gemini-3-flash-preview' NOT NULL`,
  );
}

function createLegacyNormalizationPatch(
  current: typeof configTable.$inferSelect,
): Partial<typeof configTable.$inferInsert> | null {
  const shouldNormalizeReplanCommand = LEGACY_REPLAN_COMMANDS.has(
    (current.replanCommand ?? "").trim(),
  );
  const shouldNormalizeMaxConcurrentWorkers = (current.maxConcurrentWorkers ?? "").trim() === "10";
  const shouldNormalizeDailyTokenLimit = (current.dailyTokenLimit ?? "").trim() === "50000000";
  const shouldNormalizeHourlyTokenLimit = (current.hourlyTokenLimit ?? "").trim() === "5000000";
  const shouldNormalizeTaskTokenLimit = (current.taskTokenLimit ?? "").trim() === "1000000";

  if (
    !shouldNormalizeReplanCommand &&
    !shouldNormalizeMaxConcurrentWorkers &&
    !shouldNormalizeDailyTokenLimit &&
    !shouldNormalizeHourlyTokenLimit &&
    !shouldNormalizeTaskTokenLimit
  ) {
    return null;
  }

  const patch: Partial<typeof configTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (shouldNormalizeReplanCommand) {
    patch.replanCommand = DEFAULT_REPLAN_COMMAND;
  }
  if (shouldNormalizeMaxConcurrentWorkers) {
    patch.maxConcurrentWorkers = "-1";
  }
  if (shouldNormalizeDailyTokenLimit) {
    patch.dailyTokenLimit = "-1";
  }
  if (shouldNormalizeHourlyTokenLimit) {
    patch.hourlyTokenLimit = "-1";
  }
  if (shouldNormalizeTaskTokenLimit) {
    patch.taskTokenLimit = "-1";
  }
  return patch;
}

async function ensureConfigRow(): Promise<typeof configTable.$inferSelect> {
  await ensureConfigColumns();
  return await db.transaction(async (tx) => {
    // Avoid duplicate creation on concurrent startup
    await tx.execute(sql`SELECT pg_advisory_xact_lock(703614, 1)`);

    const existing = await tx.select().from(configTable).limit(1);
    const current = existing[0];
    if (current) {
      const patch = createLegacyNormalizationPatch(current);
      if (!patch) {
        return current;
      }
      const [updated] = await tx
        .update(configTable)
        .set(patch)
        .where(sql`${configTable.id} = ${current.id}`)
        .returning();
      return updated ?? current;
    }

    const defaultsForInsert = {
      ...DEFAULT_CONFIG,
      LLM_EXECUTOR: await getBootstrapLlmExecutor(),
    };
    const created = await tx
      .insert(configTable)
      .values(buildConfigRecord(defaultsForInsert, { includeDefaults: true }))
      .returning();
    const row = created[0];
    if (!row) {
      throw new Error("Failed to create config");
    }
    return row;
  });
}

async function main(): Promise<void> {
  const envPath = process.env.OPENTIGER_ENV_PATH ?? resolve(process.cwd(), ".env");
  const configRow = await ensureConfigRow();
  const snapshot = rowToConfig(configRow);

  let current = "";
  try {
    current = await readFile(envPath, "utf-8");
  } catch {
    current = "";
  }

  const { content, updatedKeys } = replaceConfigLines(current, snapshot);
  const sanitized = sanitizeLegacyLogDirPlaceholder(content);
  await writeFile(envPath, sanitized.content, "utf-8");

  console.log("[Config] DB -> .env sync completed:", {
    path: envPath,
    normalizedLegacyLogDir: sanitized.updated,
    updatedKeysCount: updatedKeys.length,
    updatedKeys,
  });
}

main()
  .catch((error) => {
    console.error("[Config] DB -> .env sync failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
