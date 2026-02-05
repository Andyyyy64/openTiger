import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { plansApi, type PlanSnapshot } from '../lib/api';

export const PlansPage: React.FC = () => {
  const { data: plans, isLoading, error } = useQuery({
    queryKey: ['plans'],
    queryFn: () => plansApi.list(20),
  });

  return (
    <div className="p-6 text-[var(--color-term-fg)]">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-[var(--color-term-green)]">
          &gt; Active_Plans
        </h1>
        <span className="text-xs text-zinc-500">
          {isLoading ? 'Scanning...' : `${plans?.length ?? 0} PLANS LOADED`}
        </span>
      </div>

      {isLoading && (
        <div className="text-center text-zinc-500 py-12 font-mono animate-pulse">&gt; Retrieving plans...</div>
      )}
      {error && (
        <div className="text-center text-red-500 py-12 font-mono">&gt; ERROR: Failed to load plans</div>
      )}

      <div className="space-y-8">
        {(plans ?? []).length === 0 && !isLoading && !error && (
          <div className="text-center text-zinc-500 py-12 font-mono">&gt; No plans found in registry</div>
        )}

        {(plans ?? []).map((plan) => (
          <PlanCard key={plan.id} plan={plan} />
        ))}
      </div>
    </div>
  );
};

const PlanCard = ({ plan }: { plan: PlanSnapshot }) => {
  const warnings = plan.summary?.warnings ?? [];

  return (
    <section className="border border-[var(--color-term-border)] p-0">
      {/* Header */}
      <div className="bg-[var(--color-term-border)]/10 px-4 py-3 border-b border-[var(--color-term-border)] flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-zinc-500 text-xs font-mono">
            <span>TIMESTAMP: {new Date(plan.createdAt).toLocaleString()}</span>
            <span>|</span>
            <span>ID: {plan.id.slice(0, 8)}</span>
          </div>
          <h2 className="text-lg font-bold text-[var(--color-term-fg)] uppercase tracking-wide">
            plan@{plan.agentId ?? 'planner'}
          </h2>
          {plan.requirement?.goal && (
            <div className="text-zinc-400 text-sm font-mono border-l-2 border-[var(--color-term-green)] pl-2 mt-2">
              "{plan.requirement.goal}"
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-6 text-xs font-mono">
          <div>
            <div className="text-zinc-500 mb-1">TASKS</div>
            <div className="text-[var(--color-term-green)]">
              {plan.summary?.totalTasks ?? plan.taskIds.length} OK
            </div>
          </div>
          <div>
            <div className="text-zinc-500 mb-1">ESTIAMTE</div>
            <div>{plan.summary?.totalEstimatedMinutes ?? 0}m</div>
          </div>
        </div>
      </div>

      {/* Warnings Block */}
      {warnings.length > 0 && (
        <div className="p-4 border-b border-[var(--color-term-border)] bg-yellow-900/10">
          <div className="text-xs font-bold text-yellow-500 mb-2 uppercase">&gt; Warnings_Detected:</div>
          <ul className="text-xs text-yellow-200/80 font-mono space-y-1">
            {warnings.map((warning, index) => (
              <li key={index}>* {warning}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Task Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-xs">
          <thead className="text-zinc-500 uppercase bg-[var(--color-term-bg)] border-b border-[var(--color-term-border)]">
            <tr>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Title</th>
              <th className="px-4 py-2 font-normal">Role</th>
              <th className="px-4 py-2 font-normal">Risk</th>
              <th className="px-4 py-2 font-normal">Priority</th>
              <th className="px-4 py-2 font-normal">Deps</th>
              <th className="px-4 py-2 font-normal">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-term-border)]">
            {plan.tasks.map((task) => (
              <tr key={task.id} className="hover:bg-[var(--color-term-fg)]/5 transition-colors group">
                <td className="px-4 py-2 align-top">
                  <span className={`${getStatusColor(task.status)}`}>
                    [{task.status.toUpperCase()}]
                  </span>
                </td>
                <td className="px-4 py-2 align-top w-1/3">
                  <Link to={`/tasks/${task.id}`} className="text-[var(--color-term-fg)] group-hover:underline">
                    {task.title}
                  </Link>
                </td>
                <td className="px-4 py-2 align-top text-zinc-400">{task.role}</td>
                <td className="px-4 py-2 align-top">{renderRisk(task.riskLevel)}</td>
                <td className="px-4 py-2 align-top text-zinc-300">{task.priority}</td>
                <td className="px-4 py-2 align-top text-zinc-500">
                  {task.dependencies?.length ? `[${task.dependencies.length}]` : '-'}
                </td>
                <td className="px-4 py-2 align-top text-zinc-600">
                  {new Date(task.createdAt).toLocaleTimeString()}
                </td>
              </tr>
            ))}
            {plan.tasks.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-zinc-500 italic">
                  &gt; No tasks initialized.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'done':
      return 'text-[var(--color-term-green)]';
    case 'running':
      return 'text-blue-400 animate-pulse';
    case 'failed':
      return 'text-red-500';
    case 'blocked':
      return 'text-yellow-500';
    default:
      return 'text-zinc-500';
  }
};

const renderRisk = (risk: string) => {
  const label = risk.toUpperCase();
  switch (risk) {
    case 'high':
      return <span className="text-red-500 font-bold">! {label} !</span>;
    case 'medium':
      return <span className="text-yellow-500">{label}</span>;
    default:
      return <span className="text-zinc-500">{label}</span>;
  }
};

