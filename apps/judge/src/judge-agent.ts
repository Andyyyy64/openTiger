import { db } from "@openTiger/db";
import { agents } from "@openTiger/db/schema";
import { eq, sql } from "drizzle-orm";

const HEARTBEAT_INTERVAL = 30000;

export async function startHeartbeat(agentId: string): Promise<NodeJS.Timeout> {
  return setInterval(async () => {
    try {
      await db
        .update(agents)
        .set({
          lastHeartbeat: new Date(),
          // Allow auto-recovery when heartbeat arrives even after offline
          status: sql`CASE WHEN ${agents.status} = 'offline' THEN 'idle' ELSE ${agents.status} END`,
        })
        .where(eq(agents.id, agentId));
    } catch (error) {
      console.error(`[Heartbeat] Failed to send heartbeat for ${agentId}:`, error);
    }
  }, HEARTBEAT_INTERVAL);
}

export async function setJudgeAgentState(
  agentId: string,
  status: "idle" | "busy",
  currentTaskId: string | null = null,
): Promise<void> {
  await db
    .update(agents)
    .set({
      status,
      currentTaskId,
      lastHeartbeat: new Date(),
    })
    .where(eq(agents.id, agentId));
}

export async function safeSetJudgeAgentState(
  agentId: string,
  status: "idle" | "busy",
  currentTaskId: string | null = null,
): Promise<void> {
  try {
    await setJudgeAgentState(agentId, status, currentTaskId);
  } catch (error) {
    console.error(`[Judge] Failed to update agent state (${status})`, error);
  }
}
