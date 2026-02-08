import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@openTiger/db";
import { config as configTable } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { CONFIG_KEYS, buildConfigRecord, rowToConfig } from "../system-config";
import { ensureConfigRow } from "../config-store";

export const configRoute = new Hono();

const ALLOWED_KEYS = new Set(CONFIG_KEYS);

const updateSchema = z.object({
  updates: z.record(z.string()),
});

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
