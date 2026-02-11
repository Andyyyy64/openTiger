import { db } from "@openTiger/db";
import { agents, leases, runs, tasks } from "@openTiger/db/schema";
import { eq, lt, and, inArray, desc } from "drizzle-orm";

// Heartbeat config
const HEARTBEAT_TIMEOUT_SECONDS = (() => {
  const parsed = Number.parseInt(process.env.DISPATCH_AGENT_HEARTBEAT_TIMEOUT_SECONDS ?? "120", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 120;
  }
  return parsed;
})(); // Offline if no response for timeout seconds or more
const RUNNING_RUN_GRACE_MS = (() => {
  const parsed = Number.parseInt(process.env.DISPATCH_AGENT_RUNNING_RUN_GRACE_MS ?? "600000", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 600000;
  }
  return parsed;
})(); // Keep recently-active agents online to avoid false dead-agent reclamation

// Agent health state
export interface AgentHealth {
  id: string;
  role: string;
  status: string;
  lastHeartbeat: Date | null;
  isHealthy: boolean;
  currentTaskId: string | null;
}

// Check agent health
export async function checkAgentHealth(agentId: string): Promise<AgentHealth | null> {
  const result = await db.select().from(agents).where(eq(agents.id, agentId));

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
    ? now.getTime() - lastHeartbeat.getTime() < HEARTBEAT_TIMEOUT_SECONDS * 1000
    : false;

  // Get leases held by agent
  const agentLeases = await db.select().from(leases).where(eq(leases.agentId, agentId));

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

// Check health of all agents
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

// Reclaim leases from offline agents
export async function reclaimDeadAgentLeases(): Promise<number> {
  const now = new Date();
  const threshold = new Date(now.getTime() - HEARTBEAT_TIMEOUT_SECONDS * 1000);
  const runningRunGraceThresholdMs = Date.now() - RUNNING_RUN_GRACE_MS;

  // Detect offline agents
  const offlineAgents = await db.select().from(agents).where(lt(agents.lastHeartbeat, threshold));

  if (offlineAgents.length === 0) {
    return 0;
  }

  let reclaimedCount = 0;

  for (const agent of offlineAgents) {
    const [activeRun] = await db
      .select({ id: runs.id, startedAt: runs.startedAt })
      .from(runs)
      .where(and(eq(runs.agentId, agent.id), eq(runs.status, "running")))
      .orderBy(desc(runs.startedAt))
      .limit(1);

    // Long-running task during transient heartbeat jitter: do not reclaim leases yet.
    if (activeRun?.startedAt && activeRun.startedAt.getTime() >= runningRunGraceThresholdMs) {
      continue;
    }

    // Get agent lease
    const agentLeases = await db.select().from(leases).where(eq(leases.agentId, agent.id));

    for (const lease of agentLeases) {
      // Return task to queued
      await db
        .update(tasks)
        .set({
          status: "queued",
          blockReason: null,
          updatedAt: new Date(),
        })
        .where(and(eq(tasks.id, lease.taskId), eq(tasks.status, "running")));

      // Remove lease
      await db.delete(leases).where(eq(leases.id, lease.id));
      reclaimedCount++;
    }

    // Update agent to offline
    await db.update(agents).set({ status: "offline" }).where(eq(agents.id, agent.id));
  }

  return reclaimedCount;
}

// Record heartbeat
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

// Register agent
export async function registerAgent(agentId: string, role: string = "worker"): Promise<string> {
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

// Get stats
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

// Get count of busy agents (for concurrency limit)
export async function getBusyAgentCount(): Promise<number> {
  const executableRoles = ["worker", "tester", "docser"];
  const result = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.status, "busy"), inArray(agents.role, executableRoles)));

  return result.length;
}
