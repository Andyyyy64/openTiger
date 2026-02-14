import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "dotenv";
import { db } from "@openTiger/db";
import { config as configTable } from "@openTiger/db/schema";

const STRIP_ENV_PREFIXES = [
  "H1VE_",
  "OPENTIGER_",
  "REPLAN_",
  "PLANNER_",
  "WORKER_",
  "JUDGE_",
  "OPENCODE_",
  "CODEX_",
  "CLAUDE_",
  "LLM_",
  "GEMINI_",
  "ANTHROPIC_",
  "GITHUB_",
];

const STRIP_ENV_KEYS = new Set([
  "API_SECRET",
  "DATABASE_URL",
  "REDIS_URL",
  "REPO_URL",
  "REPO_MODE",
  "LOCAL_REPO_PATH",
  "LOCAL_WORKTREE_ROOT",
  "BASE_BRANCH",
  "WORKSPACE_PATH",
  "AGENT_ID",
  "AGENT_ROLE",
  "TASK_ID",
  "MAX_CONCURRENT_WORKERS",
  "DAILY_TOKEN_LIMIT",
  "HOURLY_TOKEN_LIMIT",
  "TASK_TOKEN_LIMIT",
  "OPENTIGER_LOG_DIR",
  "H1VE_LOG_DIR",
  "LOG_LEVEL",
  "LOG_FORMAT",
  "CLEANUP_INTERVAL_MS",
  "DISPATCH_RETRY_DELAY_MS",
]);

const PROTECTED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
]);

const OPEN_CODE_ENV_KEYS = new Set([
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_MODEL",
  "OPENCODE_SMALL_MODEL",
  "OPENCODE_FALLBACK_MODEL",
  "OPENCODE_MAX_RETRIES",
  "OPENCODE_RETRY_DELAY_MS",
  "OPENCODE_WAIT_ON_QUOTA",
  "OPENCODE_QUOTA_RETRY_DELAY_MS",
  "OPENCODE_MAX_QUOTA_WAITS",
  "OPENCODE_CONFIG",
  "CODEX_API_KEY",
  "CODEX_MODEL",
  "CODEX_MAX_RETRIES",
  "CODEX_RETRY_DELAY_MS",
  "LLM_EXECUTOR",
  "CLAUDE_CODE_PERMISSION_MODE",
  "CLAUDE_CODE_MODEL",
  "CLAUDE_CODE_MAX_TURNS",
  "CLAUDE_CODE_ALLOWED_TOOLS",
  "CLAUDE_CODE_DISALLOWED_TOOLS",
  "CLAUDE_CODE_APPEND_SYSTEM_PROMPT",
]);
type ExecutorKind = "opencode" | "claude_code" | "codex";

function isClaudeExecutorValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

function isCodexExecutorValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "codex-cli" || normalized === "codex_cli";
}

function normalizeExecutorValue(
  value: string | undefined,
  fallback: ExecutorKind = "claude_code",
): ExecutorKind {
  if (isClaudeExecutorValue(value)) {
    return "claude_code";
  }
  if (isCodexExecutorValue(value)) {
    return "codex";
  }
  if (value?.trim().toLowerCase() === "opencode") {
    return "opencode";
  }
  return fallback;
}

function resolveExecutorForAgentRole(
  rowRecord: Record<string, string | undefined>,
  rawRole: string | undefined,
): ExecutorKind {
  const defaultExecutor = normalizeExecutorValue(rowRecord.llmExecutor, "claude_code");
  const role = rawRole?.trim().toLowerCase();
  const roleOverride =
    role === "tester"
      ? rowRecord.testerLlmExecutor
      : role === "docser"
        ? rowRecord.docserLlmExecutor
        : rowRecord.workerLlmExecutor;
  if (!roleOverride || roleOverride.trim().toLowerCase() === "inherit") {
    return defaultExecutor;
  }
  return normalizeExecutorValue(roleOverride, defaultExecutor);
}

function shouldStripEnvKey(key: string): boolean {
  if (STRIP_ENV_KEYS.has(key)) {
    return true;
  }
  return STRIP_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

async function loadProjectEnv(cwd: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(join(cwd, ".env"), "utf-8");
    return parse(content);
  } catch {
    return {};
  }
}

async function resolveDefaultOpenCodeConfigPath(cwd: string): Promise<string | undefined> {
  const candidates = [
    process.env.OPENCODE_CONFIG,
    join(process.cwd(), "opencode.json"),
    resolve(import.meta.dirname, "../../../opencode.json"),
    join(cwd, "opencode.json"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  return undefined;
}

export async function getProjectEnvSummary(
  cwd: string,
): Promise<{ hasEnvFile: boolean; keys: string[] }> {
  try {
    const content = await readFile(join(cwd, ".env"), "utf-8");
    const parsed = parse(content);
    return { hasEnvFile: true, keys: Object.keys(parsed) };
  } catch {
    return { hasEnvFile: false, keys: [] };
  }
}

export async function buildTaskEnv(cwd: string): Promise<Record<string, string>> {
  // Don't pass h1ve-specific environment variables to execution target
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || shouldStripEnvKey(key)) {
      continue;
    }
    baseEnv[key] = value;
  }

  // Load target's .env and only provide necessary settings
  const projectEnv = await loadProjectEnv(cwd);
  for (const [key, value] of Object.entries(projectEnv)) {
    if (PROTECTED_ENV_KEYS.has(key)) {
      continue;
    }
    baseEnv[key] = value;
  }

  return baseEnv;
}

async function loadConfigFromDb(): Promise<Record<string, string>> {
  // Get runtime settings from DB and pass to OpenCode
  try {
    const rows = await db.select().from(configTable).limit(1);
    const row = rows[0];
    if (!row) {
      return {};
    }
    const rowRecord = row as unknown as Record<string, string | undefined>;
    const resolvedExecutor = resolveExecutorForAgentRole(rowRecord, process.env.AGENT_ROLE);
    return {
      GEMINI_API_KEY: row.geminiApiKey ?? "",
      ANTHROPIC_API_KEY: row.anthropicApiKey ?? "",
      OPENAI_API_KEY: row.openaiApiKey ?? "",
      XAI_API_KEY: row.xaiApiKey ?? "",
      DEEPSEEK_API_KEY: row.deepseekApiKey ?? "",
      OPENCODE_MODEL: row.opencodeModel ?? "",
      OPENCODE_SMALL_MODEL: rowRecord.opencodeSmallModel ?? "",
      OPENCODE_WAIT_ON_QUOTA: row.opencodeWaitOnQuota ?? "",
      OPENCODE_QUOTA_RETRY_DELAY_MS: row.opencodeQuotaRetryDelayMs ?? "",
      OPENCODE_MAX_QUOTA_WAITS: row.opencodeMaxQuotaWaits ?? "",
      CODEX_MODEL: rowRecord.codexModel ?? "",
      CODEX_MAX_RETRIES: rowRecord.codexMaxRetries ?? "",
      CODEX_RETRY_DELAY_MS: rowRecord.codexRetryDelayMs ?? "",
      LLM_EXECUTOR: resolvedExecutor,
      CLAUDE_CODE_PERMISSION_MODE: rowRecord.claudeCodePermissionMode ?? "",
      CLAUDE_CODE_MODEL: rowRecord.claudeCodeModel ?? "",
      CLAUDE_CODE_MAX_TURNS: rowRecord.claudeCodeMaxTurns ?? "",
      CLAUDE_CODE_ALLOWED_TOOLS: rowRecord.claudeCodeAllowedTools ?? "",
      CLAUDE_CODE_DISALLOWED_TOOLS: rowRecord.claudeCodeDisallowedTools ?? "",
      CLAUDE_CODE_APPEND_SYSTEM_PROMPT: rowRecord.claudeCodeAppendSystemPrompt ?? "",
      GITHUB_TOKEN: row.githubToken ?? "",
    };
  } catch (error) {
    console.warn("[Worker] Failed to load config from DB:", error);
    return {};
  }
}

export async function buildOpenCodeEnv(cwd: string): Promise<Record<string, string>> {
  // Inherit target's .env and only allow LLM-related keys
  const env = await buildTaskEnv(cwd);

  // Get latest settings from DB and pass to OpenCode
  const dbConfig = await loadConfigFromDb();
  for (const [key, value] of Object.entries(dbConfig)) {
    if (value && OPEN_CODE_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }

  // Also get from process.env as fallback (DB takes priority)
  for (const key of OPEN_CODE_ENV_KEYS) {
    if (env[key]) {
      continue;
    }
    const value = process.env[key];
    if (!value) {
      continue;
    }
    env[key] = value;
  }

  if (!env.CODEX_API_KEY && env.OPENAI_API_KEY) {
    env.CODEX_API_KEY = env.OPENAI_API_KEY;
  }

  // Use default config file even if OPENCODE_CONFIG is not explicitly set
  if (!env.OPENCODE_CONFIG) {
    const configPath = await resolveDefaultOpenCodeConfigPath(cwd);
    if (configPath) {
      env.OPENCODE_CONFIG = configPath;
    }
  }

  // On quota wait: do not sleep in Worker; release task as blocked for retry later.
  // Use env var to disable if needed.
  const handoffQuotaWait =
    (process.env.WORKER_QUOTA_HANDOFF_TO_QUEUE ?? "true").toLowerCase() !== "false";
  if (handoffQuotaWait) {
    env.OPENCODE_WAIT_ON_QUOTA = "true";
    env.OPENCODE_MAX_QUOTA_WAITS = "0";
  }

  return env;
}
