import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { runsApi, tasksApi } from '../lib/api';
import { Link } from 'react-router-dom';
import type { Run } from '@sebastian-code/core';
import type { TaskRetryInfo, TaskView } from '../lib/api';

export const RunsPage: React.FC = () => {
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { data: runs, isLoading, error } = useQuery({
    queryKey: ['runs'],
    queryFn: () => runsApi.list(),
  });
  const { data: tasks } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => tasksApi.list(),
  });
  const taskById = React.useMemo(() => {
    const map = new Map<string, TaskView>();
    for (const task of tasks ?? []) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);
  const groupedRuns = React.useMemo(() => groupRunsByTask(runs ?? []), [runs]);

  return (
    <div className="p-6 text-[var(--color-term-fg)]">
      <h1 className="text-xl font-bold mb-8 uppercase tracking-widest text-[var(--color-term-green)]">
        &gt; Execution_Values (Runs)
      </h1>

      <div className="border border-[var(--color-term-border)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left bg-transparent">
            <thead className="bg-[var(--color-term-border)]/10 text-xs text-zinc-500 uppercase font-mono">
              <tr>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Run ID / Agent</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Status</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Duration</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Started</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Retry</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]"></th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm divide-y divide-[var(--color-term-border)]">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-zinc-500 animate-pulse">&gt; Loading data...</td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-red-500">&gt; ERROR LOADING DATA</td>
                </tr>
              ) : runs?.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-zinc-500">&gt; No records found</td>
                </tr>
              ) : (
                groupedRuns.map((group) => {
                  const task = taskById.get(group.taskId);
                  const latestRun = group.runs[0];
                  return (
                    <React.Fragment key={group.taskId}>
                      <tr className="bg-[var(--color-term-border)]/5">
                        <td colSpan={6} className="px-4 py-2 border-y border-[var(--color-term-border)]">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <span className="text-xs text-zinc-300">
                                task:{' '}
                                <Link to={`/tasks/${group.taskId}`} className="text-[var(--color-term-green)] hover:underline">
                                  {group.taskId.slice(0, 8)}
                                </Link>
                              </span>
                              {task?.title ? (
                                <div className="text-xs text-zinc-500 truncate">{task.title}</div>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-3 text-xs text-zinc-500 shrink-0">
                              <span>{group.runs.length} runs</span>
                              <span>latest: {new Date(latestRun.startedAt).toLocaleString()}</span>
                              <span>retry: {formatRetryStatus(task?.retry, now)}</span>
                            </div>
                          </div>
                        </td>
                      </tr>
                      {group.runs.map((run) => (
                        <tr key={run.id} className="hover:bg-[var(--color-term-green)]/5 transition-colors group">
                          <td className="px-4 py-2 align-top">
                            <div className="flex flex-col">
                              <span className="text-[var(--color-term-fg)]">{run.id.slice(0, 8)}</span>
                              <span className="text-xs text-zinc-500">@{run.agentId}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2 align-top">
                            <span className={`text-xs uppercase ${getStatusColor(run.status)}`}>
                              [{run.status}]
                            </span>
                          </td>
                          <td className="px-4 py-2 align-top text-zinc-500 text-xs">
                            {run.finishedAt ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : '--'}
                          </td>
                          <td className="px-4 py-2 align-top text-zinc-600 text-xs">
                            {new Date(run.startedAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-2 align-top text-zinc-400 text-xs">
                            {formatRetryStatus(taskById.get(run.taskId)?.retry, now)}
                          </td>
                          <td className="px-4 py-2 text-right align-top">
                            <Link to={`/runs/${run.id}`} className="text-[var(--color-term-green)] hover:underline text-xs opacity-50 group-hover:opacity-100">
                              OPEN &gt;
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })
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
    case 'success': return 'text-[var(--color-term-green)]';
    case 'failed': return 'text-red-500';
    case 'running': return 'text-blue-400 animate-pulse';
    default: return 'text-zinc-500';
  }
};

function formatRetryStatus(retry: TaskRetryInfo | null | undefined, nowMs: number): string {
  if (!retry) {
    return '--';
  }

  if (!retry.autoRetry) {
    switch (retry.reason) {
      case 'needs_human':
        return 'needs_human';
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

function groupRunsByTask(runs: Run[]): Array<{ taskId: string; runs: Run[] }> {
  const groups = new Map<string, Run[]>();

  for (const run of runs) {
    const list = groups.get(run.taskId);
    if (list) {
      list.push(run);
    } else {
      groups.set(run.taskId, [run]);
    }
  }

  const sortedGroups = Array.from(groups.entries()).map(([taskId, grouped]) => {
    grouped.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return { taskId, runs: grouped };
  });

  sortedGroups.sort(
    (a, b) =>
      new Date(b.runs[0]?.startedAt ?? 0).getTime() -
      new Date(a.runs[0]?.startedAt ?? 0).getTime()
  );

  return sortedGroups;
}
