export type ExecutorMode = "claude_code" | "codex" | "opencode";
export type AgentExecutorRole = "planner" | "judge" | "worker" | "tester" | "docser";

export const CLAUDE_CODE_DEFAULT_MODEL = "claude-opus-4-6";
export const CODEX_DEFAULT_MODEL = "gpt-5.3-codex";
export const DEFAULT_EXECUTOR: ExecutorMode = "codex";
export const INHERIT_EXECUTOR_TOKEN = "inherit";
export const AGENT_EXECUTOR_ROLES: readonly AgentExecutorRole[] = [
  "planner",
  "judge",
  "worker",
  "tester",
  "docser",
];
export const AGENT_EXECUTOR_CONFIG_KEY_BY_ROLE: Record<AgentExecutorRole, string> = {
  planner: "PLANNER_LLM_EXECUTOR",
  judge: "JUDGE_LLM_EXECUTOR",
  worker: "WORKER_LLM_EXECUTOR",
  tester: "TESTER_LLM_EXECUTOR",
  docser: "DOCSER_LLM_EXECUTOR",
};

export function isClaudeExecutor(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

export function isCodexExecutor(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "codex-cli" || normalized === "codex_cli";
}

export function normalizeExecutor(
  value?: string,
  fallback: ExecutorMode = DEFAULT_EXECUTOR,
): ExecutorMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "opencode") {
    return "opencode";
  }
  if (isCodexExecutor(normalized)) {
    return "codex";
  }
  if (isClaudeExecutor(normalized)) {
    return "claude_code";
  }
  return fallback;
}

function isInheritExecutorValue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === INHERIT_EXECUTOR_TOKEN;
}

export function resolveRoleExecutor(
  config: Record<string, string | undefined>,
  role: AgentExecutorRole,
): ExecutorMode {
  const defaultExecutor = normalizeExecutor(config.LLM_EXECUTOR, DEFAULT_EXECUTOR);
  const key = AGENT_EXECUTOR_CONFIG_KEY_BY_ROLE[role];
  const roleRaw = config[key];
  if (!roleRaw || isInheritExecutorValue(roleRaw)) {
    return defaultExecutor;
  }
  return normalizeExecutor(roleRaw, defaultExecutor);
}

export function collectConfiguredExecutors(
  config: Record<string, string | undefined>,
): Set<ExecutorMode> {
  const executors = new Set<ExecutorMode>();
  for (const role of AGENT_EXECUTOR_ROLES) {
    executors.add(resolveRoleExecutor(config, role));
  }
  return executors;
}

export function normalizeClaudeModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("anthropic/")) {
    return trimmed.slice("anthropic/".length);
  }
  if (trimmed.startsWith("claude")) {
    return trimmed;
  }
  return undefined;
}

export function normalizeCodexModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("openai/")) {
    const stripped = trimmed.slice("openai/".length).trim();
    return stripped.length > 0 ? stripped : undefined;
  }
  const lower = trimmed.toLowerCase();
  const clearlyNonCodexPrefixes = [
    "google/",
    "anthropic/",
    "xai/",
    "deepseek/",
    "groq/",
    "ollama/",
  ];
  if (clearlyNonCodexPrefixes.some((prefix) => lower.startsWith(prefix))) {
    return undefined;
  }
  if (trimmed.includes("/") && !trimmed.startsWith("openai/")) {
    return undefined;
  }
  return trimmed;
}
