import { Hono } from "hono";
import { db } from "@openTiger/db";
import { events, tasks } from "@openTiger/db/schema";
import { desc, eq, inArray } from "drizzle-orm";

export const plansRoute = new Hono();

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = value ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 100);
}

plansRoute.get("/", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 20);
  const rows = await db
    .select({
      id: events.id,
      createdAt: events.createdAt,
      agentId: events.agentId,
      payload: events.payload,
    })
    .from(events)
    .where(eq(events.type, "planner.plan_created"))
    .orderBy(desc(events.createdAt))
    .limit(limit);

  const plans = await Promise.all(
    rows.map(async (row) => {
      const payload = row.payload as Record<string, unknown> | null;
      const taskIds = Array.isArray(payload?.taskIds)
        ? payload?.taskIds.filter((id): id is string => typeof id === "string")
        : [];

      // Reorder tasks to match order recorded by Planner
      let taskRows: Array<{
        id: string;
        title: string;
        status: string;
        riskLevel: string;
        role: string;
        priority: number;
        createdAt: Date;
        dependencies: string[];
      }> = [];

      if (taskIds.length > 0) {
        const rows = await db
          .select({
            id: tasks.id,
            title: tasks.title,
            status: tasks.status,
            riskLevel: tasks.riskLevel,
            role: tasks.role,
            priority: tasks.priority,
            createdAt: tasks.createdAt,
            dependencies: tasks.dependencies,
          })
          .from(tasks)
          .where(inArray(tasks.id, taskIds));

        const byId = new Map(rows.map((task) => [task.id, task]));
        taskRows = taskIds
          .map((id) => byId.get(id))
          .filter((task): task is NonNullable<typeof task> => typeof task !== "undefined");
      }

      return {
        id: row.id,
        createdAt: row.createdAt,
        agentId: row.agentId,
        requirement: (payload?.requirement as Record<string, unknown>) ?? {},
        summary: (payload?.summary as Record<string, unknown>) ?? {},
        taskIds,
        tasks: taskRows,
      };
    }),
  );

  return c.json({ plans });
});
