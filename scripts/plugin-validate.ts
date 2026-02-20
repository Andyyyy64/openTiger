import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type PluginManifestLike = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  version?: unknown;
  pluginApiVersion?: unknown;
  taskKinds?: unknown;
  lanes?: unknown;
  requires?: unknown;
  worker?: unknown;
  db?: unknown;
};

type RegistryEntry = {
  manifestConstName: string;
  pluginId: string;
};

type ValidationResult = {
  pluginId: string;
  errors: string[];
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }
  return Array.from(duplicates);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function parsePluginRegistry(): Promise<RegistryEntry[]> {
  const registryPath = resolve(process.cwd(), "packages/plugin-sdk/src/plugin-registry.ts");
  const source = await readFile(registryPath, "utf-8");

  const importPattern =
    /import\s+\{\s*([A-Za-z0-9_]+)\s*\}\s+from\s+"(@openTiger\/plugin-([a-z0-9-]+))";/g;
  const importRows = new Map<string, RegistryEntry>();
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(source))) {
    const manifestConstName = match[1];
    const pluginId = match[3];
    if (!manifestConstName || !pluginId) {
      continue;
    }
    importRows.set(manifestConstName, {
      manifestConstName,
      pluginId,
    });
  }

  const arrayMatch = source.match(/PLUGIN_REGISTRY:\s*PluginManifestV1\[\]\s*=\s*\[([\s\S]*?)\];/m);
  if (!arrayMatch) {
    throw new Error("PLUGIN_REGISTRY array not found in plugin-registry.ts");
  }
  const arrayBody = arrayMatch[1] ?? "";
  const referencedConstNames = arrayBody
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const entries: RegistryEntry[] = [];
  for (const constName of referencedConstNames) {
    const entry = importRows.get(constName);
    if (!entry) {
      throw new Error(`Registry references ${constName}, but no matching import was found`);
    }
    entries.push(entry);
  }
  return entries;
}

async function loadManifest(entry: RegistryEntry): Promise<PluginManifestLike> {
  const modulePath = resolve(process.cwd(), "plugins", entry.pluginId, "src", "index.ts");
  const moduleUrl = pathToFileURL(modulePath).href;
  const moduleExports = (await import(moduleUrl)) as Record<string, unknown>;
  const manifest = moduleExports[entry.manifestConstName];
  if (!manifest) {
    throw new Error(
      `Export ${entry.manifestConstName} not found in plugins/${entry.pluginId}/src/index.ts`,
    );
  }
  if (!isRecord(manifest)) {
    throw new Error(`${entry.manifestConstName} is not an object`);
  }
  return manifest as PluginManifestLike;
}

async function validateManifest(
  entry: RegistryEntry,
  manifest: PluginManifestLike,
): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isNonEmptyString(manifest.id)) errors.push("manifest.id is required");
  if (!isNonEmptyString(manifest.name)) errors.push("manifest.name is required");
  if (!isNonEmptyString(manifest.description)) errors.push("manifest.description is required");
  if (!isNonEmptyString(manifest.version)) errors.push("manifest.version is required");
  if (!isNonEmptyString(manifest.pluginApiVersion)) {
    errors.push("manifest.pluginApiVersion is required");
  }

  const taskKinds = asStringArray(manifest.taskKinds);
  const lanes = asStringArray(manifest.lanes);
  const requires = asStringArray(manifest.requires);

  if (!Array.isArray(manifest.taskKinds)) {
    errors.push("manifest.taskKinds must be an array");
  } else if (taskKinds.length === 0) {
    warnings.push("manifest.taskKinds is empty");
  }

  if (!Array.isArray(manifest.lanes)) {
    errors.push("manifest.lanes must be an array");
  } else if (lanes.length === 0) {
    warnings.push("manifest.lanes is empty");
  }

  for (const duplicate of duplicateValues(taskKinds)) {
    errors.push(`manifest.taskKinds contains duplicate: ${duplicate}`);
  }
  for (const duplicate of duplicateValues(lanes)) {
    errors.push(`manifest.lanes contains duplicate: ${duplicate}`);
  }

  if (isRecord(manifest.worker)) {
    const workerTaskKind = manifest.worker.taskKind;
    if (isNonEmptyString(workerTaskKind) && !taskKinds.includes(workerTaskKind)) {
      errors.push(`worker.taskKind (${workerTaskKind}) is missing in manifest.taskKinds`);
    }
    const handlers = manifest.worker.taskKindHandlers;
    if (Array.isArray(handlers)) {
      for (const handler of handlers) {
        if (!isRecord(handler)) {
          errors.push("worker.taskKindHandlers contains a non-object item");
          continue;
        }
        const kind = handler.kind;
        if (!isNonEmptyString(kind)) {
          errors.push("worker.taskKindHandlers kind must be a non-empty string");
          continue;
        }
        if (!taskKinds.includes(kind)) {
          errors.push(`worker.taskKindHandlers kind (${kind}) is missing in manifest.taskKinds`);
        }
      }
    }
  }

  if (isRecord(manifest.db)) {
    const migrationDir = isNonEmptyString(manifest.db.migrationDir)
      ? manifest.db.migrationDir
      : entry.pluginId;
    const migrationPath = resolve(process.cwd(), "packages/db/src/plugin-migrations", migrationDir);
    if (!(await pathExists(migrationPath))) {
      errors.push(
        `db migration dir does not exist: packages/db/src/plugin-migrations/${migrationDir}`,
      );
    }
  }

  if (manifest.id !== entry.pluginId) {
    errors.push(
      `manifest.id (${String(manifest.id)}) does not match registry plugin id (${entry.pluginId})`,
    );
  }

  return {
    pluginId: entry.pluginId,
    errors,
    warnings,
  };
}

function checkDependencyCycles(manifestsById: Map<string, PluginManifestLike>): string[] {
  const errors: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (pluginId: string, stack: string[]): void => {
    if (visited.has(pluginId)) {
      return;
    }
    if (visiting.has(pluginId)) {
      errors.push(`dependency cycle detected: ${[...stack, pluginId].join(" -> ")}`);
      return;
    }

    visiting.add(pluginId);
    const manifest = manifestsById.get(pluginId);
    const requires = asStringArray(manifest?.requires);
    for (const dependencyId of requires) {
      if (!manifestsById.has(dependencyId)) {
        errors.push(`${pluginId} requires unknown plugin: ${dependencyId}`);
        continue;
      }
      visit(dependencyId, [...stack, pluginId]);
    }
    visiting.delete(pluginId);
    visited.add(pluginId);
  };

  for (const pluginId of manifestsById.keys()) {
    visit(pluginId, []);
  }

  return errors;
}

async function main(): Promise<void> {
  const registryEntries = await parsePluginRegistry();
  if (registryEntries.length === 0) {
    console.log("[plugin:validate] no registered plugins");
    return;
  }

  const loaded: Array<{ entry: RegistryEntry; manifest: PluginManifestLike }> = [];
  const results: ValidationResult[] = [];

  for (const entry of registryEntries) {
    try {
      const manifest = await loadManifest(entry);
      loaded.push({ entry, manifest });
      results.push(await validateManifest(entry, manifest));
    } catch (error) {
      results.push({
        pluginId: entry.pluginId,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
      });
    }
  }

  const manifestById = new Map<string, PluginManifestLike>();
  for (const item of loaded) {
    manifestById.set(item.entry.pluginId, item.manifest);
  }
  for (const dependencyError of checkDependencyCycles(manifestById)) {
    const target = results.find((result) => dependencyError.startsWith(`${result.pluginId} `));
    if (target) {
      target.errors.push(dependencyError);
      continue;
    }
    results.push({ pluginId: "unknown", errors: [dependencyError], warnings: [] });
  }

  const pluginsRoot = resolve(process.cwd(), "plugins");
  const pluginDirs = await readdir(pluginsRoot).catch(() => []);
  const registeredIds = new Set(registryEntries.map((entry) => entry.pluginId));
  for (const entry of pluginDirs) {
    const fullPath = resolve(pluginsRoot, entry);
    const entryStat = await stat(fullPath).catch(() => null);
    if (!entryStat?.isDirectory()) {
      continue;
    }
    if (registeredIds.has(entry)) {
      continue;
    }
    results.push({
      pluginId: entry,
      errors: [
        "plugin directory exists but is not registered in packages/plugin-sdk/src/plugin-registry.ts",
      ],
      warnings: [],
    });
  }

  let hasErrors = false;
  for (const result of results.sort((a, b) => a.pluginId.localeCompare(b.pluginId))) {
    const status = result.errors.length > 0 ? "failed" : "ok";
    console.log(`[plugin:validate] ${result.pluginId}: ${status}`);
    for (const warning of result.warnings) {
      console.log(`  - warning: ${warning}`);
    }
    for (const error of result.errors) {
      hasErrors = true;
      console.error(`  - error: ${error}`);
    }
  }

  if (hasErrors) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("plugin validation failed:", error);
  process.exit(1);
});
