import { checkPluginCompatibility, type PluginInventoryItem } from "./compat";
import { getManifestCapabilities, type PluginManifestV1 } from "./manifest";
import { getRegisteredPlugins } from "./plugin-registry";

type LoaderOptions = {
  manifests?: PluginManifestV1[];
  enabledPluginsCsv?: string;
  supportedPluginApiVersion?: string;
};

export type PluginLoadResult = {
  inventory: PluginInventoryItem[];
  enabledPlugins: PluginManifestV1[];
  enabledPluginIds: Set<string>;
};

function parseEnabledPlugins(enabledPluginsCsv: string | undefined): Set<string> | null {
  if (!enabledPluginsCsv || enabledPluginsCsv.trim().length === 0) {
    return null;
  }
  const ids = enabledPluginsCsv
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return new Set(ids);
}

function topologicalSort(
  manifests: PluginManifestV1[],
  enabledManifestById: Map<string, PluginManifestV1>,
): { sorted: PluginManifestV1[]; errors: Map<string, string> } {
  const sorted: PluginManifestV1[] = [];
  const errors = new Map<string, string>();
  const permanent = new Set<string>();
  const temporary = new Set<string>();

  const visit = (plugin: PluginManifestV1, path: string[]): void => {
    if (errors.has(plugin.id) || permanent.has(plugin.id)) {
      return;
    }
    if (temporary.has(plugin.id)) {
      errors.set(plugin.id, `dependency cycle detected: ${[...path, plugin.id].join(" -> ")}`);
      return;
    }
    temporary.add(plugin.id);
    const requires = plugin.requires ?? [];
    for (const dependencyId of requires) {
      const dependency = enabledManifestById.get(dependencyId);
      if (!dependency) {
        errors.set(plugin.id, `missing required enabled plugin: ${dependencyId}`);
        continue;
      }
      visit(dependency, [...path, plugin.id]);
      if (errors.has(dependency.id)) {
        errors.set(plugin.id, `dependency ${dependency.id} is invalid`);
      }
    }
    temporary.delete(plugin.id);
    permanent.add(plugin.id);
    if (!errors.has(plugin.id)) {
      sorted.push(plugin);
    }
  };

  for (const plugin of manifests) {
    visit(plugin, []);
  }
  return { sorted, errors };
}

export function loadPlugins(options: LoaderOptions): PluginLoadResult {
  const supportedPluginApiVersion = options.supportedPluginApiVersion ?? "1";
  const enabledFilter = parseEnabledPlugins(options.enabledPluginsCsv);
  const manifests = options.manifests ?? getRegisteredPlugins();
  const inventory: PluginInventoryItem[] = [];
  const enabledCandidates: PluginManifestV1[] = [];
  const allManifestById = new Map<string, PluginManifestV1>();

  for (const manifest of manifests) {
    if (allManifestById.has(manifest.id)) {
      inventory.push({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        pluginApiVersion: manifest.pluginApiVersion,
        status: "error",
        capabilities: getManifestCapabilities(manifest),
        reason: `duplicate plugin id: ${manifest.id}`,
      });
      continue;
    }
    allManifestById.set(manifest.id, manifest);

    const isRequested = enabledFilter ? enabledFilter.has(manifest.id) : true;
    if (!isRequested) {
      inventory.push({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        pluginApiVersion: manifest.pluginApiVersion,
        status: "disabled",
        capabilities: getManifestCapabilities(manifest),
      });
      continue;
    }

    const compatibility = checkPluginCompatibility(manifest, supportedPluginApiVersion);
    if (!compatibility.compatible) {
      inventory.push({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        pluginApiVersion: manifest.pluginApiVersion,
        status: "incompatible",
        capabilities: getManifestCapabilities(manifest),
        reason: compatibility.reason,
      });
      continue;
    }
    enabledCandidates.push(manifest);
  }

  const enabledManifestById = new Map(enabledCandidates.map((plugin) => [plugin.id, plugin]));
  if (enabledFilter) {
    for (const requestedId of enabledFilter) {
      if (allManifestById.has(requestedId)) {
        continue;
      }
      inventory.push({
        id: requestedId,
        name: requestedId,
        description: "Unknown plugin id",
        version: "unknown",
        pluginApiVersion: supportedPluginApiVersion,
        status: "error",
        capabilities: [],
        reason: `requested plugin is not registered: ${requestedId}`,
      });
    }
  }

  const { sorted, errors } = topologicalSort(enabledCandidates, enabledManifestById);
  for (const manifest of enabledCandidates) {
    const dependencyError = errors.get(manifest.id);
    if (dependencyError) {
      inventory.push({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        pluginApiVersion: manifest.pluginApiVersion,
        status: "error",
        capabilities: getManifestCapabilities(manifest),
        reason: dependencyError,
      });
      continue;
    }
    inventory.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      pluginApiVersion: manifest.pluginApiVersion,
      status: "enabled",
      capabilities: getManifestCapabilities(manifest),
    });
  }

  const enabledPlugins = sorted.filter((plugin) => !errors.has(plugin.id));
  const enabledPluginIds = new Set(enabledPlugins.map((plugin) => plugin.id));
  return {
    inventory: inventory.sort((a, b) => a.id.localeCompare(b.id)),
    enabledPlugins,
    enabledPluginIds,
  };
}
