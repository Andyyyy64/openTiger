export type PluginMigrationEntry = {
  id: string;
  requires?: string[];
  migrationDir: string;
};

export const pluginMigrationRegistry: PluginMigrationEntry[] = [
  {
    id: "tiger-research",
    migrationDir: "tiger-research",
  },
];
