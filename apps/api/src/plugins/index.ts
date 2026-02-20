import type { Hono } from "hono";
import type { ApiPlugin } from "./types";
import { loadPlugins, registerPlugin } from "@openTiger/plugin-sdk";
import { tigerResearchApiPlugin } from "./tiger-research";
import { tigerResearchPluginManifest } from "@openTiger/plugin-tiger-research";

registerPlugin(tigerResearchPluginManifest);

const pluginResult = loadPlugins({
  enabledPluginsCsv: process.env.ENABLED_PLUGINS,
});

const registeredApiPlugins: ApiPlugin[] = [tigerResearchApiPlugin];
const apiPluginById = new Map(registeredApiPlugins.map((plugin) => [plugin.id, plugin]));

export const apiPlugins: ApiPlugin[] = pluginResult.enabledPlugins
  .filter((plugin) => Boolean(plugin.api))
  .map((plugin) => apiPluginById.get(plugin.id))
  .filter((plugin): plugin is ApiPlugin => Boolean(plugin));

export function registerApiPlugins(app: Hono): void {
  for (const plugin of apiPlugins) {
    plugin.registerRoutes(app);
  }
}

export function listApiPlugins(): Array<{
  id: string;
  name: string;
  description: string;
  version: string;
  pluginApiVersion: string;
  status: "enabled" | "disabled" | "incompatible" | "error";
  capabilities: string[];
  reason?: string;
}> {
  return pluginResult.inventory;
}
