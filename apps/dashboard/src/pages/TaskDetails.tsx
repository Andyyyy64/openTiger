import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { tasksApi, runsApi } from '../lib/api';

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

  if (isTaskLoading) return <div className="p-8 text-center text-zinc-500 font-mono animate-pulse">&gt; Loading task data...</div>;
  if (!task) return <div className="p-8 text-center text-red-500 font-mono">&gt; ERR: Task not found in registry</div>;

  return (
    <div className="p-6 max-w-5xl mx-auto text-[var(--color-term-fg)] font-mono">
      <Link to="/tasks" className="inline-block text-xs text-zinc-500 hover:text-[var(--color-term-green)] mb-6 group">
        &lt; cd ..
      </Link>

      <div className="flex flex-col md:flex-row justify-between items-start mb-8 gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className={`text-xs font-bold ${getStatusColor(task.status)}`}>
              [{task.status.toUpperCase()}]
            </span>
            <span className="text-zinc-500 text-xs">ID: {task.id}</span>
          </div>
          <h1 className="text-xl font-bold uppercase tracking-widest text-[var(--color-term-green)]">
            &gt; Task: {task.title}
          </h1>
        </div>
        <div className="flex gap-4">
          <button className="text-zinc-400 hover:text-[var(--color-term-fg)] border border-zinc-700 hover:border-[var(--color-term-fg)] px-4 py-1 text-xs font-bold uppercase transition-all">
            [ EDIT_CONFIG ]
          </button>
          <button className="text-[var(--color-term-green)] border border-[var(--color-term-green)] hover:bg-[var(--color-term-green)] hover:text-black px-4 py-1 text-xs font-bold uppercase transition-all">
            [ EXECUTE_RUN ]
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Goal Section */}
          <section className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-wider">01_Objective_&_Criteria</h2>
            </div>
            <div className="p-4">
              <p className="text-zinc-300 text-sm whitespace-pre-wrap leading-relaxed">
                {task.goal}
              </p>
            </div>
          </section>

          {/* Context Section */}
          <section className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-wider">02_Context_Data</h2>
            </div>
            <div className="p-4 space-y-4">
              {task.context?.specs && (
                <div>
                  <h3 className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wide">Specifications</h3>
                  <div className="border-l-2 border-zinc-700 pl-2 text-zinc-400 text-xs">
                    {task.context.specs}
                  </div>
                </div>
              )}
              {task.context?.files && task.context.files.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-zinc-500 mb-1 uppercase tracking-wide">Related Files</h3>
                  <div className="flex flex-wrap gap-2">
                    {task.context.files.map((file, i) => (
                      <span key={i} className="text-xs text-zinc-300 bg-zinc-900 px-2 py-0.5 border border-zinc-800">
                        {file}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Execution History */}
          <section className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-wider">Execution_Log</h2>
            </div>
            <div className="overflow-x-auto">
              {isRunsLoading ? (
                <div className="p-8 text-center text-zinc-500 animate-pulse">&gt; Fetching history...</div>
              ) : runs?.length === 0 ? (
                <div className="p-8 text-center text-zinc-500 italic">// No execution history found.</div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="text-zinc-500 border-b border-[var(--color-term-border)]">
                    <tr>
                      <th className="px-4 py-2 font-normal uppercase">Agent_ID</th>
                      <th className="px-4 py-2 font-normal uppercase">Status</th>
                      <th className="px-4 py-2 font-normal uppercase">Duration</th>
                      <th className="px-4 py-2 font-normal uppercase">Started_At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-term-border)]">
                    {runs?.map((run) => (
                      <tr key={run.id} className="hover:bg-[var(--color-term-fg)]/5 transition-colors cursor-pointer group">
                        <td className="px-4 py-2 text-[var(--color-term-fg)] group-hover:text-[var(--color-term-green)]">{run.agentId}</td>
                        <td className="px-4 py-2">
                          <span className={`font-bold ${run.status === 'success' ? 'text-[var(--color-term-green)]' : run.status === 'failed' ? 'text-red-500' : 'text-blue-400'}`}>
                            [{run.status.toUpperCase()}]
                          </span>
                        </td>
                        <td className="px-4 py-2 text-zinc-400">
                          {run.finishedAt ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : '-'}
                        </td>
                        <td className="px-4 py-2 text-zinc-500">
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
          <section className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-wider">Params</h2>
            </div>
            <div className="p-4 space-y-3 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">RISK_LEVEL</span>
                <span className={`font-bold ${getRiskColor(task.riskLevel)}`}>{task.riskLevel.toUpperCase()}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">PRIORITY</span>
                <span className="text-[var(--color-term-fg)]">{task.priority}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">ROLE</span>
                <span className="text-[var(--color-term-fg)]">{task.role?.toUpperCase() ?? 'WORKER'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-zinc-500 uppercase">TIMEBOX</span>
                <span className="text-[var(--color-term-fg)]">{task.timeboxMinutes}m</span>
              </div>
            </div>
          </section>

          {/* Allowed Paths */}
          <section className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-wider">Scope: Allowed_Paths</h2>
            </div>
            <div className="p-4 space-y-1">
              {task.allowedPaths.map((path, i) => (
                <div key={i} className="text-xs font-mono text-zinc-400 break-all">
                  - {path}
                </div>
              ))}
              {task.allowedPaths.length === 0 && <div className="text-xs text-zinc-600 italic">// No paths defined</div>}
            </div>
          </section>

          {/* Commands */}
          <section className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-wider">Verification_Cmds</h2>
            </div>
            <div className="p-4 space-y-1">
              {task.commands.map((cmd, i) => (
                <div key={i} className="text-xs font-mono text-yellow-500 break-all">
                  $ {cmd}
                </div>
              ))}
              {task.commands.length === 0 && <div className="text-xs text-zinc-600 italic">// No commands defined</div>}
            </div>
          </section>

          {/* Dependencies */}
          <section className="border border-[var(--color-term-border)] p-0">
            <div className="bg-[var(--color-term-border)]/10 px-4 py-2 border-b border-[var(--color-term-border)]">
              <h2 className="text-sm font-bold uppercase tracking-wider">Dependencies</h2>
            </div>
            <div className="p-4">
              {task.dependencies?.length ? (
                <div className="space-y-1">
                  {task.dependencies.map((dependencyId) => (
                    <Link
                      key={dependencyId}
                      to={`/tasks/${dependencyId}`}
                      className="block text-xs font-mono text-[var(--color-term-fg)] hover:text-[var(--color-term-green)] hover:underline break-all"
                    >
                      &gt; {dependencyId}
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-zinc-600 italic">// No dependencies</div>
              )}
            </div>
          </section>
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

