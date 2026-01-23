import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@h1ve/db";
import { agents } from "@h1ve/db/schema";
import { eq } from "drizzle-orm";

export const agentsRoute = new Hono();

// エージェント一覧取得
agentsRoute.get("/", async (c) => {
  const role = c.req.query("role");
  const status = c.req.query("status");

  let query = db.select().from(agents);

  if (role) {
    query = query.where(eq(agents.role, role)) as typeof query;
  }
  if (status) {
    query = query.where(eq(agents.status, status)) as typeof query;
  }

  const result = await query;
  return c.json({ agents: result });
});

// エージェント詳細取得
agentsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await db.select().from(agents).where(eq(agents.id, id));

  if (result.length === 0) {
    return c.json({ error: "Agent not found" }, 404);
  }

  return c.json({ agent: result[0] });
});

// エージェント登録リクエストのスキーマ
const registerAgentSchema = z.object({
  id: z.string(),
  role: z.enum(["planner", "worker", "judge"]),
    metadata: z
      .object({
        model: z.string().optional(),
        provider: z.string().optional(),
        version: z.string().optional(),
      })
      .optional(),
});

// エージェント登録
agentsRoute.post("/", zValidator("json", registerAgentSchema), async (c) => {
  const body = c.req.valid("json");

  // 既存エージェントの確認
  const existing = await db
    .select()
    .from(agents)
    .where(eq(agents.id, body.id));

  if (existing.length > 0) {
    // 既存なら更新
    const result = await db
      .update(agents)
      .set({
        role: body.role,
        status: "idle",
        lastHeartbeat: new Date(),
        metadata: body.metadata,
      })
      .where(eq(agents.id, body.id))
      .returning();

    return c.json({ agent: result[0] });
  }

  // 新規登録
  const result = await db
    .insert(agents)
    .values({
      id: body.id,
      role: body.role,
      status: "idle",
      lastHeartbeat: new Date(),
      metadata: body.metadata,
    })
    .returning();

  return c.json({ agent: result[0] }, 201);
});

// ハートビート更新スキーマ
const heartbeatSchema = z.object({
  status: z.enum(["idle", "busy", "offline"]).optional(),
  currentTaskId: z.string().uuid().nullable().optional(),
});

// ハートビート更新
agentsRoute.post(
  "/:id/heartbeat",
  zValidator("json", heartbeatSchema),
  async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const result = await db
      .update(agents)
      .set({
        status: body.status,
        currentTaskId: body.currentTaskId,
        lastHeartbeat: new Date(),
      })
      .where(eq(agents.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Agent not found" }, 404);
    }

    return c.json({ agent: result[0] });
  }
);

// エージェント削除
agentsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await db.delete(agents).where(eq(agents.id, id)).returning();

  if (result.length === 0) {
    return c.json({ error: "Agent not found" }, 404);
  }

  return c.json({ deleted: true });
});
