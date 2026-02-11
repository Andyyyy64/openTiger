import { db } from "@openTiger/db";
import { events, runs } from "@openTiger/db/schema";
import { eq, and, gte, lte, sql, count, sum } from "drizzle-orm";

// Event record input type
interface EventInput {
  type: string;
  entityType: string;
  entityId: string;
  agentId?: string;
  payload?: Record<string, unknown>;
}

// Record event
export async function recordEvent(input: EventInput): Promise<string> {
  const [event] = await db
    .insert(events)
    .values({
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId,
      payload: input.payload,
    })
    .returning({ id: events.id });

  if (!event) {
    throw new Error("Failed to record event");
  }

  return event.id;
}

// Get events in time range
export async function getEventsByTimeRange(
  startTime: Date,
  endTime: Date,
  eventType?: string,
): Promise<Array<typeof events.$inferSelect>> {
  const conditions = [gte(events.createdAt, startTime), lte(events.createdAt, endTime)];

  if (eventType) {
    conditions.push(eq(events.type, eventType));
  }

  return db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(sql`${events.createdAt} DESC`);
}

// Aggregate events by type
export async function getEventCountsByType(
  startTime: Date,
  endTime?: Date,
): Promise<Record<string, number>> {
  const conditions = [gte(events.createdAt, startTime)];
  if (endTime) {
    conditions.push(lte(events.createdAt, endTime));
  }

  const result = await db
    .select({
      type: events.type,
      count: count(),
    })
    .from(events)
    .where(and(...conditions))
    .groupBy(events.type);

  const counts: Record<string, number> = {};
  for (const row of result) {
    counts[row.type] = row.count;
  }
  return counts;
}

// Cost aggregation (token usage)
export async function getCostSummary(
  startTime: Date,
  endTime?: Date,
): Promise<{
  totalTokens: number;
  runsCount: number;
  averageTokensPerRun: number;
}> {
  const conditions = [gte(runs.startedAt, startTime)];
  if (endTime) {
    conditions.push(lte(runs.startedAt, endTime));
  }

  const [result] = await db
    .select({
      totalTokens: sum(runs.costTokens),
      runsCount: count(),
    })
    .from(runs)
    .where(and(...conditions));

  const totalTokens = Number(result?.totalTokens) || 0;
  const runsCount = result?.runsCount || 0;
  const averageTokensPerRun = runsCount > 0 ? totalTokens / runsCount : 0;

  return {
    totalTokens,
    runsCount,
    averageTokensPerRun,
  };
}

// Daily cost summary
export async function getDailyCostSummary(days: number = 7): Promise<
  Array<{
    date: string;
    totalTokens: number;
    runsCount: number;
  }>
> {
  const startTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result = await db
    .select({
      date: sql<string>`DATE(${runs.startedAt})`,
      totalTokens: sum(runs.costTokens),
      runsCount: count(),
    })
    .from(runs)
    .where(gte(runs.startedAt, startTime))
    .groupBy(sql`DATE(${runs.startedAt})`)
    .orderBy(sql`DATE(${runs.startedAt})`);

  return result.map((row) => ({
    date: row.date,
    totalTokens: Number(row.totalTokens) || 0,
    runsCount: row.runsCount,
  }));
}

// Log cycle event
export async function logCycleEvent(
  cycleId: string,
  eventType: string,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await recordEvent({
    type: `cycle.${eventType}`,
    entityType: "cycle",
    entityId: cycleId,
    payload: { message, ...details },
  });

  console.log(`[Cycle:${cycleId.substring(0, 8)}] ${eventType}: ${message}`);
}
