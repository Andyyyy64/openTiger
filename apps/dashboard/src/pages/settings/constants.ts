// 設定フォームの定義と表示順を集約する
export const REPO_MODE_OPTIONS = ['git', 'local'] as const;
// OpenCodeの対応モデル一覧
// Reference: https://opencode.ai/docs/providers
export const MODEL_OPTIONS = [
  // Anthropic系
  'anthropic/claude-sonnet-4-20250514',
  'anthropic/claude-opus-4-20250514',
  'anthropic/claude-3.5-sonnet',
  // Google系
  'google/gemini-3-pro-preview',
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-pro-preview-05-06',
  'google/gemini-2.5-flash-preview-04-17',
  // OpenAI系
  'openai/gpt-5.1',
  'openai/gpt-4.1',
  'openai/gpt-4o',
  'openai/o3',
  'openai/o4-mini',
  // xAI系
  'xai/grok-3',
  'xai/grok-3-mini',
  // DeepSeek系
  'deepseek/deepseek-chat',
  'deepseek/deepseek-reasoner',
] as const;

export type SettingField = {
  key: string;
  label: string;
  description: string;
  group: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  options?: readonly string[];
};

export const SETTINGS: SettingField[] = [
  {
    key: 'MAX_CONCURRENT_WORKERS',
    label: 'Parallel_Workers',
    description: 'Max concurrent worker processes (-1 for unlimited)',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'DAILY_TOKEN_LIMIT',
    label: 'Daily_Token_Max',
    description: 'Max tokens per day (-1 for unlimited)',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'HOURLY_TOKEN_LIMIT',
    label: 'Hourly_Token_Max',
    description: 'Max tokens per hour (-1 for unlimited)',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'TASK_TOKEN_LIMIT',
    label: 'Task_Token_Max',
    description: 'Max tokens per single task (-1 for unlimited)',
    group: 'Limits',
    type: 'number',
  },
  {
    key: 'DISPATCHER_ENABLED',
    label: 'Enable_Dispatcher',
    description: 'Include dispatcher in boot sequence',
    group: 'Runtime',
    type: 'boolean',
  },
  {
    key: 'JUDGE_ENABLED',
    label: 'Enable_Judge',
    description: 'Include judge in boot sequence',
    group: 'Runtime',
    type: 'boolean',
  },
  {
    key: 'CYCLE_MANAGER_ENABLED',
    label: 'Enable_CycleMgr',
    description: 'Include cycle manager',
    group: 'Runtime',
    type: 'boolean',
  },
  {
    key: 'WORKER_COUNT',
    label: 'Worker_Count',
    description: 'Number of worker nodes',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'TESTER_COUNT',
    label: 'Tester_Count',
    description: 'Number of tester nodes',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'DOCSER_COUNT',
    label: 'Docser_Count',
    description: 'Number of docser nodes',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'JUDGE_COUNT',
    label: 'Judge_Count',
    description: 'Number of judge nodes',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'PLANNER_COUNT',
    label: 'Planner_Count',
    description: 'Number of planner nodes',
    group: 'Workers',
    type: 'number',
  },
  {
    key: 'REPO_MODE',
    label: 'Repo_Mode',
    description: 'git or local mode',
    group: 'Repo',
    type: 'select',
    options: REPO_MODE_OPTIONS,
  },
  {
    key: 'REPO_URL',
    label: 'Repo_URL',
    description: 'Remote repository URL for git mode',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'LOCAL_REPO_PATH',
    label: 'Local_Repo_Path',
    description: 'Path for local mode',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'LOCAL_WORKTREE_ROOT',
    label: 'Worktree_Root',
    description: 'Destination for worktrees',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'BASE_BRANCH',
    label: 'Base_Branch',
    description: 'Target branch (main/master)',
    group: 'Repo',
    type: 'text',
  },
  {
    key: 'OPENCODE_MODEL',
    label: 'OpenCode_Model',
    description: 'Default LLM model',
    group: 'Models',
    type: 'select',
    options: MODEL_OPTIONS,
  },
  {
    key: 'OPENCODE_WAIT_ON_QUOTA',
    label: 'OpenCode_WaitOnQuota',
    description: 'Wait and retry while provider quota is exhausted',
    group: 'Models',
    type: 'boolean',
  },
  {
    key: 'OPENCODE_QUOTA_RETRY_DELAY_MS',
    label: 'OpenCode_QuotaDelayMs',
    description: 'Fallback wait time (ms) between quota retries',
    group: 'Models',
    type: 'number',
  },
  {
    key: 'OPENCODE_MAX_QUOTA_WAITS',
    label: 'OpenCode_MaxQuotaWaits',
    description: '-1 for unlimited; otherwise max quota wait attempts',
    group: 'Models',
    type: 'number',
  },
  {
    key: 'PLANNER_MODEL',
    label: 'Planner_Model',
    description: 'Model for planner',
    group: 'Models',
    type: 'select',
    options: MODEL_OPTIONS,
  },
  {
    key: 'JUDGE_MODEL',
    label: 'Judge_Model',
    description: 'Model for judge',
    group: 'Models',
    type: 'select',
    options: MODEL_OPTIONS,
  },
  {
    key: 'WORKER_MODEL',
    label: 'Worker_Model',
    description: 'Model for workers',
    group: 'Models',
    type: 'select',
    options: MODEL_OPTIONS,
  },
  {
    key: 'PLANNER_USE_REMOTE',
    label: 'Planner_Use_Remote',
    description: 'Planner uses remote repo',
    group: 'Planner',
    type: 'boolean',
  },
  {
    key: 'PLANNER_REPO_URL',
    label: 'Planner_Repo_URL',
    description: 'Remote repo URL for planner',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'AUTO_REPLAN',
    label: 'Auto_Replan',
    description: 'Enable automatic replanning',
    group: 'Planner',
    type: 'boolean',
  },
  {
    key: 'REPLAN_REQUIREMENT_PATH',
    label: 'Replan_Req_Path',
    description: 'Path for replan requirements',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'REPLAN_INTERVAL_MS',
    label: 'Replan_Interval',
    description: 'MS between replans',
    group: 'Planner',
    type: 'number',
  },
  {
    key: 'REPLAN_COMMAND',
    label: 'Replan_Command',
    description: 'Command to exec planner',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'REPLAN_WORKDIR',
    label: 'Replan_Workdir',
    description: 'Workdir for replan cmd',
    group: 'Planner',
    type: 'text',
  },
  {
    key: 'REPLAN_REPO_URL',
    label: 'Replan_Repo_URL',
    description: 'Diff comparison repo',
    group: 'Planner',
    type: 'text',
  },
  // GitHub関連
  {
    key: 'GITHUB_TOKEN',
    label: 'GitHub_Token',
    description: 'API token for GitHub',
    group: 'GitHub',
    type: 'text',
  },
  {
    key: 'GITHUB_OWNER',
    label: 'GitHub_Owner',
    description: 'Owner for GitHub repository',
    group: 'GitHub',
    type: 'text',
  },
  {
    key: 'GITHUB_REPO',
    label: 'GitHub_Repo',
    description: 'Repository name for GitHub',
    group: 'GitHub',
    type: 'text',
  },
  // APIキー
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic_Key',
    description: 'API key for Claude models',
    group: 'API_Keys',
    type: 'text',
  },
  {
    key: 'GEMINI_API_KEY',
    label: 'Gemini_Key',
    description: 'API key for Google Gemini',
    group: 'API_Keys',
    type: 'text',
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'OpenAI_Key',
    description: 'API key for GPT models',
    group: 'API_Keys',
    type: 'text',
  },
  {
    key: 'XAI_API_KEY',
    label: 'xAI_Key',
    description: 'API key for Grok models',
    group: 'API_Keys',
    type: 'text',
  },
  {
    key: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek_Key',
    description: 'API key for DeepSeek models',
    group: 'API_Keys',
    type: 'text',
  },
];

export const GROUP_DISPLAY_ORDER = [
  'Models',
  'API_Keys',
  'GitHub',
  'Repo',
  'Runtime',
  'Workers',
  'Planner',
  'Limits',
] as const;

export const FIELD_DISPLAY_ORDER_BY_GROUP: Record<string, readonly string[]> = {
  Models: [
    'OPENCODE_MODEL',
    'WORKER_MODEL',
    'JUDGE_MODEL',
    'PLANNER_MODEL',
    'OPENCODE_WAIT_ON_QUOTA',
    'OPENCODE_QUOTA_RETRY_DELAY_MS',
    'OPENCODE_MAX_QUOTA_WAITS',
  ],
  API_Keys: [
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'XAI_API_KEY',
  ],
  GitHub: [
    'GITHUB_TOKEN',
    'GITHUB_OWNER',
    'GITHUB_REPO',
  ],
  Repo: [
    'REPO_MODE',
    'REPO_URL',
    'BASE_BRANCH',
    'LOCAL_REPO_PATH',
    'LOCAL_WORKTREE_ROOT',
  ],
  Runtime: [
    'DISPATCHER_ENABLED',
    'JUDGE_ENABLED',
    'CYCLE_MANAGER_ENABLED',
  ],
  Workers: [
    'WORKER_COUNT',
    'TESTER_COUNT',
    'DOCSER_COUNT',
    'JUDGE_COUNT',
    'PLANNER_COUNT',
  ],
  Planner: [
    'AUTO_REPLAN',
    'REPLAN_REQUIREMENT_PATH',
    'REPLAN_INTERVAL_MS',
    'REPLAN_COMMAND',
    'REPLAN_WORKDIR',
    'REPLAN_REPO_URL',
    'PLANNER_USE_REMOTE',
    'PLANNER_REPO_URL',
  ],
  Limits: [
    'MAX_CONCURRENT_WORKERS',
    'DAILY_TOKEN_LIMIT',
    'HOURLY_TOKEN_LIMIT',
    'TASK_TOKEN_LIMIT',
  ],
};
