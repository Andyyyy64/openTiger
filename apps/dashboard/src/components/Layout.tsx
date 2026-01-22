import React from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, ListTodo, Activity, Settings, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { systemApi, runsApi } from '../lib/api';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { data: health, isError: isHealthError } = useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => systemApi.health(),
    refetchInterval: 30000, // 30秒ごとにチェック
    retry: 1,
  });

  const { data: stats } = useQuery({
    queryKey: ['runs', 'stats'],
    queryFn: () => runsApi.stats(),
    refetchInterval: 60000, // 1分ごとに更新
  });

  const isHealthy = health?.status === 'ok' && !isHealthError;

  return (
    <div className="flex h-screen bg-slate-950 text-slate-50">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800 flex flex-col">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-8 h-8 bg-yellow-500 rounded-lg flex items-center justify-center">
              <span className="text-slate-950 font-bold">h1</span>
            </div>
            <span className="text-xl font-bold tracking-tight">h1ve</span>
          </div>

          <nav className="space-y-1">
            <NavItem to="/" icon={<LayoutDashboard size={20} />} label="Overview" />
            <NavItem to="/tasks" icon={<ListTodo size={20} />} label="Tasks" />
            <NavItem to="/runs" icon={<Activity size={20} />} label="Runs" />
            <NavItem to="/agents" icon={<ShieldCheck size={20} />} label="Agents" />
          </nav>
        </div>

        <div className="mt-auto p-6 border-t border-slate-800">
          <NavItem to="/settings" icon={<Settings size={20} />} label="Settings" />
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-8 bg-slate-950/50 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <span className="text-slate-400">System Status:</span>
            {isHealthy ? (
              <span className="flex items-center gap-2 text-green-400 text-sm font-medium">
                <Wifi size={16} />
                Healthy
              </span>
            ) : (
              <span className="flex items-center gap-2 text-red-400 text-sm font-medium">
                <WifiOff size={16} />
                Disconnected
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-xs text-slate-400">Daily Tokens</p>
              <p className="text-sm font-medium">
                {stats ? `${(stats.dailyTokens / 1000000).toFixed(1)}M` : '0.0M'} / 
                {stats ? `${(stats.tokenLimit / 1000000).toFixed(1)}M` : '5.0M'}
              </p>
            </div>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
};

const NavItem = ({ to, icon, label }: { to: string, icon: React.ReactNode, label: string }) => (
  <NavLink
    to={to}
    className={({ isActive }) => 
      `flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
        isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
      }`
    }
  >
    {icon}
    <span className="font-medium">{label}</span>
  </NavLink>
);
