import { tigerResearchWorkerPlugin } from "./tiger-research";
import type { WorkerTaskKindPlugin } from "./types";
import { loadPlugins, registerPlugin } from "@openTiger/plugin-sdk";
import { tigerResearchPluginManifest } from "@openTiger/plugin-tiger-research";

registerPlugin(tigerResearchPluginManifest);

const pluginResult = loadPlugins({
  enabledPluginsCsv: process.env.ENABLED_PLUGINS,
});
const enabledWorkerPluginIds = new Set(
  pluginResult.enabledPlugins.filter((plugin) => Boolean(plugin.worker)).map((plugin) => plugin.id),
);

const registeredTaskKindPlugins: WorkerTaskKindPlugin[] = [tigerResearchWorkerPlugin];
const taskKindPlugins = new Map<string, WorkerTaskKindPlugin>(
  registeredTaskKindPlugins
    .filter((plugin) => enabledWorkerPluginIds.has(plugin.id))
    .map((plugin) => [plugin.kind, plugin]),
);

export function resolveWorkerTaskKindPlugin(kind: string): WorkerTaskKindPlugin | undefined {
  return taskKindPlugins.get(kind);
}
