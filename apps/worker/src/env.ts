import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "dotenv";
import { db } from "@sebastian-code/db";
import { config as configTable } from "@sebastian-code/db/schema";

const STRIP_ENV_PREFIXES = [
  "H1VE_",
  "SEBASTIAN_",
  "REPLAN_",
  "PLANNER_",
  "WORKER_",
  "JUDGE_",
  "OPENCODE_",
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
  "SEBASTIAN_LOG_DIR",
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
  "OPENCODE_FALLBACK_MODEL",
  "OPENCODE_MAX_RETRIES",
  "OPENCODE_RETRY_DELAY_MS",
]);

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

export async function getProjectEnvSummary(
  cwd: string
): Promise<{ hasEnvFile: boolean; keys: string[] }> {
  try {
    const content = await readFile(join(cwd, ".env"), "utf-8");
    const parsed = parse(content);
    return { hasEnvFile: true, keys: Object.keys(parsed) };
  } catch {
    return { hasEnvFile: false, keys: [] };
  }
}

export async function buildTaskEnv(
  cwd: string
): Promise<Record<string, string>> {
  // h1ve固有の環境変数は実行対象に渡さない
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || shouldStripEnvKey(key)) {
      continue;
    }
    baseEnv[key] = value;
  }

  // 実行対象の.envを読み込み、必要な設定だけを付与する
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
  // DBからランタイム設定を取得してOpenCodeに渡す
  try {
    const rows = await db.select().from(configTable).limit(1);
    const row = rows[0];
    if (!row) {
      return {};
    }
    return {
      GEMINI_API_KEY: row.geminiApiKey ?? "",
      ANTHROPIC_API_KEY: row.anthropicApiKey ?? "",
      OPENAI_API_KEY: row.openaiApiKey ?? "",
      XAI_API_KEY: row.xaiApiKey ?? "",
      DEEPSEEK_API_KEY: row.deepseekApiKey ?? "",
      OPENCODE_MODEL: row.opencodeModel ?? "",
      GITHUB_TOKEN: row.githubToken ?? "",
    };
  } catch (error) {
    console.warn("[Worker] Failed to load config from DB:", error);
    return {};
  }
}

export async function buildOpenCodeEnv(
  cwd: string
): Promise<Record<string, string>> {
  // 実行対象の.envは引き継ぎ、LLM用のキーだけ許可する
  const env = await buildTaskEnv(cwd);
  
  // DBから最新の設定を取得してOpenCodeに渡す
  const dbConfig = await loadConfigFromDb();
  for (const [key, value] of Object.entries(dbConfig)) {
    if (value && OPEN_CODE_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  
  // process.envからもフォールバックで取得（DB優先）
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
  return env;
}
