import React from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { systemApi, runsApi } from '../lib/api';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { data: health, isError: isHealthError } = useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => systemApi.health(),
    refetchInterval: 30000,
    retry: 1,
  });

  const { data: stats } = useQuery({
    queryKey: ['runs', 'stats'],
    queryFn: () => runsApi.stats(),
    refetchInterval: 60000,
  });

  const isHealthy = health?.status === 'ok' && !isHealthError;

  return (
    <div className="flex flex-col h-screen font-pixel text-term-fg bg-term-bg overflow-hidden">
      {/* Top Status Bar like a window title or terminal header */}
      <header className="h-10 border-b border-term-border flex items-center justify-between px-4 bg-term-bg shrink-0 select-none">
        <div className="flex items-center gap-4">
          <span className="font-bold text-term-tiger font-pixel text-lg">root@openTiger:~/dashboard</span>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">[STATUS]</span>
            {isHealthy ? (
              <span className="text-term-tiger">ONLINE</span>
            ) : (
              <span className="text-red-500 animate-pulse">OFFLINE</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">[TOKENS]</span>
            <span>
              {stats ? `${(stats.dailyTokens / 1000000).toFixed(1)}M` : '0.0M'}
              <span className="text-zinc-600">/</span>
              {stats ? `${(stats.tokenLimit / 1000000).toFixed(1)}M` : '5.0M'}
            </span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r border-term-border flex flex-col pt-4 pb-4">
          <div className="px-4 mb-4 text-xs text-zinc-500 select-none">
            EXPLORER
          </div>
          <nav className="flex-1 overflow-y-auto font-pixel text-sm">
            <div className="px-2 space-y-px">
              <NavItem to="/" label="overview" />
              <NavItem to="/start" label="start" />
              <NavItem to="/tasks" label="tasks" />
              <NavItem to="/runs" label="runs" />
              <NavItem to="/agents" label="agents" />
              <NavItem to="/plans" label="plans" />
              <NavItem to="/judgements" label="judgements" />
              <NavItem to="/logs" label="logs" />
            </div>
          </nav>

          <div className="px-2 mb-2">
            <div className="h-px bg-term-border mx-3 my-2 opacity-50" />
            <NavItem to="/system" label="system_config" />
          </div>

          <div className="px-4">
            <div className="border-t border-term-border pt-4 text-[10px] text-zinc-600">
              <p>OPENTIGER v0.1.0</p>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto bg-term-bg relative">
          <div className="min-h-full">
            {children}
          </div>
        </main>
      </div>

      {/* Bottom Status Line (Optional Decor) */}
      <div className="h-6 border-t border-term-border bg-black flex items-center px-4 text-[10px] text-zinc-500 gap-4 shrink-0 select-none">
        <span>MODE: COMMAND</span>
        <span className="flex-1"></span>
        <span>UTF-8</span>
        <span>Ln 1, Col 1</span>
      </div>
    </div>
  );
};

const NavItem = ({ to, label }: { to: string, label: string }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `block px-3 py-1.5 transition-colors duration-0 ${isActive
        ? 'bg-term-tiger text-black font-bold'
        : 'text-zinc-400 hover:text-term-tiger hover:translate-x-1'
      }`
    }
  >
    <div className="flex item-center">
      <span className="mr-2 opacity-50">{'>'}</span>
      <span>{label}</span>
      {/* Blinking cursor only shown when strictly simpler design or on hover used to be cool but maybe distracting */}
    </div>
  </NavLink>
);
