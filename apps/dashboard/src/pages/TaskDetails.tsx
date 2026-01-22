import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { tasksApi, runsApi } from '../lib/api';
import { ChevronLeft, Clock, Shield, AlertTriangle, CheckCircle2, PlayCircle } from 'lucide-react';

export const TaskDetailsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();

  const { data: task, isLoading: isTaskLoading } = useQuery({
    queryKey: ['tasks', id],
    queryFn: () => tasksApi.get(id!),
    enabled: !!id,
  });

  const { data: runs, isLoading: isRunsLoading } = useQuery({
    queryKey: ['tasks', id, 'runs'],
    queryFn: () => runsApi.list(id!),
    enabled: !!id,
  });

  if (isTaskLoading) return <div className="p-8 text-center text-slate-500">Loading task details...</div>;
  if (!task) return <div className="p-8 text-center text-red-400">Task not found</div>;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link to="/tasks" className="flex items-center gap-2 text-slate-400 hover:text-white mb-6 transition-colors">
        <ChevronLeft size={20} />
        Back to Tasks
      </Link>

      <div className="flex justify-between items-start mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <span className={`px-2 py-1 rounded text-xs font-bold uppercase ${getStatusColor(task.status)}`}>
              {task.status}
            </span>
            <span className="text-slate-500 text-sm">ID: {task.id}</span>
          </div>
          <h1 className="text-4xl font-bold">{task.title}</h1>
        </div>
        <div className="flex gap-3">
          <button className="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-lg font-medium transition-colors border border-slate-700">
            Edit Task
          </button>
          <button className="bg-yellow-500 hover:bg-yellow-600 text-slate-950 px-4 py-2 rounded-lg font-bold transition-colors">
            Run Now
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Goal Section */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <CheckCircle2 size={20} className="text-yellow-500" />
              Goal & Acceptance Criteria
            </h2>
            <p className="text-slate-300 whitespace-pre-wrap leading-relaxed">
              {task.goal}
            </p>
          </section>

          {/* Context Section */}
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4">Context</h2>
            <div className="space-y-4">
              {task.context?.specs && (
                <div>
                  <h3 className="text-sm font-medium text-slate-500 mb-1 uppercase tracking-wider">Specifications</h3>
                  <p className="text-slate-300 text-sm">{task.context.specs}</p>
                </div>
              )}
              {task.context?.files && task.context.files.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-slate-500 mb-1 uppercase tracking-wider">Related Files</h3>
                  <div className="flex flex-wrap gap-2">
                    {task.context.files.map((file, i) => (
                      <code key={i} className="bg-slate-800 px-2 py-1 rounded text-xs text-slate-300 border border-slate-700">
                        {file}
                      </code>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Execution History */}
          <section>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
              <Clock size={22} className="text-slate-400" />
              Execution History
            </h2>
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
              {isRunsLoading ? (
                <div className="p-8 text-center text-slate-500">Loading runs...</div>
              ) : runs?.length === 0 ? (
                <div className="p-8 text-center text-slate-500">No execution history yet</div>
              ) : (
                <table className="w-full text-left">
                  <thead className="bg-slate-800/50 border-b border-slate-800">
                    <tr>
                      <th className="px-6 py-3 text-xs font-semibold text-slate-400 uppercase">Agent</th>
                      <th className="px-6 py-3 text-xs font-semibold text-slate-400 uppercase">Status</th>
                      <th className="px-6 py-3 text-xs font-semibold text-slate-400 uppercase">Duration</th>
                      <th className="px-6 py-3 text-xs font-semibold text-slate-400 uppercase">Started</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {runs?.map((run) => (
                      <tr key={run.id} className="hover:bg-slate-800/30 transition-colors cursor-pointer">
                        <td className="px-6 py-4 text-sm font-medium">{run.agentId}</td>
                        <td className="px-6 py-4">
                          <span className={`text-xs font-bold ${run.status === 'success' ? 'text-green-400' : run.status === 'failed' ? 'text-red-400' : 'text-blue-400'}`}>
                            {run.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-400">
                          {run.finishedAt ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : '-'}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-500">
                          {new Date(run.startedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          {/* Configuration Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-4">Configuration</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <Shield size={16} />
                  Risk Level
                </div>
                <span className={`text-sm font-bold ${getRiskColor(task.riskLevel)}`}>{task.riskLevel.toUpperCase()}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <AlertTriangle size={16} />
                  Priority
                </div>
                <span className="text-sm font-bold text-white">{task.priority}</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <PlayCircle size={16} />
                  Timebox
                </div>
                <span className="text-sm font-bold text-white">{task.timeboxMinutes} min</span>
              </div>
            </div>
          </div>

          {/* Allowed Paths */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-4">Allowed Paths</h2>
            <div className="space-y-2">
              {task.allowedPaths.map((path, i) => (
                <div key={i} className="text-xs font-mono text-slate-400 bg-slate-950 p-2 rounded border border-slate-800 break-all">
                  {path}
                </div>
              ))}
            </div>
          </div>

          {/* Commands */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <h2 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-4">Verification</h2>
            <div className="space-y-2">
              {task.commands.map((cmd, i) => (
                <div key={i} className="text-xs font-mono text-yellow-500 bg-slate-950 p-2 rounded border border-slate-800 break-all">
                  $ {cmd}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'done': return 'bg-green-500/10 text-green-400 border border-green-500/20';
    case 'running': return 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
    case 'failed': return 'bg-red-500/10 text-red-400 border border-red-500/20';
    case 'blocked': return 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20';
    default: return 'bg-slate-500/10 text-slate-400 border border-slate-500/20';
  }
};

const getRiskColor = (risk: string) => {
  switch (risk) {
    case 'high': return 'text-red-400';
    case 'medium': return 'text-yellow-400';
    default: return 'text-green-400';
  }
};
