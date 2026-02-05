import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { runsApi } from '../lib/api';
import { Link } from 'react-router-dom';

export const RunsPage: React.FC = () => {
  const { data: runs, isLoading, error } = useQuery({
    queryKey: ['runs'],
    queryFn: () => runsApi.list(),
  });

  return (
    <div className="p-6 text-[var(--color-term-fg)]">
      <h1 className="text-xl font-bold mb-8 uppercase tracking-widest text-[var(--color-term-green)]">
        &gt; Execution_Values (Runs)
      </h1>

      <div className="border border-[var(--color-term-border)]">
        <div className="overflow-x-auto">
          <table className="w-full text-left bg-transparent">
            <thead className="bg-[var(--color-term-border)]/10 text-xs text-zinc-500 uppercase font-mono">
              <tr>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Run ID / Agent</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Status</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Task ID</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Duration</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]">Started</th>
                <th className="px-4 py-2 font-normal border-b border-[var(--color-term-border)]"></th>
              </tr>
            </thead>
            <tbody className="font-mono text-sm divide-y divide-[var(--color-term-border)]">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-zinc-500 animate-pulse">&gt; Loading data...</td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-red-500">&gt; ERROR LOADING DATA</td>
                </tr>
              ) : runs?.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-zinc-500">&gt; No records found</td>
                </tr>
              ) : (
                runs?.map((run) => (
                  <tr key={run.id} className="hover:bg-[var(--color-term-green)]/5 transition-colors group">
                    <td className="px-4 py-2 align-top">
                      <div className="flex flex-col">
                        <span className="text-[var(--color-term-fg)]">{run.id.slice(0, 8)}</span>
                        <span className="text-xs text-zinc-500">@{run.agentId}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 align-top">
                      <span className={`text-xs uppercase ${getStatusColor(run.status)}`}>
                        [{run.status}]
                      </span>
                    </td>
                    <td className="px-4 py-2 align-top">
                      <Link to={`/tasks/${run.taskId}`} className="text-xs text-zinc-400 hover:text-[var(--color-term-green)] hover:underline">
                        {run.taskId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-500 text-xs">
                      {run.finishedAt ? `${Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s` : '--'}
                    </td>
                    <td className="px-4 py-2 align-top text-zinc-600 text-xs">
                      {new Date(run.startedAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right align-top">
                      <Link to={`/runs/${run.id}`} className="text-[var(--color-term-green)] hover:underline text-xs opacity-50 group-hover:opacity-100">
                        OPEN &gt;
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'success': return 'text-[var(--color-term-green)]';
    case 'failed': return 'text-red-500';
    case 'running': return 'text-blue-400 animate-pulse';
    default: return 'text-zinc-500';
  }
};
