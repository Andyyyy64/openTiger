import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { plansApi, type PlanSnapshot } from '../lib/api';
import { Calendar, Layers, ListTodo } from 'lucide-react';

export const PlansPage: React.FC = () => {
  const { data: plans, isLoading, error } = useQuery({
    queryKey: ['plans'],
    queryFn: () => plansApi.list(20),
  });

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8 flex items-center gap-3">
        <Layers className="text-yellow-500" />
        Planner Plans
      </h1>

      {isLoading && (
        <div className="text-center text-slate-500 py-12">Loading plans...</div>
      )}
      {error && (
        <div className="text-center text-red-400 py-12">Error loading plans</div>
      )}

      <div className="space-y-8">
        {(plans ?? []).length === 0 && !isLoading && !error && (
          <div className="text-center text-slate-500 py-12">No plans found</div>
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
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-slate-400 text-sm">
            <Calendar size={16} />
            {new Date(plan.createdAt).toLocaleString()}
          </div>
          <h2 className="text-xl font-semibold">Plan</h2>
          {plan.requirement?.goal && (
            <p className="text-slate-300">{plan.requirement.goal}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-6 text-sm">
          <div className="text-slate-400">
            <div className="text-xs uppercase tracking-wider">Tasks</div>
            <div className="text-white font-semibold">{plan.summary?.totalTasks ?? plan.taskIds.length}</div>
          </div>
          <div className="text-slate-400">
            <div className="text-xs uppercase tracking-wider">Estimate</div>
            <div className="text-white font-semibold">{plan.summary?.totalEstimatedMinutes ?? 0} min</div>
          </div>
          <div className="text-slate-400">
            <div className="text-xs uppercase tracking-wider">Planner</div>
            <div className="text-white font-semibold">{plan.agentId ?? 'planner'}</div>
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Warnings</div>
          <ul className="text-sm text-slate-300 space-y-1">
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2 text-slate-400 text-xs uppercase tracking-wider">
          <ListTodo size={14} />
          Planned Tasks
        </div>
        <table className="w-full text-left">
          <thead className="bg-slate-900/60 border-b border-slate-800">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold text-slate-400">Status</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-400">Title</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-400">Role</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-400">Risk</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-400">Priority</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-400">Dependencies</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-400">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {plan.tasks.map((task) => (
              <tr key={task.id} className="hover:bg-slate-900/40 transition-colors">
                <td className="px-4 py-3">
                  <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${getStatusColor(task.status)}`}>
                    {task.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-slate-200">
                  <Link to={`/tasks/${task.id}`} className="hover:underline">
                    {task.title}
                  </Link>
                </td>
                <td className="px-4 py-3 text-xs text-slate-400 uppercase">{task.role}</td>
                <td className="px-4 py-3 text-xs font-semibold">{renderRisk(task.riskLevel)}</td>
                <td className="px-4 py-3 text-sm text-slate-300">{task.priority}</td>
                <td className="px-4 py-3 text-xs text-slate-400">
                  {task.dependencies?.length ? task.dependencies.length : 0}
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">
                  {new Date(task.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
            {plan.tasks.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                  No tasks recorded for this plan
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
      return 'bg-green-500/10 text-green-400 border border-green-500/20';
    case 'running':
      return 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
    case 'failed':
      return 'bg-red-500/10 text-red-400 border border-red-500/20';
    case 'blocked':
      return 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20';
    default:
      return 'bg-slate-500/10 text-slate-400 border border-slate-500/20';
  }
};

const renderRisk = (risk: string) => {
  const label = risk.toUpperCase();
  switch (risk) {
    case 'high':
      return <span className="text-red-400">{label}</span>;
    case 'medium':
      return <span className="text-yellow-400">{label}</span>;
    default:
      return <span className="text-green-400">{label}</span>;
  }
};
