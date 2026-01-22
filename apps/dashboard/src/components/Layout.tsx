import React from 'react';
import { LayoutDashboard, ListTodo, Activity, Settings, ShieldCheck } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
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
            <NavItem icon={<LayoutDashboard size={20} />} label="Overview" active />
            <NavItem icon={<ListTodo size={20} />} label="Tasks" />
            <NavItem icon={<Activity size={20} />} label="Runs" />
            <NavItem icon={<ShieldCheck size={20} />} label="Agents" />
          </nav>
        </div>

        <div className="mt-auto p-6 border-t border-slate-800">
          <NavItem icon={<Settings size={20} />} label="Settings" />
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <header className="h-16 border-bottom border-slate-800 flex items-center justify-between px-8 bg-slate-950/50 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <span className="text-slate-400">System Status:</span>
            <span className="flex items-center gap-2 text-green-400 text-sm font-medium">
              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
              Healthy
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-xs text-slate-400">Daily Tokens</p>
              <p className="text-sm font-medium">1.2M / 5.0M</p>
            </div>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
};

const NavItem = ({ icon, label, active = false }: { icon: React.ReactNode, label: string, active?: boolean }) => (
  <a
    href="#"
    className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
      active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
    }`}
  >
    {icon}
    <span className="font-medium">{label}</span>
  </a>
);
