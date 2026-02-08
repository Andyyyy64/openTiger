import { resolve } from "node:path";
import dotenv from "dotenv";
import { db, closeDb } from "../packages/db/src/client.ts";
import { config as configTable } from "../packages/db/src/schema.ts";
import { eq } from "drizzle-orm";
import { CONFIG_KEYS, buildConfigRecord, rowToConfig } from "../apps/api/src/system-config.ts";
import { ensureConfigRow } from "../apps/api/src/config-store.ts";

async function main(): Promise<void> {
  const envPath = process.env.OPENTIGER_ENV_PATH ?? resolve(process.cwd(), ".env");
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
