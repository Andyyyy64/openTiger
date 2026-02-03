import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { tasksApi, runsApi, agentsApi } from '../lib/api';
import { Activity, ListTodo, Users, CheckCircle2 } from 'lucide-react';

export const OverviewPage: React.FC = () => {
  const { data: tasks } = useQuery({ queryKey: ['tasks'], queryFn: () => tasksApi.list() });
  const { data: runs } = useQuery({ queryKey: ['runs'], queryFn: () => runsApi.list() });
  const { data: agents } = useQuery({ queryKey: ['agents'], queryFn: () => agentsApi.list() });

  // 依存関係が未解決のためディスパッチできない状態を検出する
  const queuedTasks = tasks?.filter(t => t.status === 'queued') ?? [];
  const doneTaskIds = new Set((tasks ?? []).filter(t => t.status === 'done').map(t => t.id));
  const queuedBlockedByDeps = queuedTasks.filter(task =>
    (task.dependencies?.length ?? 0) > 0 &&
    task.dependencies!.some(depId => !doneTaskIds.has(depId))
  );
  const idleWorkers = agents?.filter(a => a.role === 'worker' && a.status === 'idle') ?? [];
  const blockedByDepsWithIdleWorkers =
    queuedTasks.length > 0 &&
    queuedBlockedByDeps.length === queuedTasks.length &&
    idleWorkers.length > 0;

  const stats = {
    activeWorkers: agents?.filter(a => a.status === 'busy').length ?? 0,
    pendingTasks: tasks?.filter(t => t.status === 'queued').length ?? 0,
    completedTasks: tasks?.filter(t => t.status === 'done').length ?? 0,
    successRate: runs ? Math.round((runs.filter(r => r.status === 'success').length / runs.length) * 100) : 0,
  };

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">System Overview</h1>

      {blockedByDepsWithIdleWorkers && (
        <div className="mb-8 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-200">
          依存関係が未完了のため、待機中タスクがディスパッチできません。
          （待機中: {queuedTasks.length} / 依存待ち: {queuedBlockedByDeps.length} / 空きワーカー: {idleWorkers.length}）
        </div>
      )}
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
        <StatCard 
          title="Active Workers" 
          value={stats.activeWorkers.toString()} 
          icon={<Users className="text-blue-500" />}
          subValue={`Total ${agents?.length ?? 0} agents`} 
        />
        <StatCard 
          title="Pending Tasks" 
          value={stats.pendingTasks.toString()} 
          icon={<ListTodo className="text-yellow-500" />}
          subValue="Waiting in queue" 
        />
        <StatCard 
          title="Completed Tasks" 
          value={stats.completedTasks.toString()} 
          icon={<CheckCircle2 className="text-green-500" />}
          subValue="Successfully finished" 
        />
        <StatCard 
          title="Success Rate" 
          value={`${stats.successRate}%`} 
          icon={<Activity className="text-purple-500" />}
          subValue="Based on all runs" 
          color="text-purple-400"
        />
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
            <Activity size={20} className="text-blue-500" />
            Recent Runs
          </h2>
          <div className="space-y-4">
            {runs?.slice(0, 5).map(run => (
              <div key={run.id} className="flex items-center justify-between p-3 bg-slate-950 rounded-lg border border-slate-800">
                <div>
                  <div className="text-sm font-medium">{run.agentId}</div>
                  <div className="text-xs text-slate-500">{new Date(run.startedAt).toLocaleTimeString()}</div>
                </div>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${run.status === 'success' ? 'text-green-400 bg-green-400/10' : 'text-red-400 bg-red-400/10'}`}>
                  {run.status}
                </span>
              </div>
            ))}
            {(!runs || runs.length === 0) && <div className="text-slate-500 text-center py-8">No recent activity</div>}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-xl font-semibold mb-6 flex items-center gap-2">
            <ListTodo size={20} className="text-yellow-500" />
            Active Tasks
          </h2>
          <div className="space-y-4">
            {tasks?.filter(t => t.status === 'running').slice(0, 5).map(task => (
              <div key={task.id} className="p-3 bg-slate-950 rounded-lg border border-slate-800">
                <div className="text-sm font-medium truncate">{task.title}</div>
                <div className="flex justify-between items-center mt-2">
                  <span className="text-[10px] text-slate-500 font-mono">{task.id.slice(0, 8)}</span>
                  <span className="text-[10px] text-blue-400 font-bold uppercase">Running</span>
                </div>
              </div>
            ))}
            {tasks?.filter(t => t.status === 'running').length === 0 && (
              <div className="text-slate-500 text-center py-8">No tasks currently running</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const StatCard = ({ title, value, subValue, icon, color = "text-white" }: { title: string, value: string, subValue: string, icon: React.ReactNode, color?: string }) => (
  <div className="bg-slate-900 p-6 rounded-xl border border-slate-800 shadow-sm">
    <div className="flex justify-between items-start mb-4">
      <h3 className="text-slate-400 text-sm font-medium">{title}</h3>
      {icon}
    </div>
    <p className={`text-4xl font-bold mb-2 ${color}`}>{value}</p>
    <p className="text-slate-500 text-xs">{subValue}</p>
  </div>
);
