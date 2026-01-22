import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { tasksApi } from '../lib/api';
import type { Task } from '@h1ve/core';

export const TasksPage: React.FC = () => {
  const { data: tasks, isLoading, error } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => tasksApi.list(),
  });

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Tasks</h1>
        <Link to="/tasks/new" className="bg-yellow-500 hover:bg-yellow-600 text-slate-950 px-4 py-2 rounded-lg font-semibold transition-colors">
          New Task
        </Link>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-slate-800/50 border-b border-slate-800">
            <tr>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Title</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Status</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Priority</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Risk</th>
              <th className="px-6 py-4 text-sm font-semibold text-slate-300">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-slate-500">Loading tasks...</td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-red-400">Error loading tasks</td>
              </tr>
            ) : tasks?.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-slate-500">No tasks found</td>
              </tr>
            ) : (
              tasks?.map((task: Task) => (
                <tr key={task.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="px-6 py-4">
                    <Link to={`/tasks/${task.id}`} className="font-medium hover:text-yellow-500 transition-colors">{task.title}</Link>
                    <div className="text-xs text-slate-500 truncate max-w-xs">{task.goal}</div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded text-xs font-medium uppercase ${getStatusColor(task.status)}`}>
                      {task.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-slate-300">{task.priority}</td>
                  <td className="px-6 py-4">
                    <span className={`text-xs ${getRiskColor(task.riskLevel)}`}>
                      {task.riskLevel}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-slate-500">
                    {new Date(task.createdAt).toLocaleDateString()}
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
