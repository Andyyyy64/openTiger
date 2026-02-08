import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { runsApi, tasksApi } from '../lib/api';
import { Link, useNavigate } from 'react-router-dom';
import type { Run } from '@openTiger/core';
import type { TaskRetryInfo, TaskView } from '../lib/api';

export const RunsPage: React.FC = () => {
  const [now, setNow] = React.useState(Date.now());
  const navigate = useNavigate();

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
    <div className="p-6 text-term-fg">
      <h1 className="text-xl font-bold mb-8 uppercase tracking-widest text-term-tiger font-pixel">
        &gt; Execution_Values (Runs)
      </h1>

      <div className="space-y-6">
        {isLoading ? (
          <div className="text-center text-zinc-500 py-12 font-mono animate-pulse">&gt; Loading execution values...</div>
        ) : error ? (
          <div className="text-center text-red-500 py-12 font-mono">&gt; ERROR LOADING DATA</div>
        ) : groupedRuns.length === 0 ? (
          <div className="text-center text-zinc-500 py-12 font-mono">&gt; No records found</div>
        ) : (
          groupedRuns.map((group) => {
            // Task info
            const task = taskById.get(group.taskId);
            const latestRun = group.runs[0];
            const retryStatus = formatRetryStatus(task?.retry, now);
            const hasQuotaRetryInfo = Boolean(
              task?.retry?.autoRetry
              && task.retry.reason === 'quota_wait'
            );
            const latestRunQuotaFailure = Boolean(
              latestRun
              && latestRun.status === 'failed'
              && isQuotaErrorMessage(latestRun.errorMessage)
            );
            const isQuotaWaiting = hasQuotaRetryInfo || latestRunQuotaFailure;
            const effectiveRetryStatus = isQuotaWaiting
              ? formatQuotaWaitStatus(task?.retry, now)
              : retryStatus;
            const isRetryWaiting = isWaitingRetryStatus(effectiveRetryStatus);
            const retryLabel = effectiveRetryStatus !== 'pending' && effectiveRetryStatus !== 'due' && effectiveRetryStatus !== '--'
              ? (
                <span className={isRetryWaiting ? 'text-term-tiger font-bold animate-pulse' : 'text-term-tiger font-bold'}>
                  {effectiveRetryStatus}
                </span>
              )
              : (
                <span className={isRetryWaiting ? 'text-term-tiger animate-pulse' : 'text-zinc-500'}>
                  {effectiveRetryStatus}
                </span>
              );

            return (
              <section
                key={group.taskId}
                className={`border p-0 ${isQuotaWaiting ? 'border-yellow-500/70 shadow-[0_0_0_1px_rgba(250,204,21,0.2)]' : isRetryWaiting ? 'border-term-tiger/60 animate-pulse' : 'border-term-border'}`}
              >
                {/* Task Header */}
                <div className="bg-term-border/10 px-4 py-3 border-b border-term-border flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1 max-w-[70%]">
                    <div className="flex items-center gap-2 text-xs font-mono">
                      <span className="text-zinc-500">task:</span>
                      <Link to={`/tasks/${group.taskId}`} className="text-term-tiger hover:underline font-bold">
                        {group.taskId.slice(0, 8)}
                      </Link>
                    </div>
                    {task?.title && (
                      <div className="text-sm font-bold text-term-fg truncate">
                        {task.title}
                      </div>
                    )}
                  </div>

                  <div className="text-right text-xs font-mono text-zinc-500 space-y-1">
                    <div className="flex items-center justify-end gap-4">
                      <span>{group.runs.length} runs</span>
                      <span className="text-zinc-600">|</span>
                      <span>latest: {new Date(latestRun.startedAt).toLocaleString()}</span>
                    </div>
                    <div>
                      retry: {retryLabel}
                    </div>
                  </div>
                </div>

                {isQuotaWaiting && (
                  <div className="px-4 py-2 border-b border-yellow-500/40 bg-yellow-500/5 text-xs font-mono flex items-center justify-between gap-4">
                    <span className="text-yellow-400 font-bold uppercase tracking-wider">[WAITING_QUOTA]</span>
                    <span className="text-yellow-300">
                      {effectiveRetryStatus === 'quota due'
                        ? 'retrying now'
                        : `next retry: ${effectiveRetryStatus}`}
                    </span>
                  </div>
                )}

                {/* Runs Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left bg-transparent font-mono text-xs">
                    <thead className="text-zinc-500 uppercase border-b border-term-border bg-term-bg">
                      <tr>
                        <th className="px-4 py-2 font-normal w-32">Run ID</th>
                        <th className="px-4 py-2 font-normal w-32">Agent</th>
                        <th className="px-4 py-2 font-normal w-24">Status</th>
                        <th className="px-4 py-2 font-normal w-24">Duration</th>
                        <th className="px-4 py-2 font-normal">Started</th>
                        <th className="px-4 py-2 font-normal text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-term-border">
                      {group.runs.map((run) => (
                        (() => {
                          const isLatestRun = run.id === latestRun.id;
                          const showQuotaWaitStatus = isLatestRun && isQuotaWaiting && run.status === 'failed';
                          return (
                            <tr
                              key={run.id}
                              onClick={() => navigate(`/runs/${run.id}`)}
                              className="hover:bg-term-fg/5 transition-colors group cursor-pointer"
                            >
                              <td className="px-4 py-2 align-top text-term-fg">
                                {run.id.slice(0, 8)}
                              </td>
                              <td className="px-4 py-2 align-top text-zinc-400">
                                @{run.agentId}
                              </td>
                              <td className="px-4 py-2 align-top">
                                {showQuotaWaitStatus ? (
                                  <span className="uppercase text-yellow-400 animate-pulse font-bold">
                                    [quota_wait]
                                  </span>
                                ) : (
                                  <span className={`uppercase ${getStatusColor(run.status)}`}>
                                    [{run.status}]
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2 align-top text-zinc-500">
                                {run.finishedAt ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : '--'}
                              </td>
                              <td className="px-4 py-2 align-top text-zinc-600">
                                {new Date(run.startedAt).toLocaleString()}
                              </td>
                              <td className="px-4 py-2 align-top text-right">
                                <span className="text-term-tiger text-[10px] opacity-60 group-hover:opacity-100 hover:underline">
                                  OPEN &gt;
                                </span>
                              </td>
                            </tr>
                          );
                        })()
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'success': return 'text-term-tiger';
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
  if (retry.reason === 'quota_wait') {
    return seconds > 0 ? `quota ${seconds}s` : 'quota due';
  }
  if (retry.reason === 'awaiting_judge') {
    return seconds > 0 ? `judge ${seconds}s` : 'judge due';
  }
  if (retry.reason === 'needs_rework') {
    return seconds > 0 ? `rework ${seconds}s` : 'rework due';
  }
  return seconds > 0 ? `${seconds}s` : 'due';
}

function formatQuotaWaitStatus(retry: TaskRetryInfo | null | undefined, nowMs: number): string {
  if (!retry || !retry.autoRetry) {
    return 'quota pending';
  }

  if (!retry.retryAt) {
    return 'quota pending';
  }

  const retryAtMs = new Date(retry.retryAt).getTime();
  const seconds = Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000));
  return seconds > 0 ? `quota ${seconds}s` : 'quota due';
}

function isWaitingRetryStatus(status: string): boolean {
  return status === 'pending'
    || status === 'quota pending'
    || status === 'quota due'
    || /^\d+s$/.test(status)
    || /^quota \d+s$/.test(status);
}

function isQuotaErrorMessage(errorMessage: string | null | undefined): boolean {
  const normalized = (errorMessage ?? '').toLowerCase();
  return normalized.includes('quota')
    || normalized.includes('resource_exhausted')
    || normalized.includes('429');
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
