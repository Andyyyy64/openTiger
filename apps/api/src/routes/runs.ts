import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { db } from "@openTiger/db";
import { runs, artifacts } from "@openTiger/db/schema";
import { and, eq, sql, gte } from "drizzle-orm";
import { resolveOpenTigerLogDir } from "./log-dir";

export const runsRoute = new Hono();

const DEFAULT_LOG_DIR = resolve(import.meta.dirname, "../../../../raw-logs");

function resolveArtifactStorageRoot(): string {
  return resolveOpenTigerLogDir(DEFAULT_LOG_DIR);
}

function normalizeStoredArtifactPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    return null;
  }
  return normalized;
}

function isInsidePath(basePath: string, candidatePath: string): boolean {
  const normalizedBase = resolve(basePath);
  const normalizedCandidate = resolve(candidatePath);
  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(`${normalizedBase}/`) ||
    normalizedCandidate.startsWith(`${normalizedBase}\\`)
  );
}

function inferMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".bmp") {
    return "image/bmp";
  }
  if (extension === ".json") {
    return "application/json";
  }
  if (extension === ".txt" || extension === ".log") {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

// Get statistics
runsRoute.get("/stats", async (c) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Total tokens consumed today
  const result = await db
    .select({
      totalTokens: sql<number>`sum(COALESCE(${runs.costTokens}, 0))`,
    })
    .from(runs)
    .where(gte(runs.startedAt, today));

  return c.json({
    dailyTokens: Number(result[0]?.totalTokens ?? 0),
    tokenLimit: parseInt(process.env.DAILY_TOKEN_LIMIT ?? "-1", 10),
  });
});

// Get run history list
runsRoute.get("/", async (c) => {
  const taskId = c.req.query("taskId");
  const status = c.req.query("status");

  let query = db.select().from(runs);

  if (taskId) {
    query = query.where(eq(runs.taskId, taskId)) as typeof query;
  }
  if (status) {
    query = query.where(eq(runs.status, status)) as typeof query;
  }

  const result = await query;
  return c.json({ runs: result });
});

// Get run details
runsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");

  const runResult = await db.select().from(runs).where(eq(runs.id, id));

  const runData = runResult[0];
  if (!runData) {
    return c.json({ error: "Run not found" }, 404);
  }

  // Also fetch related artifacts
  const artifactResult = await db.select().from(artifacts).where(eq(artifacts.runId, id));

  // Retrieve log file contents
  let logContent: string | null = null;
  const logPath = runData.logPath;
  if (logPath) {
    try {
      const stats = await stat(logPath);
      // 1MB limit
      if (stats.size > 1024 * 1024) {
        // Could implement reading last 1MB, but for now handle with partial read
        const { open } = await import("node:fs/promises");
        const handle = await open(logPath, "r");
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, 1024 * 1024, stats.size - 1024 * 1024);
          logContent =
            "...(truncated, showing last 1MB)...\n" + buffer.toString("utf-8", 0, bytesRead);
        } finally {
          await handle.close();
        }
      } else {
        logContent = await readFile(logPath, "utf-8");
      }
    } catch (e) {
      console.warn(`[API] Failed to read log file at ${logPath}:`, e);
      logContent = `[System] Failed to read log file: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return c.json({
    run: { ...runData, logContent },
    artifacts: artifactResult,
  });
});

runsRoute.get("/:id/artifacts/:artifactId/content", async (c) => {
  const runId = c.req.param("id");
  const artifactId = c.req.param("artifactId");
  const [artifact] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.runId, runId)));

  if (!artifact) {
    return c.json({ error: "Artifact not found" }, 404);
  }

  const metadata =
    artifact.metadata && typeof artifact.metadata === "object"
      ? (artifact.metadata as Record<string, unknown>)
      : null;
  const storedPathRaw = metadata?.storedPath;
  const storedPath =
    typeof storedPathRaw === "string" ? normalizeStoredArtifactPath(storedPathRaw) : null;
  if (!storedPath) {
    return c.json({ error: "Artifact content is unavailable" }, 404);
  }

  const storageRoot = resolveArtifactStorageRoot();
  const filePath = resolve(storageRoot, storedPath);
  if (!isInsidePath(storageRoot, filePath)) {
    return c.json({ error: "Invalid artifact path" }, 400);
  }

  try {
    const [fileStat, content] = await Promise.all([stat(filePath), readFile(filePath)]);
    const contentType =
      typeof metadata?.mimeType === "string" && metadata.mimeType.trim().length > 0
        ? metadata.mimeType
        : inferMimeType(filePath);
    return c.body(content, 200, {
      "Content-Type": contentType,
      "Content-Length": String(fileStat.size),
      "Cache-Control": "no-store",
    });
  } catch {
    return c.json({ error: "Artifact file not found" }, 404);
  }
});

// Schema for start run request
const startRunSchema = z.object({
  taskId: z.string().uuid(),
  agentId: z.string(),
});

// Start run
runsRoute.post("/", zValidator("json", startRunSchema), async (c) => {
  const body = c.req.valid("json");

  const result = await db
    .insert(runs)
    .values({
      taskId: body.taskId,
      agentId: body.agentId,
      status: "running",
    })
    .returning();

  return c.json({ run: result[0] }, 201);
});

// Schema for complete run request
const completeRunSchema = z.object({
  status: z.enum(["success", "failed", "cancelled"]),
  costTokens: z.number().int().nonnegative().optional(),
  errorMessage: z.string().optional(),
});

// Complete run
runsRoute.patch("/:id", zValidator("json", completeRunSchema), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const result = await db
    .update(runs)
    .set({
      status: body.status,
      costTokens: body.costTokens,
      errorMessage: body.errorMessage,
      finishedAt: new Date(),
    })
    .where(eq(runs.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Run not found" }, 404);
  }

  return c.json({ run: result[0] });
});

// Cancel run
runsRoute.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");

  const result = await db
    .update(runs)
    .set({
      status: "cancelled",
      finishedAt: new Date(),
    })
    .where(eq(runs.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Run not found" }, 404);
  }

  return c.json({ run: result[0] });
});

// Schema for create artifact request
const createArtifactSchema = z.object({
  type: z.enum([
    "pr",
    "commit",
    "ci_result",
    "branch",
    "worktree",
    "base_repo_diff",
    "research_claim",
    "research_source",
    "research_report",
  ]),
  ref: z.string().optional(),
  url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Add artifact
runsRoute.post("/:id/artifacts", zValidator("json", createArtifactSchema), async (c) => {
  const runId = c.req.param("id");
  const body = c.req.valid("json");

  // Check if run exists
  const runResult = await db.select().from(runs).where(eq(runs.id, runId));
  if (runResult.length === 0) {
    return c.json({ error: "Run not found" }, 404);
  }

  const result = await db
    .insert(artifacts)
    .values({
      runId,
      type: body.type,
      ref: body.ref,
      url: body.url,
      metadata: body.metadata,
    })
    .returning();

  return c.json({ artifact: result[0] }, 201);
});
