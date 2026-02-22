import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@openTiger/db";
import { agents } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";

export const agentsRoute = new Hono();

// Get agent list
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

// Get agent details
agentsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await db.select().from(agents).where(eq(agents.id, id));

  if (result.length === 0) {
    return c.json({ error: "Agent not found" }, 404);
  }

  return c.json({ agent: result[0] });
});

// Schema for agent registration request
const registerAgentSchema = z.object({
  id: z.string(),
  role: z.enum(["planner", "worker", "judge", "tester"]),
  metadata: z
    .object({
      model: z.string().optional(),
      provider: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
});

// Register agent
agentsRoute.post("/", zValidator("json", registerAgentSchema), async (c) => {
  const body = c.req.valid("json");

  // Check for existing agent
  const existing = await db.select().from(agents).where(eq(agents.id, body.id));

  if (existing.length > 0) {
    // Update if exists
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

  // New registration
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

// Heartbeat update schema
const heartbeatSchema = z.object({
  status: z.enum(["idle", "busy", "offline"]).optional(),
  currentTaskId: z.string().uuid().nullable().optional(),
});

// Update heartbeat
agentsRoute.post("/:id/heartbeat", zValidator("json", heartbeatSchema), async (c) => {
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
});

// Delete agent
agentsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");

  const result = await db.delete(agents).where(eq(agents.id, id)).returning();

  if (result.length === 0) {
    return c.json({ error: "Agent not found" }, 404);
  }

  return c.json({ deleted: true });
});
