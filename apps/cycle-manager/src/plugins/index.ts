import { loadPlugins, registerPlugin } from "@openTiger/plugin-sdk";
import { tigerResearchPluginManifest } from "@openTiger/plugin-tiger-research";

registerPlugin(tigerResearchPluginManifest);

type CycleHookEntry = {
  id: string;
  hook: NonNullable<ReturnType<typeof loadPlugins>["enabledPlugins"][number]["cycleManager"]>;
};

const pluginResult = loadPlugins({
  enabledPluginsCsv: process.env.ENABLED_PLUGINS,
});
const cycleHooks = pluginResult.enabledPlugins
  .map((plugin) => ({ id: plugin.id, hook: plugin.cycleManager }))
  .filter((entry): entry is CycleHookEntry => Boolean(entry.hook));

export async function runCycleManagerPluginMonitorTicks(): Promise<void> {
  for (const entry of cycleHooks) {
    if (!entry.hook.runMonitorTick) {
      continue;
    }
    await entry.hook.runMonitorTick();
  }
}

export async function hasCycleManagerPluginBacklog(): Promise<boolean> {
  for (const entry of cycleHooks) {
    if (!entry.hook.hasBacklog) {
      continue;
    }
    if (await entry.hook.hasBacklog()) {
      return true;
    }
  }
  return false;
}
