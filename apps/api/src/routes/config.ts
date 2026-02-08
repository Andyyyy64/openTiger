import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@openTiger/db";
import { config as configTable } from "@openTiger/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  buildConfigRecord,
  rowToConfig,
} from "../system-config.js";

export const configRoute = new Hono();

const ALLOWED_KEYS = new Set(CONFIG_KEYS);

const updateSchema = z.object({
  updates: z.record(z.string()),
});

async function ensureConfigRow() {
  // Self-repair required columns so system_config works even if migration history is corrupted
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_wait_on_quota" text DEFAULT 'true' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_quota_retry_delay_ms" text DEFAULT '30000' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "opencode_max_quota_waits" text DEFAULT '-1' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "judge_count" text DEFAULT '1' NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "config" ADD COLUMN IF NOT EXISTS "planner_count" text DEFAULT '1' NOT NULL`
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

configRoute.get("/", async (c) => {
  try {
    const configRow = await ensureConfigRow();
    return c.json({
      config: rowToConfig(configRow),
    });
  } catch (error) {
    console.warn("[Config] Failed to load config:", error);
    return c.json({ error: "Config not found" }, 404);
  }
});

configRoute.patch("/", zValidator("json", updateSchema), async (c) => {
  const body = c.req.valid("json");

  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.updates)) {
    if (!ALLOWED_KEYS.has(key)) {
      return c.json({ error: `Key not allowed: ${key}` }, 400);
    }
    updates[key] = value;
  }

  try {
    const configRow = await ensureConfigRow();
    const updateData = buildConfigRecord(updates);
    const updated = await db
      .update(configTable)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(configTable.id, configRow.id))
      .returning();

    return c.json({
      config: rowToConfig(updated[0] ?? configRow),
      requiresRestart: false,
    });
  } catch (error) {
    console.warn("[Config] Failed to update config:", error);
    return c.json({ error: "Failed to update config" }, 500);
  }
});
