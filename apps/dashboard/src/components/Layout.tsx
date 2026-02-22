import React, { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { systemApi, runsApi } from "../lib/api";
import { useEnabledDashboardPlugins } from "../plugins/registry";

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const dashboardPlugins = useEnabledDashboardPlugins();
  const { data: health, isError: isHealthError } = useQuery({
    queryKey: ["system", "health"],
    queryFn: () => systemApi.health(),
    refetchInterval: 30000,
    retry: 1,
  });

  const { data: stats } = useQuery({
    queryKey: ["runs", "stats"],
    queryFn: () => runsApi.stats(),
    refetchInterval: 60000,
  });

  const isHealthy = health?.status === "ok" && !isHealthError;
  const pluginSubItems = dashboardPlugins.flatMap((plugin) => plugin.navItems);

  return (
    <div className="flex flex-col h-screen font-pixel text-term-fg bg-term-bg overflow-hidden">
      {/* Top Status Bar like a window title or terminal header */}
      <header className="h-10 border-b border-term-border flex items-center justify-between px-4 bg-term-bg shrink-0 select-none">
        <div className="flex items-center gap-4">
          <span className="font-bold text-term-tiger font-pixel text-lg">
            root@openTiger:~/dashboard
          </span>
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
              {stats ? `${(stats.dailyTokens / 1000000).toFixed(1)}M` : "0.0M"}
              <span className="text-zinc-600">/</span>
              {stats ? `${(stats.tokenLimit / 1000000).toFixed(1)}M` : "5.0M"}
            </span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r border-term-border flex flex-col pt-4 pb-4">
          <div className="px-4 mb-4 text-xs text-zinc-500 select-none">EXPLORER</div>
          <nav className="flex-1 overflow-y-auto font-pixel text-sm">
            <div className="px-2 space-y-px">
              <NavItem to="/overview" label="overview" />
              <NavItem to="/chat" label="start" />
              <NavItem to="/tasks" label="tasks" />
              <NavItem to="/runs" label="runs" />
              <NavCollapsible
                parentTo="/agents"
                parentLabel="agents"
                subItems={[
                  { to: "/plans", label: "plans" },
                  { to: "/judgements", label: "judgements" },
                ]}
              />
              <NavItem to="/logs" label="logs" />
              <NavCollapsible parentTo="/plugins" parentLabel="plugins" subItems={pluginSubItems} />
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
          <div className="min-h-full">{children}</div>
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

const NavItem = ({ to, label }: { to: string; label: string }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `block px-3 py-1.5 transition-colors duration-0 ${
        isActive
          ? "bg-term-tiger text-black font-bold"
          : "text-zinc-400 hover:text-term-tiger hover:translate-x-1"
      }`
    }
  >
    <div className="flex item-center">
      <span className="mr-2 opacity-50">{">"}</span>
      <span>{label}</span>
    </div>
  </NavLink>
);

interface NavCollapsibleProps {
  parentTo: string;
  parentLabel: string;
  subItems: { to: string; label: string }[];
}

const NavCollapsible: React.FC<NavCollapsibleProps> = ({ parentTo, parentLabel, subItems }) => {
  const location = useLocation();
  const relatedPaths = [parentTo, ...subItems.map((s) => s.to)];
  const isRelatedRoute = relatedPaths.some(
    (path) => location.pathname === path || location.pathname.startsWith(`${path}/`),
  );
  const [expanded, setExpanded] = useState(isRelatedRoute);

  React.useEffect(() => {
    setExpanded(isRelatedRoute);
  }, [isRelatedRoute]);

  return (
    <div className="space-y-px">
      <div className="flex items-center">
        <button
          type="button"
          className="shrink-0 w-6 h-8 flex items-center justify-center opacity-50 hover:opacity-100 cursor-pointer bg-transparent border-0 text-zinc-400 hover:text-term-tiger"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "\u25BC" : ">"}
        </button>
        <NavLink
          to={parentTo}
          end
          className={({ isActive }) =>
            `flex-1 block px-1 py-1.5 transition-colors duration-0 ${
              isActive
                ? "bg-term-tiger text-black font-bold"
                : "text-zinc-400 hover:text-term-tiger hover:translate-x-1"
            }`
          }
        >
          {parentLabel}
        </NavLink>
      </div>
      {expanded && (
        <div className="pl-5">
          {subItems.map((item) => (
            <NavItem key={item.to} to={item.to} label={item.label} />
          ))}
        </div>
      )}
    </div>
  );
};
