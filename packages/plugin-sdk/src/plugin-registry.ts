import type { PluginManifestV1 } from "./manifest";

// 暫定的にpluginの実装を遅延解決するためのRegistry。
// 実行環境で動的に読み込まれる
const plugins = new Map<string, PluginManifestV1>();

export function registerPlugin(plugin: PluginManifestV1): void {
  plugins.set(plugin.id, plugin);
}

export function getRegisteredPlugins(): PluginManifestV1[] {
  return Array.from(plugins.values());
}
