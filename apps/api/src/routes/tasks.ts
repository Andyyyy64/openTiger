import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@sebastian-code/db";
import { tasks } from "@sebastian-code/db/schema";
import { eq } from "drizzle-orm";
import { CreateTaskInput } from "@sebastian-code/core";

export const tasksRoute = new Hono();

// タスク一覧取得
tasksRoute.get("/", async (c) => {
  const status = c.req.query("status");

  let query = db.select().from(tasks);

  if (status) {
    query = query.where(eq(tasks.status, status)) as typeof query;
  }

  const result = await query;
  return c.json({ tasks: result });
});

// タスク詳細取得
tasksRoute.get("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await db.select().from(tasks).where(eq(tasks.id, id));

  if (result.length === 0) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({ task: result[0] });
});

// タスク作成リクエストのスキーマ
const createTaskSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  context: z
    .object({
      files: z.array(z.string()).optional(),
      specs: z.string().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  allowedPaths: z.array(z.string()),
  commands: z.array(z.string()),
  priority: z.number().int().optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  role: z.enum(["worker", "tester"]).optional(),
  dependencies: z.array(z.string().uuid()).optional(),
  timeboxMinutes: z.number().int().positive().optional(),
});

// タスク作成
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

// タスク更新リクエストのスキーマ
const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  context: z
    .object({
      files: z.array(z.string()).optional(),
      specs: z.string().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  allowedPaths: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  role: z.enum(["worker", "tester"]).optional(),
  status: z
    .enum(["queued", "running", "done", "failed", "blocked", "cancelled"])
    .optional(),
  dependencies: z.array(z.string().uuid()).optional(),
  timeboxMinutes: z.number().int().positive().optional(),
});

// タスク更新
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

// タスク削除
tasksRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await db.delete(tasks).where(eq(tasks.id, id)).returning();

  if (result.length === 0) {
    return c.json({ error: "Task not found" }, 404);
  }

  return c.json({ deleted: true });
});
