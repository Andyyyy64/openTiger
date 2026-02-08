import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@openTiger/db";
import { tasks, runs } from "@openTiger/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CreateTaskInput } from "@openTiger/core";

export const tasksRoute = new Hono();

type FailureCategory = "env" | "setup" | "policy" | "test" | "flaky" | "model" | "model_loop";

type RetryInfo = {
  autoRetry: boolean;
  reason:
    | "cooldown_pending"
    | "retry_due"
    | "retry_exhausted"
    | "non_retryable_failure"
    | "awaiting_judge"
    | "quota_wait"
    | "needs_rework"
    | "unknown";
  retryAt: string | null;
  retryInSeconds: number | null;
  cooldownMs: number | null;
  retryCount: number;
  retryLimit: number;
  failureCategory?: FailureCategory;
};

const FAILED_TASK_RETRY_COOLDOWN_MS = Number.parseInt(
  process.env.FAILED_TASK_RETRY_COOLDOWN_MS ?? "30000",
  10,
);
const BLOCKED_TASK_RETRY_COOLDOWN_MS = Number.parseInt(
  process.env.BLOCKED_TASK_RETRY_COOLDOWN_MS ?? "120000",
  10,
);
const MAX_RETRY_COUNT = Number.parseInt(process.env.FAILED_TASK_MAX_RETRY_COUNT ?? "-1", 10);

const CATEGORY_RETRY_LIMIT: Record<FailureCategory, number> = {
  env: 10,
  setup: 10,
  policy: 10,
  test: 10,
  flaky: 10,
  model: 6,
  model_loop: 2,
};

function normalizeRetryLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return -1;
  }
  return limit;
}

function isRetryExhausted(retryCount: number, retryLimit: number): boolean {
  if (retryLimit < 0) {
    return false;
  }
  return retryCount >= retryLimit;
}

function resolveCategoryRetryLimit(category: FailureCategory, retryLimit: number): number {
  if (retryLimit < 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.min(CATEGORY_RETRY_LIMIT[category], retryLimit);
}

function classifyFailure(errorMessage: string | null): {
  category: FailureCategory;
  retryable: boolean;
} {
  const message = (errorMessage ?? "").toLowerCase();

  if (/policy violation|denied command|outside allowed paths|change to denied path/.test(message)) {
    return { category: "policy", retryable: true };
  }

  if (
    /package\.json|pnpm-workspace\.yaml|cannot find module|enoent|command not found|repository not found|authentication failed|permission denied|no commits between|no history in common/.test(
      message,
    )
  ) {
    return { category: "setup", retryable: true };
  }

  if (/database_url|redis_url|connection refused|dns|env/.test(message)) {
    return { category: "env", retryable: true };
  }

  if (/vitest|playwright|assert|expected|test failed|verification commands failed/.test(message)) {
    return { category: "test", retryable: true };
  }

  if (
    /rate limit|429|503|502|timeout|timed out|econnreset|eai_again|temporarily unavailable/.test(
      message,
    )
  ) {
    return { category: "flaky", retryable: true };
  }

  if (
    /doom loop detected|excessive planning chatter detected|unsupported pseudo tool call detected: todo/.test(
      message,
    )
  ) {
    return { category: "model_loop", retryable: true };
  }

  return { category: "model", retryable: true };
}

function buildRetryInfo(
  task: typeof tasks.$inferSelect,
  latestFailureMessage?: string | null,
): RetryInfo | null {
  if (task.status !== "failed" && task.status !== "blocked") {
    return null;
  }

  const now = Date.now();
  const retryLimit = normalizeRetryLimit(MAX_RETRY_COUNT);
  const retryCount = task.retryCount ?? 0;

  if (task.status === "blocked") {
    const retryAtMs = new Date(task.updatedAt).getTime() + BLOCKED_TASK_RETRY_COOLDOWN_MS;
    const retryInSeconds = Math.max(0, Math.ceil((retryAtMs - now) / 1000));
    // legacy互換: needs_human は awaiting_judge 扱いに統一
    const normalizedBlockReason =
      task.blockReason === "needs_human" ? "awaiting_judge" : task.blockReason;
    return {
      autoRetry: true,
      reason:
        normalizedBlockReason === "awaiting_judge"
          ? "awaiting_judge"
          : normalizedBlockReason === "quota_wait"
            ? "quota_wait"
            : normalizedBlockReason === "needs_rework"
              ? "needs_rework"
              : retryInSeconds > 0
                ? "cooldown_pending"
                : "retry_due",
      retryAt: new Date(retryAtMs).toISOString(),
      retryInSeconds,
      cooldownMs: BLOCKED_TASK_RETRY_COOLDOWN_MS,
      retryCount,
      retryLimit,
    };
  }

  // 上限到達でも復旧を止めないため、再作業として扱う
  if (isRetryExhausted(retryCount, retryLimit)) {
    const retryAtMs = new Date(task.updatedAt).getTime() + FAILED_TASK_RETRY_COOLDOWN_MS;
    const retryInSeconds = Math.max(0, Math.ceil((retryAtMs - now) / 1000));
    return {
      autoRetry: true,
      reason: "needs_rework",
      retryAt: new Date(retryAtMs).toISOString(),
      retryInSeconds,
      cooldownMs: FAILED_TASK_RETRY_COOLDOWN_MS,
      retryCount,
      retryLimit,
    };
  }

  const failure = classifyFailure(latestFailureMessage ?? null);
  const categoryRetryLimit = resolveCategoryRetryLimit(failure.category, retryLimit);

  // 非リトライ判定も再作業へ切り替えて継続する
  if (!failure.retryable || retryCount >= categoryRetryLimit) {
    const retryAtMs = new Date(task.updatedAt).getTime() + FAILED_TASK_RETRY_COOLDOWN_MS;
    const retryInSeconds = Math.max(0, Math.ceil((retryAtMs - now) / 1000));
    return {
      autoRetry: true,
      reason: "needs_rework",
      retryAt: new Date(retryAtMs).toISOString(),
      retryInSeconds,
      cooldownMs: FAILED_TASK_RETRY_COOLDOWN_MS,
      retryCount,
      retryLimit: retryLimit < 0 ? -1 : categoryRetryLimit,
      failureCategory: failure.category,
    };
  }

  const retryAtMs = new Date(task.updatedAt).getTime() + FAILED_TASK_RETRY_COOLDOWN_MS;
  const retryInSeconds = Math.max(0, Math.ceil((retryAtMs - now) / 1000));
  return {
    autoRetry: true,
    reason: retryInSeconds > 0 ? "cooldown_pending" : "retry_due",
    retryAt: new Date(retryAtMs).toISOString(),
    retryInSeconds,
    cooldownMs: FAILED_TASK_RETRY_COOLDOWN_MS,
    retryCount,
    retryLimit: retryLimit < 0 ? -1 : categoryRetryLimit,
    failureCategory: failure.category,
  };
}

async function enrichTasksWithRetryInfo(taskRows: (typeof tasks.$inferSelect)[]) {
  const failedTaskIds = taskRows.filter((task) => task.status === "failed").map((task) => task.id);

  const latestFailureByTaskId = new Map<string, string | null>();
  if (failedTaskIds.length > 0) {
    const runRows = await db
      .select({
        taskId: runs.taskId,
        errorMessage: runs.errorMessage,
      })
      .from(runs)
      .where(
        and(inArray(runs.taskId, failedTaskIds), inArray(runs.status, ["failed", "cancelled"])),
      )
      .orderBy(desc(runs.startedAt));

    for (const row of runRows) {
      if (!latestFailureByTaskId.has(row.taskId)) {
        latestFailureByTaskId.set(row.taskId, row.errorMessage);
      }
    }
  }

  return taskRows.map((task) => ({
    ...task,
    retry: buildRetryInfo(task, latestFailureByTaskId.get(task.id)),
  }));
}

// Get task list
tasksRoute.get("/", async (c) => {
  const status = c.req.query("status");

  let query = db.select().from(tasks);

  if (status) {
    query = query.where(eq(tasks.status, status)) as typeof query;
  }

  const result = await query;
  const enriched = await enrichTasksWithRetryInfo(result);
  return c.json({ tasks: enriched });
});

// Get task details
tasksRoute.get("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await db.select().from(tasks).where(eq(tasks.id, id));

  if (result.length === 0) {
    return c.json({ error: "Task not found" }, 404);
  }

  const [enriched] = await enrichTasksWithRetryInfo(result);
  return c.json({ task: enriched });
});

// Task creation request schema
const createTaskSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  context: z
    .object({
      files: z.array(z.string()).optional(),
      specs: z.string().optional(),
      notes: z.string().optional(),
      issue: z
        .object({
          number: z.number().int(),
          url: z.string().url().optional(),
          title: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  allowedPaths: z.array(z.string()),
  commands: z.array(z.string()),
  priority: z.number().int().optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  role: z.enum(["worker", "tester", "docser"]).optional(),
  dependencies: z.array(z.string().uuid()).optional(),
  timeboxMinutes: z.number().int().positive().optional(),
});

// Create task
tasksRoute.post("/", zValidator("json", createTaskSchema), async (c) => {
  const body = c.req.valid("json");

  const result = await db
    .insert(tasks)
    .values({
      title: body.title,
      goal: body.goal,
      context: body.context,
      allowedPaths: body.allowedPaths,
      commands: body.commands,
      priority: body.priority ?? 0,
      riskLevel: body.riskLevel ?? "low",
      role: body.role ?? "worker",
      dependencies: body.dependencies ?? [],
      timeboxMinutes: body.timeboxMinutes ?? 60,
    })
    .returning();

  return c.json({ task: result[0] }, 201);
});

// Task update request schema
const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  context: z
    .object({
      files: z.array(z.string()).optional(),
      specs: z.string().optional(),
      notes: z.string().optional(),
      issue: z
        .object({
          number: z.number().int(),
          url: z.string().url().optional(),
          title: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  allowedPaths: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  role: z.enum(["worker", "tester", "docser"]).optional(),
  status: z.enum(["queued", "running", "done", "failed", "blocked", "cancelled"]).optional(),
  blockReason: z.string().optional(),
  dependencies: z.array(z.string().uuid()).optional(),
  timeboxMinutes: z.number().int().positive().optional(),
});

// Update task
tasksRoute.patch("/:id", zValidator("json", updateTaskSchema), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const result = await db
    .update(tasks)
    .set({
      ...body,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({ task: result[0] });
});

// Delete task
tasksRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await db.delete(tasks).where(eq(tasks.id, id)).returning();

  if (result.length === 0) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({ deleted: true });
});
