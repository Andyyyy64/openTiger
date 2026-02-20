import React from "react";
import { Link } from "react-router-dom";
import { useEnabledDashboardPlugins } from "../plugins/registry";

export const PluginsPage: React.FC = () => {
  const dashboardPlugins = useEnabledDashboardPlugins();

  return (
    <div className="p-6 text-term-fg">
      <div className="mb-8">
        <h1 className="text-xl font-bold uppercase tracking-widest text-term-tiger font-pixel">
          &gt; Plugins
        </h1>
        <p className="text-xs text-zinc-500 mt-2">
          Select a plugin workflow implemented on top of openTiger orchestration.
        </p>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {dashboardPlugins.map((plugin) => (
          <Link
            key={plugin.id}
            to={plugin.entryPath}
            className="block border border-term-border p-4 hover:border-term-tiger transition-colors"
          >
            <div className="text-term-tiger uppercase text-xs mb-1">{plugin.id}</div>
            <div className="text-base font-bold">{plugin.name}</div>
            <div className="text-xs text-zinc-500 mt-2">{plugin.description}</div>
          </Link>
        ))}
      </section>
    </div>
  );
};
