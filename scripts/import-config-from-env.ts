import { resolve } from "node:path";
import dotenv from "dotenv";
import { db, closeDb } from "../packages/db/src/client.ts";
import { config as configTable } from "../packages/db/src/schema.ts";
import { eq, sql } from "drizzle-orm";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  buildConfigRecord,
  rowToConfig,
} from "../apps/api/src/system-config.ts";

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

async function main(): Promise<void> {
  const envPath = process.env.SEBASTIAN_ENV_PATH ?? resolve(process.cwd(), ".env");
  dotenv.config({ path: envPath });

  const updates: Record<string, string> = {};
  for (const key of CONFIG_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    console.log("[Config] 対象の設定が.envに見つかりませんでした。");
    return;
  }

  const configRow = await ensureConfigRow();
  const updateData = buildConfigRecord(updates);
  // .envの内容をDBのconfigに反映する
  const updated = await db
    .update(configTable)
    .set({ ...updateData, updatedAt: new Date() })
    .where(eq(configTable.id, configRow.id))
    .returning();

  const merged = rowToConfig(updated[0] ?? configRow);
  console.log("[Config] 移行完了:", {
    updatedKeys: Object.keys(updates),
    snapshot: merged,
  });
}

main()
  .catch((error) => {
    console.error("[Config] 移行に失敗しました:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
