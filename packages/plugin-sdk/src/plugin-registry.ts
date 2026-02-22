import type { PluginManifestV1 } from "./manifest";

// Provisional registry for lazy-resolving plugin implementations.
// Dynamically loaded at runtime.
const plugins = new Map<string, PluginManifestV1>();

export function registerPlugin(plugin: PluginManifestV1): void {
  plugins.set(plugin.id, plugin);
}

export function getRegisteredPlugins(): PluginManifestV1[] {
  return Array.from(plugins.values());
}
