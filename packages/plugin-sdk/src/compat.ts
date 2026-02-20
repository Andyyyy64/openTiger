import type { PluginManifestV1 } from "./manifest";

export type PluginStatus = "enabled" | "disabled" | "incompatible" | "error";

export type PluginInventoryItem = {
  id: string;
  name: string;
  description: string;
  version: string;
  pluginApiVersion: string;
  status: PluginStatus;
  capabilities: string[];
  reason?: string;
};

export type CompatibilityResult = {
  compatible: boolean;
  reason?: string;
};

export function checkPluginCompatibility(
  manifest: PluginManifestV1,
  supportedPluginApiVersion: string,
): CompatibilityResult {
  if (manifest.pluginApiVersion !== supportedPluginApiVersion) {
    return {
      compatible: false,
      reason:
        `pluginApiVersion mismatch: plugin=${manifest.pluginApiVersion}, ` +
        `core=${supportedPluginApiVersion}`,
    };
  }
  return { compatible: true };
}
