import { db } from "@openTiger/db";
import { config as configTable } from "@openTiger/db/schema";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_CONFIG, buildConfigRecord } from "./system-config.js";

const LEGACY_REPLAN_COMMANDS = new Set([
  "",
  "pnpm --filter @openTiger/planner start",
  "pnpm --filter @sebastian-code/planner start",
]);

const DEFAULT_REPLAN_COMMAND = "pnpm --filter @openTiger/planner run start:fresh";

async function ensureConfigColumns(): Promise<void> {
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
}

function createLegacyNormalizationPatch(
  current: typeof configTable.$inferSelect
): Partial<typeof configTable.$inferInsert> | null {
  const shouldNormalizeReplanCommand = LEGACY_REPLAN_COMMANDS.has(
    (current.replanCommand ?? "").trim()
  );
  const shouldNormalizeMaxConcurrentWorkers = (current.maxConcurrentWorkers ?? "").trim() === "10";
  const shouldNormalizeDailyTokenLimit = (current.dailyTokenLimit ?? "").trim() === "50000000";
  const shouldNormalizeHourlyTokenLimit = (current.hourlyTokenLimit ?? "").trim() === "5000000";
  const shouldNormalizeTaskTokenLimit = (current.taskTokenLimit ?? "").trim() === "1000000";

  if (
    !shouldNormalizeReplanCommand
    && !shouldNormalizeMaxConcurrentWorkers
    && !shouldNormalizeDailyTokenLimit
    && !shouldNormalizeHourlyTokenLimit
    && !shouldNormalizeTaskTokenLimit
  ) {
    return null;
  }

  const patch: Partial<typeof configTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (shouldNormalizeReplanCommand) {
    patch.replanCommand = DEFAULT_REPLAN_COMMAND;
  }
  if (shouldNormalizeMaxConcurrentWorkers) {
    patch.maxConcurrentWorkers = "-1";
  }
  if (shouldNormalizeDailyTokenLimit) {
    patch.dailyTokenLimit = "-1";
  }
  if (shouldNormalizeHourlyTokenLimit) {
    patch.hourlyTokenLimit = "-1";
  }
  if (shouldNormalizeTaskTokenLimit) {
    patch.taskTokenLimit = "-1";
  }
  return patch;
}

export async function ensureConfigRow(): Promise<typeof configTable.$inferSelect> {
  await ensureConfigColumns();

  const existing = await db.select().from(configTable).limit(1);
  const current = existing[0];
  if (current) {
    const patch = createLegacyNormalizationPatch(current);
    if (!patch) {
      return current;
    }
    const [updated] = await db
      .update(configTable)
      .set(patch)
      .where(eq(configTable.id, current.id))
      .returning();
    return updated ?? current;
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

