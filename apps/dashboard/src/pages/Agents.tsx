import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { agentsApi, tasksApi } from '../lib/api';
import { Link } from 'react-router-dom';

export const AgentsPage: React.FC = () => {
  const { data: agents, isLoading, error } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });
  const { data: tasks } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => tasksApi.list(),
  });

  // 依存関係が未完了のためディスパッチできない状態を検出する
  const queuedTasks = tasks?.filter(t => t.status === 'queued') ?? [];
  const doneTaskIds = new Set((tasks ?? []).filter(t => t.status === 'done').map(t => t.id));
  const queuedBlockedByDeps = queuedTasks.filter(task => {
    const deps = task.dependencies ?? [];
    return deps.length > 0 && deps.some(depId => !doneTaskIds.has(depId));
  });
  const idleWorkers = agents?.filter(a => a.role === 'worker' && a.status === 'idle') ?? [];
  const blockedByDepsWithIdleWorkers =
    queuedTasks.length > 0 &&
    queuedBlockedByDeps.length === queuedTasks.length &&
    idleWorkers.length > 0;

  return (
    <div className="p-6 text-[var(--color-term-fg)]">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-[var(--color-term-tiger)] font-pixel">
          &gt; Connected_Nodes (Agents)
        </h1>
        <span className="text-xs text-zinc-500">{agents?.length ?? 0} NODES ONLINE</span>
      </div>

      {blockedByDepsWithIdleWorkers && (
        <div className="mb-8 border border-yellow-600 p-4 text-sm text-yellow-500 font-bold bg-yellow-900/10">
          [WARNING] 依存関係が未完了のため、待機中タスクがディスパッチできません。
          <br />
          &gt; QUEUED: {queuedTasks.length} | BLOCKED: {queuedBlockedByDeps.length} | IDLE_WORKERS: {idleWorkers.length}
        </div>
      )}

      <div className="border border-[var(--color-term-border)]">
        <div className="grid grid-cols-12 gap-4 px-4 py-2 border-b border-[var(--color-term-border)] bg-[var(--color-term-border)]/10 text-xs font-bold text-zinc-500 uppercase">
          <div className="col-span-3">Node ID / Type</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Provider</div>
          <div className="col-span-3">Current Process</div>
          <div className="col-span-2 text-right">Last Heartbeat</div>
        </div>

        {isLoading ? (
          <div className="py-12 text-center text-zinc-500 font-mono animate-pulse">&gt; Scanning network...</div>
        ) : error ? (
          <div className="py-12 text-center text-red-500 font-mono">&gt; CONNECTION ERROR</div>
        ) : agents?.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 font-mono">&gt; No nodes detected</div>
        ) : (
          <div className="divide-y divide-[var(--color-term-border)] font-mono text-sm">
            {agents?.map((agent) => (
              <Link
                key={agent.id}
                to={`/agents/${agent.id}`}
                className="grid grid-cols-12 gap-4 px-4 py-3 hover:bg-[var(--color-term-tiger)]/5 transition-colors group items-center"
              >
                <div className="col-span-3 overflow-hidden">
                  <div className="font-bold text-[var(--color-term-fg)] group-hover:text-[var(--color-term-tiger)] truncate">
                    {agent.id}
                  </div>
                  <div className="text-xs text-zinc-500 uppercase flex gap-2 mt-1">
                    <span>[{agent.role}]</span>
                  </div>
                </div>

                <div className="col-span-2">
                  <span className={`text-xs uppercase px-1 ${agent.status === 'busy' ? 'bg-[var(--color-term-tiger)] text-black font-bold animate-pulse' : 'text-zinc-500'}`}>
                    {agent.status === 'busy' ? 'PROCESSING' : 'IDLE'}
                  </span>
                </div>

                <div className="col-span-2 text-xs text-zinc-400">
                  {agent.metadata?.provider && <span>{agent.metadata.provider}</span>}
                  {agent.metadata?.model && <span className="text-zinc-600 block">{agent.metadata.model}</span>}
                </div>

                <div className="col-span-3 text-xs">
                  {agent.status === 'busy' ? (
                    <div className="w-full">
                      <div className="flex justify-between mb-1">
                        <span className="text-[var(--color-term-tiger)]">EXEC_TASK</span>
                        <span className="text-zinc-500">{agent.currentTaskId?.slice(0, 8)}</span>
                      </div>
                      <div className="w-full bg-zinc-800 h-2">
                        <div className="h-full bg-[var(--color-term-tiger)] w-[60%] repeating-linear-gradient-animation"></div>
                      </div>
                    </div>
                  ) : (
                    <span className="text-zinc-600">--</span>
                  )}
                </div>

                <div className="col-span-2 text-right text-xs text-zinc-600">
                  {agent.lastHeartbeat ? new Date(agent.lastHeartbeat).toLocaleTimeString() : '--:--:--'}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
