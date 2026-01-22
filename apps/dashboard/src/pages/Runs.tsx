import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { runsApi } from '../lib/api';
import { Link } from 'react-router-dom';
import { Activity, Clock, User, ExternalLink } from 'lucide-react';

export const RunsPage: React.FC = () => {
  const { data: runs, isLoading, error } = useQuery({
    queryKey: ['runs'],
    queryFn: () => runsApi.list(),
  });

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
        <Activity className="text-blue-500" />
        Execution Runs
      </h1>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-slate-800/50 border-b border-slate-800">
            <tr>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Run ID / Agent</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Status</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Task ID</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Duration</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Started</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-slate-500">Loading runs...</td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-red-400">Error loading runs</td>
              </tr>
            ) : runs?.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-slate-500">No runs found</td>
              </tr>
            ) : (
              runs?.map((run) => (
                <tr key={run.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2 font-medium text-slate-200">
                      <span className="text-xs font-mono text-slate-500">{run.id.slice(0, 8)}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-slate-500 mt-1">
                      <User size={12} />
                      {run.agentId}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase ${getStatusColor(run.status)}`}>
                      {run.status}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <Link to={`/tasks/${run.taskId}`} className="text-xs font-mono text-yellow-500 hover:underline">
                      {run.taskId.slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-400">
                    <div className="flex items-center gap-1">
                      <Clock size={14} />
                      {run.finishedAt ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : 'Running...'}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-500">
                    {new Date(run.startedAt).toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link to={`/runs/${run.id}`} className="text-slate-500 hover:text-white transition-colors">
                      <ExternalLink size={18} />
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'success': return 'bg-green-500/10 text-green-400 border border-green-500/20';
    case 'failed': return 'bg-red-500/10 text-red-400 border border-red-500/20';
    case 'running': return 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
    default: return 'bg-slate-500/10 text-slate-400 border border-slate-500/20';
  }
};
