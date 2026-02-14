import type { Hono } from "hono";
import type { ApiPlugin } from "./types";
import { tigerResearchApiPlugin } from "./tiger-research";

export const apiPlugins: ApiPlugin[] = [tigerResearchApiPlugin];

export function registerApiPlugins(app: Hono): void {
  for (const plugin of apiPlugins) {
    plugin.registerRoutes(app);
  }
}

export function listApiPlugins(): Array<Pick<ApiPlugin, "id" | "name" | "description">> {
  return apiPlugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
  }));
}
