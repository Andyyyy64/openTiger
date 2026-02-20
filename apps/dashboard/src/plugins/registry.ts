import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "../lib/api";
import type { DashboardPlugin } from "./types";

type DashboardPluginModule = {
  dashboardPlugin?: DashboardPlugin;
  tigerResearchPlugin?: DashboardPlugin;
};

const pluginModules = import.meta.glob<DashboardPluginModule>("./*.tsx", { eager: true });
const discoveredPlugins = (Object.values(pluginModules) as DashboardPluginModule[])
  .map((module) => module.dashboardPlugin ?? module.tigerResearchPlugin)
  .filter((plugin): plugin is DashboardPlugin => Boolean(plugin));

export function useEnabledDashboardPlugins(): DashboardPlugin[] {
  const { data: pluginInventory } = useQuery({
    queryKey: ["plugins", "inventory"],
    queryFn: () => pluginsApi.list(),
    refetchInterval: 10000,
  });

  return useMemo(() => {
    if (!pluginInventory) {
      return discoveredPlugins;
    }
    const enabledIds = new Set(
      pluginInventory.filter((plugin) => plugin.status === "enabled").map((plugin) => plugin.id),
    );
    return discoveredPlugins.filter((plugin) => enabledIds.has(plugin.id));
  }, [pluginInventory]);
}
