import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { tasksApi } from '../lib/api';
import type { TaskRetryInfo, TaskView } from '../lib/api';

export const TasksPage: React.FC = () => {
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { data: tasks, isLoading, error } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => tasksApi.list(),
  });

  return (
    <div className="p-6 text-[var(--color-term-fg)]">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-[var(--color-term-green)]">
          &gt; Task_Scheduler
        </h1>
        <Link to="/tasks/new" className="border border-[var(--color-term-green)] text-[var(--color-term-green)] px-4 py-2 text-sm uppercase hover:bg-[var(--color-term-green)] hover:text-black transition-colors">
          [+ New Task]
        </Link>
      </div>

      <div className="border border-[var(--color-term-border)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left bg-transparent">
            <thead className="bg-[var(--color-term-border)]/10 text-xs text-zinc-500 uppercase font-mono">
              <tr>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Title</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Status</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Priority</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Risk</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Deps</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Retry</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Created</th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm divide-y divide-[var(--color-term-border)]">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-zinc-500 animate-pulse">&gt; Loading tasks...</td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-red-500">&gt; ERROR LOADING TASKS</td>
                </tr>
              ) : tasks?.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-zinc-500">&gt; No tasks found</td>
                </tr>
              ) : (
                tasks?.map((task: TaskView) => (
                  <tr key={task.id} className="hover:bg-[var(--color-term-green)]/5 transition-colors group">
                    <td className="px-4 py-2 align-top">
                      <Link to={`/tasks/${task.id}`} className="font-bold text-[var(--color-term-fg)] hover:text-[var(--color-term-green)] block">
                        {task.title}
                      </Link>
                      <div className="text-xs text-zinc-600 truncate max-w-xs">{task.goal}</div>
                    </td>
                    <td className="px-4 py-2 align-top">
                      <span className={`text-xs uppercase px-1 ${getStatusColor(task.status)}`}>
                        {task.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-400">{task.priority}</td>
                    <td className="px-4 py-2 align-top">
                      <span className={`text-xs ${getRiskColor(task.riskLevel)}`}>
                        {task.riskLevel}
                      </span>
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-500">
                      {task.dependencies?.length ?? 0}
                    </td>
                    <td className="px-4 py-2 align-top text-xs text-zinc-400">
                      {formatRetryStatus(task.retry, now)}
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-600">
                      {new Date(task.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'done': return 'text-[var(--color-term-green)]';
    case 'running': return 'text-blue-400 animate-pulse';
    case 'failed': return 'text-red-500';
    case 'blocked': return 'text-yellow-500';
    default: return 'text-zinc-500';
  }
};

const getRiskColor = (risk: string) => {
  switch (risk) {
    case 'high': return 'text-red-500 font-bold';
    case 'medium': return 'text-yellow-500';
    default: return 'text-[var(--color-term-green)]';
  }
};

function formatRetryStatus(retry: TaskRetryInfo | null | undefined, nowMs: number): string {
  if (!retry) {
    return '--';
  }

  if (!retry.autoRetry) {
    switch (retry.reason) {
      case 'needs_human':
        return 'due';
      case 'retry_exhausted':
        return 'exhausted';
      case 'non_retryable_failure':
        return retry.failureCategory ? `no-retry(${retry.failureCategory})` : 'no-retry';
      default:
        return 'no-auto-retry';
    }
  }

  if (!retry.retryAt) {
    return 'pending';
  }

  const retryAtMs = new Date(retry.retryAt).getTime();
  const seconds = Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000));
  return seconds > 0 ? `${seconds}s` : 'due';
}
