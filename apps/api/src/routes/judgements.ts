import { Hono } from "hono";
import { db } from "@h1ve/db";
import { events } from "@h1ve/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

export const judgementsRoute = new Hono();

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = value ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 200);
}

judgementsRoute.get("/", async (c) => {
  const taskId = c.req.query("taskId");
  const runId = c.req.query("runId");
  const verdict = c.req.query("verdict");
  const limit = parseLimit(c.req.query("limit"), 50);

  const conditions = [eq(events.type, "judge.review")];
  if (taskId) {
    conditions.push(eq(events.entityId, taskId));
  }
  if (runId) {
    conditions.push(sql`${events.payload} ->> 'runId' = ${runId}`);
  }
  if (verdict) {
    conditions.push(sql`${events.payload} ->> 'verdict' = ${verdict}`);
  }

  const rows = await db
    .select({
      id: events.id,
      createdAt: events.createdAt,
      agentId: events.agentId,
      entityId: events.entityId,
      payload: events.payload,
    })
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.createdAt))
    .limit(limit);

  // UI側で詳細を組み立てられるようpayloadをそのまま返す
  const judgements = rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    agentId: row.agentId,
    taskId: row.entityId,
    payload: row.payload,
  }));

  return c.json({ judgements });
});
