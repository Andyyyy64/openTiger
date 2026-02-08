import { db } from "@openTiger/db";
import { agents, leases, tasks } from "@openTiger/db/schema";
import { eq, lt, and, inArray } from "drizzle-orm";

// ハートビート設定
const HEARTBEAT_TIMEOUT_SECONDS = 60; // Offline if no response for 60 seconds or more
const CHECK_INTERVAL_MS = 30000; // 30秒ごとにチェック

// エージェントの健全性状態
export interface AgentHealth {
  id: string;
  role: string;
  status: string;
  lastHeartbeat: Date | null;
  isHealthy: boolean;
  currentTaskId: string | null;
}

// エージェントの健全性をチェック
export async function checkAgentHealth(agentId: string): Promise<AgentHealth | null> {
  const result = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId));

  if (result.length === 0) {
    return null;
  }

  const agent = result[0];
  if (!agent) {
    return null;
  }

  const now = new Date();
  const lastHeartbeat = agent.lastHeartbeat;
  
  // Check if heartbeat is recent
  const isHealthy = lastHeartbeat 
    ? (now.getTime() - lastHeartbeat.getTime()) < HEARTBEAT_TIMEOUT_SECONDS * 1000
    : false;

  // Get leases held by agent
  const agentLeases = await db
    .select()
    .from(leases)
    .where(eq(leases.agentId, agentId));

  const firstLease = agentLeases[0];
  return {
    id: agent.id,
    role: agent.role,
    status: agent.status ?? "unknown",
    lastHeartbeat,
    isHealthy,
    currentTaskId: firstLease?.taskId ?? null,
  };
}

// 全エージェントの健全性をチェック
export async function checkAllAgentsHealth(): Promise<AgentHealth[]> {
  const allAgents = await db.select().from(agents);
  const healthResults: AgentHealth[] = [];

  for (const agent of allAgents) {
    const health = await checkAgentHealth(agent.id);
    if (health) {
      healthResults.push(health);
    }
  }

  return healthResults;
}

// Get available agents
export async function getAvailableAgents(role?: string): Promise<string[]> {
  const conditions = [eq(agents.status, "idle")];
  if (role) {
    conditions.push(eq(agents.role, role));
  }
  const allAgents = await db
    .select()
    .from(agents)
    .where(and(...conditions));

  const now = new Date();
  const threshold = new Date(now.getTime() - HEARTBEAT_TIMEOUT_SECONDS * 1000);

  // Only agents with recent heartbeat
  return allAgents
    .filter((agent) => {
      if (!agent.lastHeartbeat) return false;
      return agent.lastHeartbeat > threshold;
    })
    .map((agent) => agent.id);
}

// オフラインエージェントのリースを回収
export async function reclaimDeadAgentLeases(): Promise<number> {
  const now = new Date();
  const threshold = new Date(now.getTime() - HEARTBEAT_TIMEOUT_SECONDS * 1000);

  // オフラインエージェントを検出
  const offlineAgents = await db
    .select()
    .from(agents)
    .where(lt(agents.lastHeartbeat, threshold));

  if (offlineAgents.length === 0) {
    return 0;
  }

  let reclaimedCount = 0;

  for (const agent of offlineAgents) {
    // エージェントのリースを取得
    const agentLeases = await db
      .select()
      .from(leases)
      .where(eq(leases.agentId, agent.id));

    for (const lease of agentLeases) {
      // Return task to queued
      await db
        .update(tasks)
        .set({
          status: "queued",
          blockReason: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, lease.taskId));

      // リースを削除
      await db.delete(leases).where(eq(leases.id, lease.id));
      reclaimedCount++;
    }

    // エージェントをオフラインに更新
    await db
      .update(agents)
      .set({ status: "offline" })
      .where(eq(agents.id, agent.id));
  }

  return reclaimedCount;
}

// ハートビートを記録
export async function recordHeartbeat(agentId: string): Promise<boolean> {
  const result = await db
    .update(agents)
    .set({
      lastHeartbeat: new Date(),
      status: "idle",
    })
    .where(eq(agents.id, agentId))
    .returning();

  return result.length > 0;
}

// エージェントを登録
export async function registerAgent(
  agentId: string,
  role: string = "worker"
): Promise<string> {
  const result = await db
    .insert(agents)
    .values({
      id: agentId,
      role,
      status: "idle",
      lastHeartbeat: new Date(),
      metadata: {
        model: process.env.OPENCODE_MODEL ?? "google/gemini-3-flash-preview",
        provider: "gemini",
      },
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        status: "idle",
        lastHeartbeat: new Date(),
      },
    })
    .returning();

  return result[0]!.id;
}

// 統計情報を取得
export async function getAgentStats() {
  const allAgents = await db.select().from(agents);
  const now = new Date();
  const threshold = new Date(now.getTime() - HEARTBEAT_TIMEOUT_SECONDS * 1000);

  let idle = 0;
  let busy = 0;
  let offline = 0;

  for (const agent of allAgents) {
    const isOnline = agent.lastHeartbeat && agent.lastHeartbeat > threshold;

    if (!isOnline) {
      offline++;
    } else if (agent.status === "busy") {
      busy++;
    } else {
      idle++;
    }
  }

  return {
    total: allAgents.length,
    idle,
    busy,
    offline,
  };
}

// 現在busy状態のエージェント数を取得（同時実行上限の算出に利用）
export async function getBusyAgentCount(): Promise<number> {
  const executableRoles = ["worker", "tester", "docser"];
  const result = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.status, "busy"), inArray(agents.role, executableRoles)));

  return result.length;
}
