import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@openTiger/db";
import { config as configTable } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { CONFIG_KEYS, buildConfigRecord, rowToConfig } from "../system-config";
import { ensureConfigRow } from "../config-store";

export const configRoute = new Hono();

const ALLOWED_KEYS = new Set(CONFIG_KEYS);

const updateSchema = z.object({
  updates: z.record(z.string()),
});

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function resolveRequirementPathCandidate(
  rawRequirementPath: string,
  rawWorkdir: string,
): Promise<{ found: boolean; resolvedPath: string }> {
  const requirementPath = rawRequirementPath.trim();
  const workdir = resolve(rawWorkdir.trim());

  if (isAbsolute(requirementPath)) {
    return {
      found: await pathExists(requirementPath),
      resolvedPath: requirementPath,
    };
  }

  let currentDir = workdir;
  while (true) {
    const candidate = resolve(currentDir, requirementPath);
    if (await pathExists(candidate)) {
      return { found: true, resolvedPath: candidate };
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return {
    found: false,
    resolvedPath: resolve(workdir, requirementPath),
  };
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
    const currentConfig = rowToConfig(configRow);
    const nextConfig = { ...currentConfig, ...updates };

    const autoReplanEnabled = parseBoolean(nextConfig.AUTO_REPLAN, true);
    if (autoReplanEnabled && !nextConfig.REPLAN_REQUIREMENT_PATH?.trim()) {
      return c.json({ error: "REPLAN_REQUIREMENT_PATH is required when AUTO_REPLAN is true" }, 400);
    }

    const warnings: string[] = [];
    if (autoReplanEnabled) {
      const requirementPath = nextConfig.REPLAN_REQUIREMENT_PATH?.trim();
      const repoMode = nextConfig.REPO_MODE?.trim().toLowerCase();
      const localRepoPath = nextConfig.LOCAL_REPO_PATH?.trim();
      const replanWorkdir =
        nextConfig.REPLAN_WORKDIR?.trim() ||
        (repoMode === "local" && localRepoPath ? localRepoPath : process.cwd());
      if (requirementPath) {
        const candidate = await resolveRequirementPathCandidate(requirementPath, replanWorkdir);
        if (!candidate.found) {
          warnings.push(
            `Replan requirement file not found: ${requirementPath} (resolved candidate: ${candidate.resolvedPath})`,
          );
        }
      }
    }

    const updateData = buildConfigRecord(updates);
    const updated = await db
      .update(configTable)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(configTable.id, configRow.id))
      .returning();

    return c.json({
      config: rowToConfig(updated[0] ?? configRow),
      requiresRestart: false,
      warnings,
    });
  } catch (error) {
    console.warn("[Config] Failed to update config:", error);
    return c.json({ error: "Failed to update config" }, 500);
  }
});
