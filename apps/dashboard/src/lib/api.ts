import type { Task, Run, Agent } from '@h1ve/core';

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
  list: () => fetchApi<Task[]>('/tasks'),
  get: (id: string) => fetchApi<Task>(`/tasks/${id}`),
};

// 実行履歴関連
export const runsApi = {
  list: () => fetchApi<Run[]>('/runs'),
  get: (id: string) => fetchApi<Run>(`/runs/${id}`),
};

// エージェント関連
export const agentsApi = {
  list: () => fetchApi<Agent[]>('/agents'),
};
