import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { pluginMigrationRegistry, type PluginMigrationEntry } from "./registry";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://opentiger:opentiger@localhost:5432/opentiger";

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

function sortPluginsWithDependencies(entries: PluginMigrationEntry[]): PluginMigrationEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const sorted: PluginMigrationEntry[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (entry: PluginMigrationEntry): void => {
    if (visited.has(entry.id)) {
      return;
    }
    if (visiting.has(entry.id)) {
      throw new Error(`Plugin migration dependency cycle detected at ${entry.id}`);
    }
    visiting.add(entry.id);
    for (const dependencyId of entry.requires ?? []) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(`Missing plugin migration dependency: ${dependencyId}`);
      }
      visit(dependency);
    }
    visiting.delete(entry.id);
    visited.add(entry.id);
    sorted.push(entry);
  };

  for (const entry of entries) {
    visit(entry);
  }
  return sorted;
}

async function ensureStateTable(sql: postgres.Sql<{}>): Promise<void> {
  await sql.unsafe(`
    create table if not exists plugin_migration_history (
      plugin_id text not null,
      migration_name text not null,
      applied_at timestamptz not null default now(),
      primary key (plugin_id, migration_name)
    )
  `);
}

async function runPluginMigrations(): Promise<void> {
  const sql = postgres(connectionString);
  try {
    await ensureStateTable(sql);

    const enabledFilter = parseEnabledPlugins(process.env.ENABLED_PLUGINS);
    const candidates = pluginMigrationRegistry.filter((entry) =>
      enabledFilter ? enabledFilter.has(entry.id) : true,
    );
    const ordered = sortPluginsWithDependencies(candidates);
    if (ordered.length === 0) {
      console.log("[plugin-migrate] No enabled plugin migrations.");
      return;
    }

    const appliedRows = await sql<{ plugin_id: string; migration_name: string }[]>`
      select plugin_id, migration_name from plugin_migration_history
    `;
    const applied = new Set(appliedRows.map((row) => `${row.plugin_id}:${row.migration_name}`));

    for (const entry of ordered) {
      const migrationRoot = resolve(import.meta.dirname, entry.migrationDir);
      let migrationFiles: string[] = [];
      try {
        migrationFiles = (await readdir(migrationRoot))
          .filter((fileName) => fileName.endsWith(".sql"))
          .sort((a, b) => a.localeCompare(b));
      } catch {
        console.log(
          `[plugin-migrate] Skip ${entry.id}: migration dir not found (${migrationRoot})`,
        );
        continue;
      }

      for (const fileName of migrationFiles) {
        const migrationKey = `${entry.id}:${fileName}`;
        if (applied.has(migrationKey)) {
          continue;
        }
        const sqlText = await readFile(resolve(migrationRoot, fileName), "utf-8");
        if (sqlText.trim().length > 0) {
          await sql.unsafe(sqlText);
        }
        await sql.unsafe(
          `insert into plugin_migration_history (plugin_id, migration_name) values (${toSqlLiteral(entry.id)}, ${toSqlLiteral(fileName)})`,
        );
        console.log(`[plugin-migrate] Applied ${migrationKey}`);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function toSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

runPluginMigrations().catch((error) => {
  console.error("[plugin-migrate] Failed:", error);
  process.exitCode = 1;
});
