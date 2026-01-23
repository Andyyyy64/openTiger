import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { agentsApi } from '../lib/api';
import { Users, ShieldCheck, Clock, Zap } from 'lucide-react';

export const AgentsPage: React.FC = () => {
  const { data: agents, isLoading, error } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentsApi.list(),
  });

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
        <Users className="text-blue-500" />
        Agents
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          <div className="col-span-full py-12 text-center text-slate-500">Loading agents...</div>
        ) : error ? (
          <div className="col-span-full py-12 text-center text-red-400">Error loading agents</div>
        ) : agents?.length === 0 ? (
          <div className="col-span-full py-12 text-center text-slate-500">No agents registered</div>
        ) : (
          agents?.map((agent) => (
            <div key={agent.id} className="bg-slate-900 border border-slate-800 rounded-xl p-6 hover:border-slate-700 transition-all group">
              <div className="flex justify-between items-start mb-6">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${agent.status === 'busy' ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-800 text-slate-400'}`}>
                    <ShieldCheck size={24} />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-100 group-hover:text-yellow-500 transition-colors">{agent.id}</h3>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs text-slate-500 uppercase font-bold tracking-wider">{agent.role}</p>
                      {agent.metadata?.provider && (
                        <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/20">
                          {agent.metadata.provider}
                        </span>
                      )}
                      {agent.metadata?.model && (
                        <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">
                          {agent.metadata.model}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${agent.status === 'busy' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : 'bg-green-500/10 text-green-400 border border-green-500/20'}`}>
                  {agent.status}
                </span>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-slate-500">
                    <Clock size={14} />
                    Last Heartbeat
                  </div>
                  <span className="text-slate-300">
                    {agent.lastHeartbeat ? new Date(agent.lastHeartbeat).toLocaleTimeString() : 'Never'}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-slate-500">
                    <Zap size={14} />
                    Current Task
                  </div>
                  <span className="text-slate-300 font-mono">
                    {agent.currentTaskId ? agent.currentTaskId.slice(0, 8) : 'None'}
                  </span>
                </div>
              </div>

              {agent.status === 'busy' && (
                <div className="mt-6 pt-6 border-t border-slate-800">
                  <div className="w-full bg-slate-800 rounded-full h-1.5 mb-2">
                    <div className="bg-blue-500 h-1.5 rounded-full animate-pulse" style={{ width: '65%' }}></div>
                  </div>
                  <p className="text-[10px] text-slate-500 text-center uppercase font-bold tracking-widest">Processing Task</p>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
