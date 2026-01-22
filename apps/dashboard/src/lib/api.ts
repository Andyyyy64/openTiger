import type { Task, Run, Agent, CreateTaskInput, Artifact } from '@h1ve/core';

/**
 * Dashboard API Client
 * @h1ve/api へのリクエストをラップする
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
};

// エージェント関連
export const agentsApi = {
  list: () => fetchApi<{ agents: Agent[] }>('/agents').then(res => res.agents),
};
