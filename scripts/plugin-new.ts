import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function normalizePluginId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toManifestConstName(pluginId: string): string {
  const camel = pluginId.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return `${camel}PluginManifest`;
}

async function updatePluginRegistry(pluginId: string): Promise<void> {
  const registryPath = resolve(process.cwd(), "packages/plugin-sdk/src/plugin-registry.ts");
  const packageName = `@openTiger/plugin-${pluginId}`;
  const manifestConstName = toManifestConstName(pluginId);
  const importLine = `import { ${manifestConstName} } from "${packageName}";`;

  let source = await readFile(registryPath, "utf-8");
  if (source.includes(packageName)) {
    return;
  }

  const firstExportIndex = source.indexOf("export const PLUGIN_REGISTRY");
  if (firstExportIndex <= 0) {
    throw new Error("plugin-registry.ts has unsupported format");
  }
  const importBlock = source.slice(0, firstExportIndex).trimEnd();
  const rest = source.slice(firstExportIndex);
  source = `${importBlock}\n${importLine}\n\n${rest}`;

  const registryArrayPattern = /PLUGIN_REGISTRY:\s*PluginManifestV1\[\]\s*=\s*\[([\s\S]*?)\];/m;
  const match = registryArrayPattern.exec(source);
  if (!match) {
    throw new Error("PLUGIN_REGISTRY array not found");
  }
  const currentEntries = match[1] ?? "";
  const trimmedEntries = currentEntries.trim();
  const nextEntries =
    trimmedEntries.length > 0
      ? `${trimmedEntries}\n  ${manifestConstName},`
      : `${manifestConstName},`;

  source = source.replace(
    registryArrayPattern,
    `PLUGIN_REGISTRY: PluginManifestV1[] = [\n  ${nextEntries}\n];`,
  );
  await writeFile(registryPath, source);
}

async function main(): Promise<void> {
  const rawName = process.argv[2];
  if (!rawName) {
    console.error("Usage: pnpm plugin:new <plugin-id>");
    process.exit(1);
  }
  const pluginId = normalizePluginId(rawName);
  if (!pluginId) {
    console.error("Plugin id is empty after normalization.");
    process.exit(1);
  }

  const pluginRoot = resolve(process.cwd(), "plugins", pluginId);
  const srcRoot = resolve(pluginRoot, "src");

  await mkdir(srcRoot, { recursive: true });

  const packageJson = {
    name: `@openTiger/plugin-${pluginId}`,
    version: "0.1.0",
    private: true,
    type: "module",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    scripts: {
      build: "tsup",
      dev: "tsc --watch",
      lint: "oxlint .",
      "lint:ci": "tsc --noEmit",
      typecheck: "tsc --noEmit",
      clean: "rm -rf dist",
    },
    devDependencies: {
      typescript: "^5.7.3",
    },
  };

  const tsconfig = {
    extends: "../../tsconfig.base.json",
    compilerOptions: {
      outDir: "./dist",
      rootDir: "./src",
    },
    include: ["src/**/*"],
    exclude: ["node_modules", "dist", "test"],
  };

  const tsupConfig = `import { createNodeConfig } from "../../tsup.config.base";

export default createNodeConfig({
  entry: ["src/index.ts"],
  dts: true,
  externalizeDeps: true,
});
`;

  const manifestConstName = toManifestConstName(pluginId);
  const indexTs = `export const ${manifestConstName} = {
  id: "${pluginId}",
  name: "${pluginId}",
  description: "TODO: plugin description",
  version: "0.1.0",
  pluginApiVersion: "1",
  taskKinds: [],
  lanes: [],
} as const;
`;

  await writeFile(resolve(pluginRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(resolve(pluginRoot, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  await writeFile(resolve(pluginRoot, "tsup.config.ts"), tsupConfig);
  await writeFile(resolve(srcRoot, "index.ts"), indexTs);
  await updatePluginRegistry(pluginId);

  console.log(`Created plugin scaffold: plugins/${pluginId}`);
  console.log(`Updated plugin registry: packages/plugin-sdk/src/plugin-registry.ts`);
}

main().catch((error) => {
  console.error("Failed to create plugin scaffold:", error);
  process.exit(1);
});
