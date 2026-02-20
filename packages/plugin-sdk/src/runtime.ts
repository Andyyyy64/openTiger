import { getRegisteredPlugins } from "./plugin-registry";
import { loadPlugins } from "./loader";

const CORE_TASK_KINDS = ["code"] as const;
const CORE_TASK_LANES = ["feature", "conflict_recovery", "docser"] as const;

export type PluginRuntimeRegistry = {
  enabledPluginIds: Set<string>;
  allowedTaskKinds: Set<string>;
  allowedTaskLanes: Set<string>;
  defaultLaneByTaskKind: Map<string, string>;
  pluginInventory: ReturnType<typeof loadPlugins>["inventory"];
};

export function buildPluginRuntimeRegistry(enabledPluginsCsv?: string): PluginRuntimeRegistry {
  const loadResult = loadPlugins({
    manifests: getRegisteredPlugins(),
    enabledPluginsCsv,
  });

  const allowedTaskKinds = new Set<string>(CORE_TASK_KINDS);
  const allowedTaskLanes = new Set<string>(CORE_TASK_LANES);
  const defaultLaneByTaskKind = new Map<string, string>([["code", "feature"]]);
  for (const plugin of loadResult.enabledPlugins) {
    for (const kind of plugin.taskKinds) {
      allowedTaskKinds.add(kind);
      const pluginDefaultLane = plugin.lanes[0];
      if (pluginDefaultLane) {
        defaultLaneByTaskKind.set(kind, pluginDefaultLane);
      }
    }
    for (const lane of plugin.lanes) {
      allowedTaskLanes.add(lane);
    }
  }

  return {
    enabledPluginIds: loadResult.enabledPluginIds,
    allowedTaskKinds,
    allowedTaskLanes,
    defaultLaneByTaskKind,
    pluginInventory: loadResult.inventory,
  };
}
