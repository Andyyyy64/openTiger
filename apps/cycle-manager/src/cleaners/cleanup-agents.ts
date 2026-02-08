import { db } from "@openTiger/db";
import { agents } from "@openTiger/db/schema";
import { and, eq, inArray, lt, not } from "drizzle-orm";
import { SYSTEM_ENTITY_ID } from "@openTiger/core";
import { recordEvent } from "../monitors/event-logger.js";

// オフラインエージェントをリセット
export async function resetOfflineAgents(): Promise<number> {
  // ハートビートが一定時間ない（10分以上）エージェントを検出
  const threshold = new Date(Date.now() - 10 * 60 * 1000);

  const offlineAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        not(eq(agents.status, "offline")),
        lt(agents.lastHeartbeat, threshold)
      )
    );

  if (offlineAgents.length === 0) {
    return 0;
  }

  const agentIds = offlineAgents.map((a) => a.id);
  await db
    .update(agents)
    .set({ status: "offline", currentTaskId: null })
    .where(inArray(agents.id, agentIds));

  for (const agent of offlineAgents) {
    await recordEvent({
      type: "agent.offline",
      entityType: "agent",
      entityId: SYSTEM_ENTITY_ID,
      agentId: agent.id,
      payload: { agentId: agent.id, reason: "heartbeat_timeout" },
    });
  }

  return offlineAgents.length;
}
