import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { agentsApi, logsApi } from '../lib/api';
import { ChevronLeft, Terminal, ShieldCheck, Clock } from 'lucide-react';

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
    return <div className="p-8 text-center text-slate-500">Loading agent...</div>;
  }

  if (!agent) {
    return <div className="p-8 text-center text-red-400">Agent not found</div>;
  }

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <Link to="/agents" className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
        <ChevronLeft size={20} />
        Back to Agents
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <ShieldCheck size={22} className="text-blue-400" />
            <span className="text-xs text-slate-500 uppercase tracking-wider">{agent.role}</span>
          </div>
          <h1 className="text-3xl font-bold">{agent.id}</h1>
          <p className="text-sm text-slate-400 mt-2">Status: {agent.status}</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-300 space-y-1">
          <div className="flex items-center gap-2 text-slate-400">
            <Clock size={14} />
            Last Heartbeat
          </div>
          <div>
            {agent.lastHeartbeat ? new Date(agent.lastHeartbeat).toLocaleString() : 'Never'}
          </div>
        </div>
      </div>

      <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="bg-slate-900 px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal size={16} className="text-slate-400" />
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
              Agent Log (last {LOG_LINES} lines)
            </span>
          </div>
          <div className="text-xs text-slate-500">
            {logData?.updatedAt ? `Updated: ${new Date(logData.updatedAt).toLocaleTimeString()}` : ''}
          </div>
        </div>
        <div className="p-4 font-mono text-xs text-slate-300 min-h-[320px] whitespace-pre-wrap">
          {isLogLoading && <div className="text-slate-500">Loading logs...</div>}
          {!isLogLoading && logError && (
            <div className="text-red-400">ログが見つかりませんでした</div>
          )}
          {!isLogLoading && !logError && logData?.log && logData.log}
          {!isLogLoading && !logError && !logData?.log && (
            <div className="text-slate-500">ログが空です</div>
          )}
        </div>
      </section>
    </div>
  );
};
