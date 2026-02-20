import { definePluginManifest } from "@openTiger/plugin-sdk";

export const tigerResearchPluginManifestCore = definePluginManifest({
  id: "tiger-research",
  name: "TigerResearch",
  description: "Claim-evidence-convergence research workflow plugin",
  version: "0.1.0",
  pluginApiVersion: "1",
  taskKinds: ["research"],
  lanes: ["research"],
  dashboard: {
    entryPath: "/plugins/tiger-research",
  },
  db: {
    schemaNamespace: "tiger-research",
  },
});
