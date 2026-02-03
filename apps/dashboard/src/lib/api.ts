import type { Task, Run, Agent, CreateTaskInput, Artifact } from '@sebastian-code/core';

/**
 * Dashboard API Client
 * @sebastian-code/api へのリクエストをラップする
 */

const API_BASE_URL = '/api';

export async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || `API error: ${response.status}`);
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
    policy?: { pass?: boolean; violations?: Array<{ severity: string; message: string; file?: string }> };
    llm?: { pass?: boolean; confidence?: number; codeIssues?: Array<{ severity: string; category: string; message: string }> };
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

export interface AgentLogResponse {
  log: string;
  sizeBytes: number;
  updatedAt: string;
  path: string;
}

export interface ConfigResponse {
  config: Record<string, string>;
  envPath: string;
}

// タスク関連
export const tasksApi = {
  list: () => fetchApi<{ tasks: Task[] }>('/tasks').then(res => res.tasks),
  get: (id: string) => fetchApi<{ task: Task }>(`/tasks/${id}`).then(res => res.task),
  create: (input: CreateTaskInput) => fetchApi<{ task: Task }>('/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then(res => res.task),
};

// 実行履歴関連
export const runsApi = {
  list: (taskId?: string) => 
    fetchApi<{ runs: Run[] }>(`/runs${taskId ? `?taskId=${taskId}` : ''}`).then(res => res.runs),
  get: (id: string) => fetchApi<{ run: Run, artifacts: Artifact[] }>(`/runs/${id}`),
  stats: () => fetchApi<{ dailyTokens: number, tokenLimit: number }>('/runs/stats'),
};

// システム状態
export const systemApi = {
  health: () => fetchApi<{ status: string, timestamp: string }>('/health'),
};

// エージェント関連
export const agentsApi = {
  list: () => fetchApi<{ agents: Agent[] }>('/agents').then(res => res.agents),
  get: (id: string) => fetchApi<{ agent: Agent }>(`/agents/${id}`).then(res => res.agent),
};

// Planner関連
export const plansApi = {
  list: (limit?: number) =>
    fetchApi<{ plans: PlanSnapshot[] }>(`/plans${limit ? `?limit=${limit}` : ''}`).then(res => res.plans),
};

// Judge関連
export const judgementsApi = {
  list: (params?: { taskId?: string; runId?: string; verdict?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.taskId) query.set('taskId', params.taskId);
    if (params?.runId) query.set('runId', params.runId);
    if (params?.verdict) query.set('verdict', params.verdict);
    if (params?.limit) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return fetchApi<{ judgements: JudgementEvent[] }>(`/judgements${suffix ? `?${suffix}` : ''}`)
      .then(res => res.judgements);
  },
};

// ログ関連
export const logsApi = {
  agent: (agentId: string, lines?: number) => {
    const query = new URLSearchParams();
    if (lines) query.set('lines', String(lines));
    const suffix = query.toString();
    return fetchApi<AgentLogResponse>(`/logs/agents/${agentId}${suffix ? `?${suffix}` : ''}`);
  },
};

// 設定関連
export const configApi = {
  get: () => fetchApi<ConfigResponse>('/config'),
  update: (updates: Record<string, string>) =>
    fetchApi<{ config: Record<string, string>; requiresRestart: boolean }>('/config', {
      method: 'PATCH',
      body: JSON.stringify({ updates }),
    }),
};
