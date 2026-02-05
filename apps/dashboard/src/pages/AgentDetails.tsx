import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { agentsApi, logsApi } from '../lib/api';

const LOG_LINES = 200;

export const AgentDetailsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();

  const { data: agent, isLoading: isAgentLoading } = useQuery({
    queryKey: ['agents', id],
    queryFn: () => agentsApi.get(id!),
    enabled: !!id,
  });

  const {
    data: logData,
    isLoading: isLogLoading,
    error: logError,
  } = useQuery({
    queryKey: ['logs', 'agents', id],
    queryFn: () => logsApi.agent(id!, LOG_LINES),
    enabled: !!id,
    refetchInterval: 10000,
  });

  if (isAgentLoading) {
    return <div className="p-8 text-center text-zinc-500 font-mono animate-pulse">&gt; Establishing connection...</div>;
  }

  if (!agent) {
    return <div className="p-8 text-center text-red-500 font-mono">&gt; ERR: AGENT_NOT_FOUND</div>;
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6 text-[var(--color-term-fg)]">
      <Link to="/agents" className="inline-block text-xs font-mono text-zinc-500 hover:text-[var(--color-term-green)] mb-2 group">
        &lt; cd ..
      </Link>

      <section className="border border-[var(--color-term-border)] p-0">
        <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)] flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold uppercase text-[var(--color-term-fg)] tracking-wide">
              Node@{agent.id}
            </h1>
            <div className="flex gap-4 mt-1 text-xs font-mono text-zinc-500">
              <span>ROLE: {agent.role.toUpperCase()}</span>
              <span>STATUS: <span className={agent.status === 'idle' ? 'text-zinc-500' : 'text-[var(--color-term-green)]'}>{agent.status.toUpperCase()}</span></span>
            </div>
          </div>

          <div className="text-right text-xs font-mono text-zinc-500">
            <div>LAST_HEARTBEAT</div>
            <div className="text-[var(--color-term-fg)]">
              {agent.lastHeartbeat ? new Date(agent.lastHeartbeat).toLocaleString() : 'NEVER'}
            </div>
          </div>
        </div>
      </section>

      <section className="border border-[var(--color-term-border)] p-0 flex flex-col h-[600px]">
        <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)] flex items-center justify-between">
          <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest">
            Console_Output (tail -n {LOG_LINES})
          </span>
          <span className="text-[10px] text-zinc-600 font-mono">
            {logData?.updatedAt ? `UPDATED: ${new Date(logData.updatedAt).toLocaleTimeString()}` : ''}
          </span>
        </div>

        <div className="flex-1 bg-black p-4 font-mono text-xs text-zinc-300 overflow-y-auto whitespace-pre-wrap">
          {isLogLoading && <div className="text-zinc-500 animate-pulse">&gt; Fetching logs...</div>}
          {!isLogLoading && logError && (
            <div className="text-red-500">&gt; ERR: Log stream unavailable.</div>
          )}
          {!isLogLoading && !logError && logData?.log && logData.log}
          {!isLogLoading && !logError && !logData?.log && (
            <div className="text-zinc-600 italic">// Console output is empty.</div>
          )}
          <div className="mt-2 w-2 h-4 bg-[var(--color-term-green)] animate-[pulse_1s_infinite]"></div>
        </div>
      </section>
    </div>
  );
};

