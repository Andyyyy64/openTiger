// Settings form definitions and display order
export const REPO_MODE_OPTIONS = ["github", "local-git", "direct"] as const;
export const GITHUB_AUTH_MODE_OPTIONS = ["gh", "token"] as const;
export const LLM_EXECUTOR_OPTIONS = ["codex", "claude_code", "opencode"] as const;
export const AGENT_LLM_EXECUTOR_OPTIONS = ["inherit", ...LLM_EXECUTOR_OPTIONS] as const;
export const EXECUTION_ENVIRONMENT_OPTIONS = ["host", "sandbox"] as const;
export const CLAUDE_PERMISSION_MODE_OPTIONS = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "delegate",
  "dontAsk",
  "plan",
] as const;
export const CLAUDE_CODE_MODEL_OPTIONS = [
  "claude-opus-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-20250514",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-20250514",
] as const;
export const CODEX_MODEL_OPTIONS = [
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5-codex",
  "gpt-5-codex-mini",
  "gpt-5",
] as const;
// OpenCode supported models
// Reference: https://opencode.ai/docs/providers
export const MODEL_OPTIONS = [
  // Google Gemini 3
  "google/gemini-3-pro-preview",
  "google/gemini-3-flash-preview",
  // Google Gemini 2
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.0-flash",
  "google/gemini-2.0-flash-lite",
  // Claude Sonnet 4/4.5
  "anthropic/claude-sonnet-4-20250514",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-sonnet-4-5-20250929",
  // Claude Opus 4/4.5
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-20250514",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-opus-4-5-20251101",
  // OpenAI Codex
  "openai/codex-mini-latest",
  "openai/gpt-5-codex",
  "openai/gpt-5.1-codex",
  "openai/gpt-5.1-codex-mini",
  "openai/gpt-5.1-codex-max",
  "openai/gpt-5.2-codex",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.3-codex-spark",
] as const;

export type SettingField = {
  key: string;
  label: string;
  description: string;
  group: string;
  type: "text" | "number" | "boolean" | "select";
  options?: readonly string[];
};

// Treat as required if empty would break main flow
export const REQUIRED_SETTING_KEYS = new Set<string>(["GITHUB_OWNER", "REPO_URL"]);

export function isSettingRequired(
  key: string,
  values: Record<string, string> | undefined,
): boolean {
  if (key === "GITHUB_TOKEN") {
    const authMode = (values?.GITHUB_AUTH_MODE ?? "gh").trim().toLowerCase();
    return authMode === "token";
  }
  if (REQUIRED_SETTING_KEYS.has(key)) {
    return true;
  }
  const autoReplanEnabled = (values?.AUTO_REPLAN ?? "").trim().toLowerCase() === "true";
  if (!autoReplanEnabled) {
    return false;
  }
  return key === "REPLAN_REQUIREMENT_PATH";
}

type FieldHelpLink = {
  label: string;
  url: string;
};

// Add links only for settings that should link to supporting docs
export const FIELD_HELP_LINKS: Partial<Record<string, FieldHelpLink>> = {
  GITHUB_AUTH_MODE: {
    label: "Install GitHub CLI",
    url: "https://cli.github.com/",
  },
  GITHUB_TOKEN: {
    label: "Create GitHub Personal Access Token",
    url: "https://github.com/settings/personal-access-tokens",
  },
};

export const SETTINGS: SettingField[] = [
  {
    key: "MAX_CONCURRENT_WORKERS",
    label: "Parallel_Workers",
    description: "Max concurrent worker processes (-1 for unlimited)",
    group: "Limits",
    type: "number",
  },
  {
    key: "DAILY_TOKEN_LIMIT",
    label: "Daily_Token_Max",
    description: "Max tokens per day (-1 for unlimited)",
    group: "Limits",
    type: "number",
  },
  {
    key: "HOURLY_TOKEN_LIMIT",
    label: "Hourly_Token_Max",
    description: "Max tokens per hour (-1 for unlimited)",
    group: "Limits",
    type: "number",
  },
  {
    key: "TASK_TOKEN_LIMIT",
    label: "Task_Token_Max",
    description: "Max tokens per single task (-1 for unlimited)",
    group: "Limits",
    type: "number",
  },
  {
    key: "DISPATCHER_ENABLED",
    label: "Enable_Dispatcher",
    description: "Include dispatcher in boot sequence",
    group: "Runtime",
    type: "boolean",
  },
  {
    key: "JUDGE_ENABLED",
    label: "Enable_Judge",
    description: "Include judge in boot sequence",
    group: "Runtime",
    type: "boolean",
  },
  {
    key: "CYCLE_MANAGER_ENABLED",
    label: "Enable_CycleMgr",
    description: "Include cycle manager",
    group: "Runtime",
    type: "boolean",
  },
  {
    key: "ENABLED_PLUGINS",
    label: "Enabled_Plugins",
    description: "Select plugin IDs. Clear selection to enable all registered plugins.",
    group: "Runtime",
    type: "select",
  },
  {
    key: "EXECUTION_ENVIRONMENT",
    label: "Execution_Environment",
    description: "host=process runtime, sandbox=docker runtime",
    group: "Runtime",
    type: "select",
    options: EXECUTION_ENVIRONMENT_OPTIONS,
  },
  {
    key: "WORKER_COUNT",
    label: "Worker_Count",
    description: "Number of worker nodes",
    group: "Workers",
    type: "number",
  },
  {
    key: "TESTER_COUNT",
    label: "Tester_Count",
    description: "Number of tester nodes",
    group: "Workers",
    type: "number",
  },
  {
    key: "DOCSER_COUNT",
    label: "Docser_Count",
    description: "Number of docser nodes",
    group: "Workers",
    type: "number",
  },
  {
    key: "JUDGE_COUNT",
    label: "Judge_Count",
    description: "Number of judge nodes",
    group: "Workers",
    type: "number",
  },
  {
    key: "PLANNER_COUNT",
    label: "Planner_Count",
    description: "Number of planner nodes",
    group: "Workers",
    type: "number",
  },
  {
    key: "WORKER_NO_CHANGE_RECOVERY_ATTEMPTS",
    label: "Worker_NoChange_RecoveryAttempts",
    description: "In-process retry attempts after no-change verification result",
    group: "Recovery",
    type: "number",
  },
  {
    key: "WORKER_POLICY_RECOVERY_ATTEMPTS",
    label: "Worker_Policy_RecoveryAttempts",
    description: "In-process retry attempts for policy-violation recovery",
    group: "Recovery",
    type: "number",
  },
  {
    key: "WORKER_VERIFY_RECOVERY_ATTEMPTS",
    label: "Worker_Verify_RecoveryAttempts",
    description: "In-process retry attempts for verification-command failures",
    group: "Recovery",
    type: "number",
  },
  {
    key: "BLOCKED_NEEDS_REWORK_IN_PLACE_RETRY_LIMIT",
    label: "Blocked_Rework_InPlaceRetryLimit",
    description: "Cycle-manager in-place requeue limit before rework split (-1 for unlimited)",
    group: "Recovery",
    type: "number",
  },
  {
    key: "WORKER_SETUP_IN_PROCESS_RECOVERY",
    label: "Worker_Setup_InProcessRecovery",
    description: "Allow in-process LLM recovery for setup/bootstrap failures (true/false)",
    group: "Recovery",
    type: "text",
  },
  {
    key: "WORKER_VERIFY_LLM_INLINE_RECOVERY",
    label: "Worker_Verify_LLMInlineRecovery",
    description:
      "Enable LLM-driven inline recovery for individual verification command failures (true/false)",
    group: "Recovery",
    type: "text",
  },
  {
    key: "WORKER_VERIFY_LLM_INLINE_RECOVERY_ATTEMPTS",
    label: "Worker_Verify_LLMInlineRecoveryAttempts",
    description: "Max LLM inline recovery attempts per failed verification command",
    group: "Recovery",
    type: "number",
  },
  {
    key: "REPO_MODE",
    label: "Repo_Mode",
    description: "github, local-git, or direct mode",
    group: "Repo",
    type: "select",
    options: REPO_MODE_OPTIONS,
  },
  {
    key: "REPO_URL",
    label: "Repo_URL",
    description: "Remote repository URL for git mode",
    group: "Repo",
    type: "text",
  },
  {
    key: "LOCAL_REPO_PATH",
    label: "Local_Repo_Path",
    description: "Path for local mode",
    group: "Repo",
    type: "text",
  },
  {
    key: "LOCAL_WORKTREE_ROOT",
    label: "Worktree_Root",
    description: "Destination for worktrees",
    group: "Repo",
    type: "text",
  },
  {
    key: "BASE_BRANCH",
    label: "Base_Branch",
    description: "Target branch (main/master)",
    group: "Repo",
    type: "text",
  },
  {
    key: "LLM_EXECUTOR",
    label: "Default_LLM_Executor",
    description: "Default backend executor (used when agent override is inherit)",
    group: "Models",
    type: "select",
    options: LLM_EXECUTOR_OPTIONS,
  },
  {
    key: "WORKER_LLM_EXECUTOR",
    label: "Worker_Executor",
    description: "Worker executor override (inherit uses Default_LLM_Executor)",
    group: "Models",
    type: "select",
    options: AGENT_LLM_EXECUTOR_OPTIONS,
  },
  {
    key: "TESTER_LLM_EXECUTOR",
    label: "Tester_Executor",
    description: "Tester executor override (inherit uses Default_LLM_Executor)",
    group: "Models",
    type: "select",
    options: AGENT_LLM_EXECUTOR_OPTIONS,
  },
  {
    key: "DOCSER_LLM_EXECUTOR",
    label: "Docser_Executor",
    description: "Docser executor override (inherit uses Default_LLM_Executor)",
    group: "Models",
    type: "select",
    options: AGENT_LLM_EXECUTOR_OPTIONS,
  },
  {
    key: "JUDGE_LLM_EXECUTOR",
    label: "Judge_Executor",
    description: "Judge executor override (inherit uses Default_LLM_Executor)",
    group: "Models",
    type: "select",
    options: AGENT_LLM_EXECUTOR_OPTIONS,
  },
  {
    key: "PLANNER_LLM_EXECUTOR",
    label: "Planner_Executor",
    description: "Planner executor override (inherit uses Default_LLM_Executor)",
    group: "Models",
    type: "select",
    options: AGENT_LLM_EXECUTOR_OPTIONS,
  },
  {
    key: "OPENCODE_MODEL",
    label: "OpenCode_Model",
    description: "Default LLM model",
    group: "Models",
    type: "select",
    options: MODEL_OPTIONS,
  },
  {
    key: "OPENCODE_SMALL_MODEL",
    label: "OpenCode_SmallModel",
    description: "Small model for title/summary generation",
    group: "Models",
    type: "select",
    options: MODEL_OPTIONS,
  },
  {
    key: "OPENCODE_WAIT_ON_QUOTA",
    label: "OpenCode_WaitOnQuota",
    description: "Wait and retry while provider quota is exhausted",
    group: "Models",
    type: "boolean",
  },
  {
    key: "OPENCODE_QUOTA_RETRY_DELAY_MS",
    label: "OpenCode_QuotaDelayMs",
    description: "Fallback wait time (ms) between quota retries",
    group: "Models",
    type: "number",
  },
  {
    key: "OPENCODE_MAX_QUOTA_WAITS",
    label: "OpenCode_MaxQuotaWaits",
    description: "-1 for unlimited; otherwise max quota wait attempts",
    group: "Models",
    type: "number",
  },
  {
    key: "CODEX_MODEL",
    label: "Codex_Model",
    description: "Model for Codex executor",
    group: "Models",
    type: "select",
    options: CODEX_MODEL_OPTIONS,
  },
  {
    key: "CODEX_MAX_RETRIES",
    label: "Codex_MaxRetries",
    description: "Max retries for Codex executor",
    group: "Models",
    type: "number",
  },
  {
    key: "CODEX_RETRY_DELAY_MS",
    label: "Codex_RetryDelayMs",
    description: "Retry delay in ms for Codex executor",
    group: "Models",
    type: "number",
  },
  {
    key: "CLAUDE_CODE_PERMISSION_MODE",
    label: "ClaudeCode_Permission",
    description: "Permission mode when LLM_Executor=claude_code",
    group: "Models",
    type: "select",
    options: CLAUDE_PERMISSION_MODE_OPTIONS,
  },
  {
    key: "CLAUDE_CODE_MODEL",
    label: "ClaudeCode_Model",
    description: "Model for Claude Code executor",
    group: "Models",
    type: "select",
    options: CLAUDE_CODE_MODEL_OPTIONS,
  },
  {
    key: "CLAUDE_CODE_MAX_TURNS",
    label: "ClaudeCode_MaxTurns",
    description: "Max turns for claude -p (0 uses CLI default)",
    group: "Models",
    type: "number",
  },
  {
    key: "CLAUDE_CODE_ALLOWED_TOOLS",
    label: "ClaudeCode_AllowedTools",
    description: "Comma-separated allowed tools when LLM_Executor=claude_code",
    group: "Models",
    type: "text",
  },
  {
    key: "CLAUDE_CODE_DISALLOWED_TOOLS",
    label: "ClaudeCode_DisallowedTools",
    description: "Comma-separated disallowed tools when LLM_Executor=claude_code",
    group: "Models",
    type: "text",
  },
  {
    key: "CLAUDE_CODE_APPEND_SYSTEM_PROMPT",
    label: "ClaudeCode_SystemPrompt",
    description: "Appended system prompt when LLM_Executor=claude_code",
    group: "Models",
    type: "text",
  },
  {
    key: "PLANNER_MODEL",
    label: "Planner_Model",
    description: "Model for planner",
    group: "Models",
    type: "select",
    options: MODEL_OPTIONS,
  },
  {
    key: "JUDGE_MODEL",
    label: "Judge_Model",
    description: "Model for judge",
    group: "Models",
    type: "select",
    options: MODEL_OPTIONS,
  },
  {
    key: "WORKER_MODEL",
    label: "Worker_Model",
    description: "Model for workers",
    group: "Models",
    type: "select",
    options: MODEL_OPTIONS,
  },
  {
    key: "TESTER_MODEL",
    label: "Tester_Model",
    description: "Model for testers",
    group: "Models",
    type: "select",
    options: MODEL_OPTIONS,
  },
  {
    key: "DOCSER_MODEL",
    label: "Docser_Model",
    description: "Model for docsers",
    group: "Models",
    type: "select",
    options: MODEL_OPTIONS,
  },
  {
    key: "PLANNER_USE_REMOTE",
    label: "Planner_Use_Remote",
    description: "Planner uses remote repo",
    group: "Planner",
    type: "boolean",
  },
  {
    key: "PLANNER_REPO_URL",
    label: "Planner_Repo_URL",
    description: "Remote repo URL for planner",
    group: "Planner",
    type: "text",
  },
  {
    key: "AUTO_REPLAN",
    label: "Auto_Replan",
    description: "Enable automatic replanning",
    group: "Planner",
    type: "boolean",
  },
  {
    key: "REPLAN_REQUIREMENT_PATH",
    label: "Replan_Req_Path",
    description: "Path for replan requirements",
    group: "Planner",
    type: "text",
  },
  {
    key: "REPLAN_INTERVAL_MS",
    label: "Replan_Interval",
    description: "MS between replans",
    group: "Planner",
    type: "number",
  },
  {
    key: "REPLAN_COMMAND",
    label: "Replan_Command",
    description: "Command to exec planner",
    group: "Planner",
    type: "text",
  },
  {
    key: "REPLAN_WORKDIR",
    label: "Replan_Workdir",
    description: "Workdir for replan cmd (optional; defaults to repo root)",
    group: "Planner",
    type: "text",
  },
  {
    key: "REPLAN_REPO_URL",
    label: "Replan_Repo_URL",
    description: "Diff comparison repo",
    group: "Planner",
    type: "text",
  },
  // GitHub-related
  {
    key: "GITHUB_AUTH_MODE",
    label: "GitHub_Auth_Mode",
    description: "Auth mode for GitHub access (gh or token)",
    group: "GitHub",
    type: "select",
    options: GITHUB_AUTH_MODE_OPTIONS,
  },
  {
    key: "GITHUB_TOKEN",
    label: "GitHub_Token",
    description: "API token for GitHub (required in token mode)",
    group: "GitHub",
    type: "text",
  },
  {
    key: "GITHUB_OWNER",
    label: "GitHub_Owner",
    description: "Owner for GitHub repository",
    group: "GitHub",
    type: "text",
  },
  {
    key: "GITHUB_REPO",
    label: "GitHub_Repo",
    description: "Repository name for GitHub",
    group: "GitHub",
    type: "text",
  },
  // API keys
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic_Key",
    description: "API key for Claude models",
    group: "API_Keys",
    type: "text",
  },
  {
    key: "GEMINI_API_KEY",
    label: "Gemini_Key",
    description: "API key for Google Gemini",
    group: "API_Keys",
    type: "text",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI_Key",
    description: "API key for GPT models",
    group: "API_Keys",
    type: "text",
  },
  {
    key: "XAI_API_KEY",
    label: "xAI_Key",
    description: "API key for Grok models",
    group: "API_Keys",
    type: "text",
  },
  {
    key: "DEEPSEEK_API_KEY",
    label: "DeepSeek_Key",
    description: "API key for DeepSeek models",
    group: "API_Keys",
    type: "text",
  },
];

export const GROUP_DISPLAY_ORDER = [
  "Models",
  "API_Keys",
  "GitHub",
  "Repo",
  "Runtime",
  "Workers",
  "Recovery",
  "Planner",
  "Limits",
] as const;

export const FIELD_DISPLAY_ORDER_BY_GROUP: Record<string, readonly string[]> = {
  Models: [
    "LLM_EXECUTOR",
    "WORKER_LLM_EXECUTOR",
    "TESTER_LLM_EXECUTOR",
    "DOCSER_LLM_EXECUTOR",
    "JUDGE_LLM_EXECUTOR",
    "PLANNER_LLM_EXECUTOR",
    "OPENCODE_MODEL",
    "OPENCODE_SMALL_MODEL",
    "OPENCODE_WAIT_ON_QUOTA",
    "OPENCODE_QUOTA_RETRY_DELAY_MS",
    "OPENCODE_MAX_QUOTA_WAITS",
    "CODEX_MODEL",
    "CODEX_MAX_RETRIES",
    "CODEX_RETRY_DELAY_MS",
    "CLAUDE_CODE_PERMISSION_MODE",
    "CLAUDE_CODE_MODEL",
    "CLAUDE_CODE_MAX_TURNS",
    "CLAUDE_CODE_ALLOWED_TOOLS",
    "CLAUDE_CODE_DISALLOWED_TOOLS",
    "CLAUDE_CODE_APPEND_SYSTEM_PROMPT",
    "WORKER_MODEL",
    "TESTER_MODEL",
    "DOCSER_MODEL",
    "JUDGE_MODEL",
    "PLANNER_MODEL",
  ],
  API_Keys: [
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_API_KEY",
  ],
  GitHub: ["GITHUB_AUTH_MODE", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"],
  Repo: ["REPO_MODE", "REPO_URL", "BASE_BRANCH", "LOCAL_REPO_PATH", "LOCAL_WORKTREE_ROOT"],
  Runtime: [
    "EXECUTION_ENVIRONMENT",
    "DISPATCHER_ENABLED",
    "JUDGE_ENABLED",
    "CYCLE_MANAGER_ENABLED",
  ],
  Workers: ["WORKER_COUNT", "TESTER_COUNT", "DOCSER_COUNT", "JUDGE_COUNT", "PLANNER_COUNT"],
  Recovery: [
    "WORKER_NO_CHANGE_RECOVERY_ATTEMPTS",
    "WORKER_POLICY_RECOVERY_ATTEMPTS",
    "WORKER_VERIFY_RECOVERY_ATTEMPTS",
    "BLOCKED_NEEDS_REWORK_IN_PLACE_RETRY_LIMIT",
    "WORKER_SETUP_IN_PROCESS_RECOVERY",
    "WORKER_VERIFY_LLM_INLINE_RECOVERY",
    "WORKER_VERIFY_LLM_INLINE_RECOVERY_ATTEMPTS",
  ],
  Planner: [
    "AUTO_REPLAN",
    "REPLAN_REQUIREMENT_PATH",
    "REPLAN_INTERVAL_MS",
    "REPLAN_COMMAND",
    "REPLAN_WORKDIR",
    "REPLAN_REPO_URL",
    "PLANNER_USE_REMOTE",
    "PLANNER_REPO_URL",
  ],
  Limits: ["MAX_CONCURRENT_WORKERS", "DAILY_TOKEN_LIMIT", "HOURLY_TOKEN_LIMIT", "TASK_TOKEN_LIMIT"],
};
