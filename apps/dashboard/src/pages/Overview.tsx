import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { tasksApi, runsApi, agentsApi } from '../lib/api';

export const OverviewPage: React.FC = () => {
  const { data: tasks } = useQuery({ queryKey: ['tasks'], queryFn: () => tasksApi.list() });
  const { data: runs } = useQuery({ queryKey: ['runs'], queryFn: () => runsApi.list() });
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: () => agentsApi.list() });
  const now = Date.now();
  const queuedTasks = tasks?.filter(t => t.status === 'queued') ?? [];
  const blockedTasks = tasks?.filter(t => t.status === 'blocked') ?? [];
  const retryExhaustedTasks =
    tasks?.filter(t => (t.status === 'failed' || t.status === 'blocked') && (t.retryCount ?? 0) >= 3) ?? [];

  const stats = {
    activeWorkers: agents?.filter(a => a.status === 'busy').length ?? 0,
    pendingTasks: queuedTasks.length,
    completedTasks: tasks?.filter(t => t.status === 'done').length ?? 0,
    successRate: runs ? Math.round((runs.filter(r => r.status === 'success').length / runs.length) * 100) : 0,
    oldestQueuedMinutes:
      queuedTasks.length === 0
        ? 0
        : Math.max(
            ...queuedTasks.map((task) =>
              Math.floor((now - new Date(task.updatedAt).getTime()) / 60000)
            )
          ),
    blockedOver30m: blockedTasks.filter(
      (task) => now - new Date(task.updatedAt).getTime() > 30 * 60 * 1000
    ).length,
    retryExhausted: retryExhaustedTasks.length,
  };

  return (
    <div className="p-6 text-[var(--color-term-fg)]">
      <h1 className="text-xl font-bold mb-8 uppercase tracking-widest text-[var(--color-term-green)]">
        &gt; System_Overview_
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
        <StatCard
          title="ACTIVE WORKERS"
          value={stats.activeWorkers.toString()}
          subValue={`/ ${agents?.length ?? 0} TOTAL`}
        />
        <StatCard
          title="PENDING TASKS"
          value={stats.pendingTasks.toString()}
          subValue="IN QUEUE"
        />
        <StatCard
          title="COMPLETED"
          value={stats.completedTasks.toString()}
          subValue="FINISHED"
        />
        <StatCard
          title="SUCCESS RATE"
          value={`${stats.successRate}%`}
          subValue="LIFETIME"
        />
        <StatCard
          title="QUEUE AGE MAX"
          value={`${stats.oldestQueuedMinutes}m`}
          subValue="SLO <= 5m"
          alert={stats.oldestQueuedMinutes > 5}
        />
        <StatCard
          title="BLOCKED > 30M"
          value={stats.blockedOver30m.toString()}
          subValue="AUTO RECOVERY"
          alert={stats.blockedOver30m > 0}
        />
        <StatCard
          title="RETRY EXHAUSTED"
          value={stats.retryExhausted.toString()}
          subValue="FAILED/BLOCKED"
          alert={stats.retryExhausted > 0}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="border border-[var(--color-term-border)] p-0">
          <div className="border-b border-[var(--color-term-border)] bg-[var(--color-term-border)]/10 px-4 py-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider">Recent Activity Log</h2>
            <span className="text-xs text-zinc-500">tail -f runs.log</span>
          </div>
          <div className="p-4 space-y-2 font-mono text-sm max-h-[300px] overflow-y-auto">
            {runs?.slice(0, 5).map(run => (
              <div key={run.id} className="flex items-start gap-3 pb-2 border-b border-zinc-800 last:border-0 last:pb-0">
                <span className="text-zinc-500 text-xs whitespace-nowrap">
                  [{new Date(run.startedAt).toLocaleTimeString()}]
                </span>
                <div className="flex-1">
                  <div className="flex justify-between">
                    <span>Agent <span className="text-[var(--color-term-green)]">{run.agentId}</span> started run</span>
                    <span className={`text-xs uppercase ${run.status === 'success' ? 'text-[var(--color-term-green)]' : 'text-red-500'}`}>
                      [{run.status}]
                    </span>
                  </div>
                  <div className="text-xs text-zinc-600 mt-1">ID: {run.id}</div>
                </div>
              </div>
            ))}
            {(!runs || runs.length === 0) && <div className="text-zinc-500 py-4">&gt; No recent activity found</div>}
          </div>
        </div>

        <div className="border border-[var(--color-term-border)] p-0">
          <div className="border-b border-[var(--color-term-border)] bg-[var(--color-term-border)]/10 px-4 py-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider">Process List (Tasks)</h2>
            <span className="text-xs text-zinc-500">top</span>
          </div>
          <div className="p-4 space-y-1 font-mono text-sm">
            <div className="flex text-xs text-zinc-500 mb-2 border-b border-zinc-800 pb-1">
              <span className="w-20">PID</span>
              <span className="flex-1">COMMAND/TITLE</span>
              <span className="w-20 text-right">STATE</span>
            </div>
            {tasks?.filter(t => t.status === 'running').slice(0, 5).map(task => (
              <div key={task.id} className="flex items-center text-xs">
                <span className="w-20 text-blue-400">{task.id.slice(0, 8)}</span>
                <span className="flex-1 truncate pr-4 text-zinc-300">{task.title}</span>
                <span className="w-20 text-right text-[var(--color-term-green)] animate-pulse">RUNNING</span>
              </div>
            ))}
            {tasks?.filter(t => t.status === 'running').length === 0 && (
              <div className="text-zinc-500 py-4">&gt; No active processes</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const StatCard = ({
  title,
  value,
  subValue,
  alert = false,
}: {
  title: string;
  value: string;
  subValue: string;
  alert?: boolean;
}) => (
  <div className="border border-[var(--color-term-border)] p-4 hover:bg-[var(--color-term-border)]/10 transition-colors cursor-default">
    <div className="flex justify-between items-start mb-2">
      <h3 className="text-zinc-500 text-xs font-bold uppercase">{title}</h3>
    </div>
    <p className={`text-3xl font-mono mb-1 ${alert ? 'text-red-500' : 'text-[var(--color-term-green)]'}`}>{value}</p>
    <p className="text-zinc-600 text-xs font-mono">{subValue}</p>
  </div>
);
