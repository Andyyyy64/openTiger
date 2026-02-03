import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const configRoute = new Hono();

const ALLOWED_KEYS = new Set([
  "SEBASTIAN_API_PORT",
  "SEBASTIAN_DASHBOARD_PORT",
  "SEBASTIAN_E2E_PORT",
  "MAX_CONCURRENT_WORKERS",
  "DAILY_TOKEN_LIMIT",
  "HOURLY_TOKEN_LIMIT",
  "TASK_TOKEN_LIMIT",
  "REPO_MODE",
  "LOCAL_REPO_PATH",
  "LOCAL_WORKTREE_ROOT",
  "JUDGE_MODE",
  "LOCAL_POLICY_MAX_LINES",
  "LOCAL_POLICY_MAX_FILES",
  "BASE_BRANCH",
  "OPENCODE_MODEL",
  "PLANNER_MODEL",
  "JUDGE_MODEL",
  "WORKER_MODEL",
  "PLANNER_USE_REMOTE",
  "PLANNER_REPO_URL",
  "SEBASTIAN_LOG_DIR",
  "AUTO_REPLAN",
  "REPLAN_REQUIREMENT_PATH",
  "REPLAN_INTERVAL_MS",
  "REPLAN_COMMAND",
  "REPLAN_WORKDIR",
  "REPLAN_REPO_URL",
]);

const updateSchema = z.object({
  updates: z.record(z.string()),
});

type EnvLine =
  | { type: "raw"; value: string }
  | { type: "pair"; key: string; value: string; raw: string };

function resolveEnvPath(): string {
  return process.env.SEBASTIAN_ENV_PATH ?? join(process.cwd(), ".env");
}

function parseEnvContent(content: string): { lines: EnvLine[]; values: Record<string, string> } {
  const lines: EnvLine[] = [];
  const values: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) {
      lines.push({ type: "raw", value: line });
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      lines.push({ type: "raw", value: line });
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    values[key] = value;
    lines.push({ type: "pair", key, value, raw: line });
  }

  return { lines, values };
}

function updateEnvLines(lines: EnvLine[], updates: Record<string, string>): EnvLine[] {
  const remaining = { ...updates };

  const updated = lines.map((line) => {
    if (line.type !== "pair") {
      return line;
    }

    if (!Object.prototype.hasOwnProperty.call(remaining, line.key)) {
      return line;
    }

    const nextValue = remaining[line.key] ?? "";
    delete remaining[line.key];
    return {
      ...line,
      value: nextValue,
      raw: `${line.key}=${nextValue}`,
    };
  });

  const additions = Object.entries(remaining).map(([key, value]) => ({
    type: "pair" as const,
    key,
    value,
    raw: `${key}=${value}`,
  }));

  return [...updated, ...additions];
}

function serializeEnvLines(lines: EnvLine[]): string {
  return lines
    .map((line) => (line.type === "pair" ? line.raw : line.value))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .concat("\n");
}

function pickAllowedValues(values: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ALLOWED_KEYS) {
    result[key] = values[key] ?? "";
  }
  return result;
}

configRoute.get("/", async (c) => {
  const envPath = resolveEnvPath();
  try {
    const content = await readFile(envPath, "utf-8");
    const parsed = parseEnvContent(content);
    return c.json({
      config: pickAllowedValues(parsed.values),
      envPath,
    });
  } catch (error) {
    console.warn("[Config] Failed to load env file:", error);
    return c.json({ error: "Config file not found" }, 404);
  }
});

configRoute.patch("/", zValidator("json", updateSchema), async (c) => {
  const envPath = resolveEnvPath();
  const body = c.req.valid("json");

  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.updates)) {
    if (!ALLOWED_KEYS.has(key)) {
      return c.json({ error: `Key not allowed: ${key}` }, 400);
    }
    updates[key] = value;
  }

  try {
    const content = await readFile(envPath, "utf-8");
    const parsed = parseEnvContent(content);
    const merged = updateEnvLines(parsed.lines, updates);
    const nextContent = serializeEnvLines(merged);
    await writeFile(envPath, nextContent, "utf-8");

    return c.json({
      config: pickAllowedValues({ ...parsed.values, ...updates }),
      requiresRestart: true,
    });
  } catch (error) {
    console.warn("[Config] Failed to update env file:", error);
    return c.json({ error: "Failed to update config" }, 500);
  }
});
