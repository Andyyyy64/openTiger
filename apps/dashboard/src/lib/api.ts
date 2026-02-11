import type { Task, Run, Agent, Artifact } from "@openTiger/core";

/**
 * Dashboard API Client
 * Wraps requests to @openTiger/api
 */

const API_BASE_URL = "/api";

export async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Unknown error" }));
    const message =
      (typeof error?.message === "string" && error.message) ||
      (typeof error?.error === "string" && error.error) ||
      `API error: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

export interface PlanSummary {
  totalTasks?: number;
  totalEstimatedMinutes?: number;
  warnings?: string[];
}

export interface PlanRequirement {
  goal?: string;
  acceptanceCriteriaCount?: number;
  allowedPaths?: string[];
  notes?: string;
}

export interface PlanTaskSnapshot {
  id: string;
  title: string;
  status: string;
  riskLevel: string;
  role: string;
  priority: number;
  createdAt: string;
  dependencies?: string[];
}

export interface PlanSnapshot {
  id: string;
  createdAt: string;
  agentId: string | null;
  requirement: PlanRequirement;
  summary: PlanSummary;
  taskIds: string[];
  tasks: PlanTaskSnapshot[];
}

export interface JudgementPayload {
  taskId?: string;
  runId?: string;
  prNumber?: number;
  prUrl?: string;
  verdict?: string;
  autoMerge?: boolean;
  riskLevel?: string;
  confidence?: number;
  reasons?: string[];
  suggestions?: string[];
  summary?: {
    ci?: { pass?: boolean; status?: string; details?: Array<{ name: string; status: string }> };
    policy?: {
      pass?: boolean;
      violations?: Array<{ severity: string; message: string; file?: string }>;
    };
    llm?: {
      pass?: boolean;
      confidence?: number;
      codeIssues?: Array<{ severity: string; category: string; message: string }>;
    };
  };
  actions?: { commented?: boolean; approved?: boolean; merged?: boolean };
  mergeResult?: { success?: boolean; error?: string };
  dryRun?: boolean;
  mode?: string;
  baseRepoPath?: string;
  worktreePath?: string;
  branchName?: string;
  baseBranch?: string;
}

export interface JudgementEvent {
  id: string;
  createdAt: string;
  agentId: string | null;
  taskId: string;
  payload: JudgementPayload | null;
}

export interface JudgementDiffResponse {
  diff: string;
  truncated: boolean;
  source: string;
}

export interface AgentLogResponse {
  log: string;
  sizeBytes: number;
  updatedAt: string;
  path: string;
}

export interface AllLogEntry {
  timestamp: string;
  explicitTimestamp: boolean;
  source: string;
  lineNo: number;
  line: string;
}

export interface AllLogsResponse {
  entries: AllLogEntry[];
  total: number;
  returned: number;
  truncated: boolean;
  sourceCount: number;
  generatedAt: string;
}

export interface ClearLogsResponse {
  cleared: boolean;
  removed: number;
  failed: number;
  logDir: string;
}

export interface ConfigResponse {
  config: Record<string, string>;
}

export interface SystemProcess {
  name: string;
  label: string;
  description: string;
  group: string;
  kind: "service" | "worker" | "planner" | "database" | "command";
  supportsStop: boolean;
  status: "idle" | "running" | "completed" | "failed" | "stopped";
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  logPath?: string;
  message?: string;
  lastCommand?: string;
}

export interface SystemPreflightSummary {
  preflight: {
    github: {
      enabled: boolean;
      openIssueCount: number;
      openPrCount: number;
      issueTaskBacklogCount: number;
      generatedTaskCount: number;
      generatedTaskIds: string[];
      skippedIssueNumbers: number[];
      warnings: string[];
    };
    local: {
      queuedTaskCount: number;
      runningTaskCount: number;
      failedTaskCount: number;
      blockedTaskCount: number;
      pendingJudgeTaskCount: number;
    };
  };
  recommendations: {
    startPlanner: boolean;
    startDispatcher: boolean;
    startJudge: boolean;
    plannerCount: number;
    judgeCount: number;
    startCycleManager: boolean;
    workerCount: number;
    testerCount: number;
    docserCount: number;
    reasons: string[];
  };
}

export interface RequirementResponse {
  path: string;
  content: string;
}

export interface RequirementSyncResponse {
  requirementPath: string;
  canonicalPath: string;
  committed: boolean;
  commitReason?: string;
}

export interface GitHubRepoInfo {
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
  created: boolean;
}

export interface GitHubRepoListItem {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
}

export interface ClaudeAuthStatus {
  available: boolean;
  authenticated: boolean;
  executionEnvironment?: "host" | "sandbox";
  checkedAt: string;
  message?: string;
}

export interface HostNeofetchInfo {
  available: boolean;
  checkedAt: string;
  output?: string;
  message?: string;
}

export interface TaskRetryInfo {
  autoRetry: boolean;
  reason:
    | "cooldown_pending"
    | "retry_due"
    | "retry_exhausted"
    | "non_retryable_failure"
    | "awaiting_judge"
    | "quota_wait"
    | "needs_rework"
    | "unknown";
  retryAt: string | null;
  retryInSeconds: number | null;
  cooldownMs: number | null;
  retryCount: number;
  retryLimit: number;
  failureCategory?: "env" | "setup" | "policy" | "test" | "flaky" | "model" | "model_loop";
}

export type TaskView = Task & { retry?: TaskRetryInfo | null };

// Task-related
export const tasksApi = {
  list: () => fetchApi<{ tasks: TaskView[] }>("/tasks").then((res) => res.tasks),
  get: (id: string) => fetchApi<{ task: TaskView }>(`/tasks/${id}`).then((res) => res.task),
};

// Run history
export const runsApi = {
  list: (taskId?: string) =>
    fetchApi<{ runs: Run[] }>(`/runs${taskId ? `?taskId=${taskId}` : ""}`).then((res) => res.runs),
  get: (id: string) =>
    fetchApi<{ run: Run & { logContent?: string | null }; artifacts: Artifact[] }>(`/runs/${id}`),
  stats: () => fetchApi<{ dailyTokens: number; tokenLimit: number }>("/runs/stats"),
};

// System state
export const systemApi = {
  health: () => fetchApi<{ status: string; timestamp: string }>("/health"),
  processes: () =>
    fetchApi<{ processes: SystemProcess[] }>("/system/processes").then((res) => res.processes),
  startProcess: (name: string, payload?: { requirementPath?: string; content?: string }) =>
    fetchApi<{ process: SystemProcess }>(`/system/processes/${name}/start`, {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }).then((res) => res.process),
  stopProcess: (name: string) =>
    fetchApi<{ process: SystemProcess }>(`/system/processes/${name}/stop`, {
      method: "POST",
    }).then((res) => res.process),
  requirement: (path?: string) =>
    fetchApi<RequirementResponse>(
      `/system/requirements${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  syncRequirement: (payload: { path?: string; content: string }) =>
    fetchApi<RequirementSyncResponse>("/system/requirements", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  cleanup: () => fetchApi<{ cleaned: boolean }>("/system/cleanup", { method: "POST" }),
  stopAllProcesses: () =>
    fetchApi<{ stopped: string[]; skipped: string[]; message: string }>(
      "/system/processes/stop-all",
      { method: "POST" },
    ),
  createGithubRepo: (payload: {
    owner?: string;
    repo?: string;
    description?: string;
    private?: boolean;
  }) =>
    fetchApi<{ repo: GitHubRepoInfo }>("/system/github/repo", {
      method: "POST",
      body: JSON.stringify(payload),
    }).then((res) => res.repo),
  listGithubRepos: (params?: { owner?: string }) => {
    const query = new URLSearchParams();
    if (params?.owner) {
      query.set("owner", params.owner);
    }
    const suffix = query.toString();
    return fetchApi<{ repos: GitHubRepoListItem[] }>(
      `/system/github/repos${suffix ? `?${suffix}` : ""}`,
    ).then((res) => res.repos);
  },
  preflight: (payload?: { content?: string; autoCreateIssueTasks?: boolean }) =>
    fetchApi<SystemPreflightSummary>("/system/preflight", {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
    }),
  claudeAuthStatus: (environment?: "host" | "sandbox") =>
    fetchApi<ClaudeAuthStatus>(
      `/system/claude/auth${environment ? `?environment=${encodeURIComponent(environment)}` : ""}`,
    ),
  neofetch: () => fetchApi<HostNeofetchInfo>("/system/host/neofetch"),
};

// Agent-related
export const agentsApi = {
  list: () => fetchApi<{ agents: Agent[] }>("/agents").then((res) => res.agents),
  get: (id: string) => fetchApi<{ agent: Agent }>(`/agents/${id}`).then((res) => res.agent),
};

// Planner-related
export const plansApi = {
  list: (limit?: number) =>
    fetchApi<{ plans: PlanSnapshot[] }>(`/plans${limit ? `?limit=${limit}` : ""}`).then(
      (res) => res.plans,
    ),
};

// Judge-related
export const judgementsApi = {
  list: (params?: { taskId?: string; runId?: string; verdict?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.taskId) query.set("taskId", params.taskId);
    if (params?.runId) query.set("runId", params.runId);
    if (params?.verdict) query.set("verdict", params.verdict);
    if (params?.limit) query.set("limit", String(params.limit));
    const suffix = query.toString();
    return fetchApi<{ judgements: JudgementEvent[] }>(
      `/judgements${suffix ? `?${suffix}` : ""}`,
    ).then((res) => res.judgements);
  },
  diff: (id: string, limit?: number) => {
    const query = new URLSearchParams();
    if (limit) query.set("limit", String(limit));
    const suffix = query.toString();
    return fetchApi<JudgementDiffResponse>(`/judgements/${id}/diff${suffix ? `?${suffix}` : ""}`);
  },
};

// Log-related
export const logsApi = {
  agent: (agentId: string, lines?: number) => {
    const query = new URLSearchParams();
    if (lines) query.set("lines", String(lines));
    const suffix = query.toString();
    return fetchApi<AgentLogResponse>(`/logs/agents/${agentId}${suffix ? `?${suffix}` : ""}`);
  },
  cycleManager: (lines?: number) => {
    const query = new URLSearchParams();
    if (lines) query.set("lines", String(lines));
    const suffix = query.toString();
    return fetchApi<AgentLogResponse>(`/logs/cycle-manager${suffix ? `?${suffix}` : ""}`);
  },
  all: (params?: { sinceMinutes?: number; limit?: number; source?: string }) => {
    const query = new URLSearchParams();
    if (params?.sinceMinutes !== undefined) query.set("sinceMinutes", String(params.sinceMinutes));
    if (params?.limit !== undefined) query.set("limit", String(params.limit));
    if (params?.source) query.set("source", params.source);
    const suffix = query.toString();
    return fetchApi<AllLogsResponse>(`/logs/all${suffix ? `?${suffix}` : ""}`);
  },
  clear: () => fetchApi<ClearLogsResponse>("/logs/clear", { method: "POST" }),
};

// Config-related
export const configApi = {
  get: () => fetchApi<ConfigResponse>("/config"),
  update: (updates: Record<string, string>) =>
    fetchApi<{ config: Record<string, string>; requiresRestart: boolean; warnings?: string[] }>(
      "/config",
      {
        method: "PATCH",
        body: JSON.stringify({ updates }),
      },
    ),
};
