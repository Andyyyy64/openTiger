import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db, closeDb } from "../packages/db/src/client.ts";
import { config as configTable } from "../packages/db/src/schema.ts";
import { sql } from "drizzle-orm";
import { CONFIG_KEYS, DEFAULT_CONFIG, buildConfigRecord, rowToConfig } from "../apps/api/src/system-config.ts";

async function ensureConfigRow() {
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_wait_on_quota" text DEFAULT 'true' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_quota_retry_delay_ms" text DEFAULT '30000' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_max_quota_waits" text DEFAULT '-1' NOT NULL`
  );

  const existing = await db.select().from(configTable).limit(1);
  const current = existing[0];
  if (current) {
    return current;
  }
  const created = await db
    .insert(configTable)
    .values(buildConfigRecord(DEFAULT_CONFIG, { includeDefaults: true }))
    .returning();
  const row = created[0];
  if (!row) {
    throw new Error("Failed to create config");
  }
  return row;
}

function encodeEnvValue(value: string): string {
  if (value.length === 0) {
    return "";
  }
  if (/[\s#"']/u.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function replaceConfigLines(
  source: string,
  values: Record<string, string>
): { content: string; updatedKeys: string[] } {
  const lines = source.length > 0 ? source.split(/\r?\n/) : [];
  const remaining = new Set(CONFIG_KEYS);
  const updatedKeys: string[] = [];

  const replaced = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    const key = match?.[1];
    if (!key || !remaining.has(key)) {
      return line;
    }

    remaining.delete(key);
    updatedKeys.push(key);
    return `${key}=${encodeEnvValue(values[key] ?? "")}`;
  });

  const missingKeys = CONFIG_KEYS.filter((key) => remaining.has(key));
  if (missingKeys.length > 0) {
    if (replaced.length > 0 && replaced[replaced.length - 1] !== "") {
      replaced.push("");
    }
    replaced.push("# --- sebastian-code config (synced from DB) ---");
    for (const key of missingKeys) {
      replaced.push(`${key}=${encodeEnvValue(values[key] ?? "")}`);
      updatedKeys.push(key);
    }
  }

  return {
    content: `${replaced.join("\n").replace(/\n+$/u, "")}\n`,
    updatedKeys,
  };
}

async function main(): Promise<void> {
  const envPath = process.env.SEBASTIAN_ENV_PATH ?? resolve(process.cwd(), ".env");
  const configRow = await ensureConfigRow();
  const snapshot = rowToConfig(configRow);

  let current = "";
  try {
    current = await readFile(envPath, "utf-8");
  } catch {
    current = "";
  }

  const { content, updatedKeys } = replaceConfigLines(current, snapshot);
  await writeFile(envPath, content, "utf-8");

  console.log("[Config] DB -> .env sync completed:", {
    path: envPath,
    updatedKeysCount: updatedKeys.length,
    updatedKeys,
  });
}

main()
  .catch((error) => {
    console.error("[Config] DB -> .env sync failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
