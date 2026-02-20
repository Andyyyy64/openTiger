import { resolve, relative, isAbsolute } from "node:path";
import { db } from "@openTiger/db";
import { events, runs, tasks } from "@openTiger/db/schema";
import { and, count, eq } from "drizzle-orm";
import {
  SYSTEM_ENTITY_ID,
  getRepoMode,
  getLocalRepoPath,
  getLocalWorktreeRoot,
} from "@openTiger/core";
import { setupProcessLogging } from "@openTiger/core/process-logging";
import { createTaskQueue, enqueueTask, getQueueStats, getTaskQueueName } from "@openTiger/queue";

import {
  cleanupExpiredLeases,
  cleanupDanglingLeases,
  recoverOrphanedRunningTasks,
  acquireLease,
  releaseLease,
  getAvailableTasks,
  launchWorker,
  stopAllWorkers,
  getBusyAgentCount,
  reclaimDeadAgentLeases,
  getAgentStats,
  getAvailableAgents,
  type LaunchMode,
} from "./scheduler/index";
import {
  countTasksByLane,
  normalizeLane,
  selectTasksForDispatch,
  type DispatcherLane,
  type LaneLimits,
} from "./scheduler/lane-policy";
import { buildPluginRuntimeRegistry, registerPlugin } from "@openTiger/plugin-sdk";
import { tigerResearchPluginManifest } from "@openTiger/plugin-tiger-research";

registerPlugin(tigerResearchPluginManifest);

// Dispatcher config
interface DispatcherConfig {
  pollIntervalMs: number;
  maxConcurrentWorkers: number;
  launchMode: LaunchMode;
  repoMode: "git" | "local";
  repoUrl: string;
  baseBranch: string;
  workspacePath: string;
  localRepoPath?: string;
  localWorktreeRoot?: string;
}

const DEFAULT_MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_NO_IDLE_LOG_INTERVAL_MS = 60_000;
const NO_IDLE_LOG_INTERVAL_MS = (() => {
  const raw = Number.parseInt(
    process.env.DISPATCH_NO_IDLE_LOG_INTERVAL_MS ?? String(DEFAULT_NO_IDLE_LOG_INTERVAL_MS),
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NO_IDLE_LOG_INTERVAL_MS;
})();
const MAX_POLL_INTERVAL_MS = (() => {
  const raw = Number.parseInt(
    process.env.DISPATCH_MAX_POLL_INTERVAL_MS ?? String(DEFAULT_MAX_POLL_INTERVAL_MS),
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_POLL_INTERVAL_MS;
})();
const noIdleLogState = new Map<string, { lastLoggedAt: number; suppressed: number }>();

const DEFAULT_DISPATCH_CONFLICT_LANE_MAX_SLOTS = 2;
const DEFAULT_DISPATCH_FEATURE_LANE_MIN_SLOTS = 1;
const DEFAULT_DISPATCH_DOCSER_LANE_MAX_SLOTS = 1;

function parseLaneCap(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
}

function parseLaneMinimum(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

const DISPATCH_CONFLICT_LANE_MAX_SLOTS = parseLaneCap(
  process.env.DISPATCH_CONFLICT_LANE_MAX_SLOTS,
  DEFAULT_DISPATCH_CONFLICT_LANE_MAX_SLOTS,
);
const DISPATCH_FEATURE_LANE_MIN_SLOTS = parseLaneMinimum(
  process.env.DISPATCH_FEATURE_LANE_MIN_SLOTS,
  DEFAULT_DISPATCH_FEATURE_LANE_MIN_SLOTS,
);
const DISPATCH_DOCSER_LANE_MAX_SLOTS = parseLaneCap(
  process.env.DISPATCH_DOCSER_LANE_MAX_SLOTS,
  DEFAULT_DISPATCH_DOCSER_LANE_MAX_SLOTS,
);
const LANE_LIMITS: LaneLimits = {
  conflictMaxSlots: DISPATCH_CONFLICT_LANE_MAX_SLOTS,
  featureMinSlots: DISPATCH_FEATURE_LANE_MIN_SLOTS,
  docserMaxSlots: DISPATCH_DOCSER_LANE_MAX_SLOTS,
};
const pluginRuntimeRegistry = buildPluginRuntimeRegistry(process.env.ENABLED_PLUGINS);

function parseMaxConcurrentWorkers(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return 5;
  }
  if (parsed <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return parsed;
}

function computeBackoffDelayMs(baseDelayMs: number, idleLoopStreak: number): number {
  if (idleLoopStreak <= 0) {
    return baseDelayMs;
  }
  const exponent = Math.min(idleLoopStreak, 6);
  const delay = baseDelayMs * 2 ** exponent;
  return Math.min(delay, Math.max(baseDelayMs, MAX_POLL_INTERVAL_MS));
}

function logNoIdleAgent(requiredRole: string): void {
  const now = Date.now();
  const state = noIdleLogState.get(requiredRole) ?? { lastLoggedAt: 0, suppressed: 0 };
  if (now - state.lastLoggedAt < NO_IDLE_LOG_INTERVAL_MS) {
    state.suppressed += 1;
    noIdleLogState.set(requiredRole, state);
    return;
  }

  const suffix = state.suppressed > 0 ? ` (${state.suppressed} similar events suppressed)` : "";
  console.log(`[Dispatch] No idle ${requiredRole} agent available${suffix}`);
  noIdleLogState.set(requiredRole, { lastLoggedAt: now, suppressed: 0 });
}

function resolveAgentRoleForTask(taskRole: string | null | undefined): string {
  if (taskRole === "worker" || taskRole === "tester" || taskRole === "docser") {
    return taskRole;
  }
  // Semantic research roles run on standard worker pool.
  return "worker";
}

async function getActiveRunningByLane(): Promise<Map<DispatcherLane, number>> {
  const running = await db
    .select({ lane: tasks.lane, kind: tasks.kind })
    .from(tasks)
    .where(eq(tasks.status, "running"));

  const counts = new Map<DispatcherLane, number>();
  for (const task of running) {
    const fallbackLane =
      task.kind && pluginRuntimeRegistry.allowedTaskKinds.has(task.kind)
        ? (pluginRuntimeRegistry.defaultLaneByTaskKind.get(task.kind) ?? "feature")
        : "feature";
    const lane = normalizeLane({
      lane: task.lane ?? fallbackLane,
    });
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  return counts;
}

// Default config
const DEFAULT_CONFIG: DispatcherConfig = {
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? "3000", 10),
  maxConcurrentWorkers: parseMaxConcurrentWorkers(process.env.MAX_CONCURRENT_WORKERS),
  launchMode: (process.env.LAUNCH_MODE as LaunchMode) ?? "process",
  repoMode: getRepoMode(),
  repoUrl: process.env.REPO_URL ?? "",
  baseBranch: process.env.BASE_BRANCH ?? "main",
  workspacePath: process.env.WORKSPACE_PATH ?? "/tmp/openTiger-workspace",
  localRepoPath: getLocalRepoPath(),
  localWorktreeRoot: getLocalWorktreeRoot(),
};

function isSubPath(baseDir: string, targetDir: string): boolean {
  const relativePath = relative(baseDir, targetDir);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function resolveWorkspacePath(config: DispatcherConfig): string {
  const envPath = process.env.WORKSPACE_PATH?.trim();
  const baseDir = resolve(process.cwd());

  if (config.launchMode === "process") {
    const fallbackPath = resolve(baseDir, ".openTiger-workspace");
    if (!envPath) {
      return fallbackPath;
    }
    const resolved = resolve(envPath);
    if (isSubPath(baseDir, resolved)) {
      return resolved;
    }
    // Avoid external directories when starting process
    console.warn("[Dispatcher] WORKSPACE_PATH is outside repo. Using local workspace instead.");
    return fallbackPath;
  }

  return envPath ? resolve(envPath) : "/tmp/openTiger-workspace";
}

function resolveLocalWorktreeRoot(config: DispatcherConfig): string | undefined {
  const envPath = process.env.LOCAL_WORKTREE_ROOT?.trim();
  const baseDir = resolve(process.cwd());

  if (config.launchMode === "process") {
    const fallbackPath = resolve(config.workspacePath, "worktrees");
    if (!envPath) {
      return fallbackPath;
    }
    const resolved = resolve(envPath);
    if (isSubPath(baseDir, resolved)) {
      return resolved;
    }
    // Avoid external directories when starting process
    console.warn(
      "[Dispatcher] LOCAL_WORKTREE_ROOT is outside repo. Using local worktrees instead.",
    );
    return fallbackPath;
  }

  return envPath ? resolve(envPath) : "/tmp/openTiger-worktree";
}

function buildDockerAgentId(role: string, taskId: string): string {
  return `${role}-docker-${taskId}`;
}

// Dispatcher state
let isRunning = false;
let quotaThrottleActive = false;
// Cache for agent-specific queue reuse
const taskQueues = new Map<string, ReturnType<typeof createTaskQueue>>();

function getTaskQueueForAgent(agentId: string): ReturnType<typeof createTaskQueue> {
  const existing = taskQueues.get(agentId);
  if (existing) return existing;
  const queue = createTaskQueue(getTaskQueueName(agentId));
  taskQueues.set(agentId, queue);
  return queue;
}

async function hasQuotaWaitBacklog(): Promise<boolean> {
  const [result] = await db
    .select({ count: count() })
    .from(tasks)
    .where(and(eq(tasks.status, "blocked"), eq(tasks.blockReason, "quota_wait")));
  return (result?.count ?? 0) > 0;
}

// Dispatch task
async function dispatchTask(
  task: Awaited<ReturnType<typeof getAvailableTasks>>[0],
  agentId: string,
  agentRole: string,
  config: DispatcherConfig,
): Promise<boolean> {
  // Avoid duplicate execution: do not re-dispatch if run is still in progress
  const runningRuns = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, task.id), eq(runs.status, "running")))
    .limit(1);
  if (runningRuns.length > 0) {
    console.log(`[Dispatch] Task ${task.id} already has a running run. Skipping.`);
    return false;
  }

  // Acquire lease
  const leaseResult = await acquireLease(task.id, agentId);

  if (!leaseResult.success) {
    console.log(`[Dispatch] Failed to acquire lease for task ${task.id}: ${leaseResult.error}`);
    return false;
  }

  // Update task to running
  const taskUpdate = await db
    .update(tasks)
    .set({ status: "running", updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.status, "queued")))
    .returning({ id: tasks.id });
  if (taskUpdate.length === 0) {
    await releaseLease(task.id);
    console.log(`[Dispatch] Task ${task.id} is no longer queued. Skipping dispatch.`);
    return false;
  }

  if (config.launchMode === "process") {
    // Dispatch to queue for resident agents
    const agentQueue = getTaskQueueForAgent(agentId);
    await enqueueTask(agentQueue, {
      taskId: task.id,
      agentId,
      priority: task.priority,
    });
    console.log(`[Dispatch] Task ${task.id} enqueued for agent ${agentId}`);
  } else {
    // Docker mode launches per-task; do not enqueue
    console.log(`[Dispatch] Task ${task.id} will run via docker launcher (agent=${agentId})`);
  }

  // Start Worker
  const launchResult = await launchWorker({
    mode: config.launchMode,
    taskId: task.id,
    agentId,
    agentRole,
    repoUrl: config.repoUrl,
    baseBranch: config.baseBranch,
    workspacePath: `${config.workspacePath}/${agentId}`,
    env: {
      REPO_MODE: config.repoMode,
      LOCAL_REPO_PATH: config.localRepoPath ?? "",
      LOCAL_WORKTREE_ROOT: config.localWorktreeRoot ?? "",
    },
  });

  if (!launchResult.success) {
    console.error(`[Dispatch] Failed to launch worker: ${launchResult.error}`);
    // Release lease and requeue task
    await releaseLease(task.id);
    await db
      .update(tasks)
      .set({ status: "queued", blockReason: null, updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
    return false;
  }

  console.log(
    `[Dispatch] Task "${task.title}" dispatched to agent ${agentId} (${agentRole}, ${config.launchMode} mode)`,
  );
  return true;
}

// Dispatch loop
async function runDispatchLoop(config: DispatcherConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("openTiger Dispatcher started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(
    `Max concurrent workers: ${
      Number.isFinite(config.maxConcurrentWorkers) ? config.maxConcurrentWorkers : "unlimited"
    }`,
  );
  console.log(`Launch mode: ${config.launchMode}`);
  console.log(`Repo mode: ${config.repoMode}`);
  console.log(`Repository: ${config.repoUrl}`);
  console.log(`Base branch: ${config.baseBranch}`);
  console.log("=".repeat(60));

  let idleLoopStreak = 0;
  while (isRunning) {
    try {
      let dispatchedThisLoop = 0;
      // Clean up expired leases
      const expiredCount = await cleanupExpiredLeases();
      if (expiredCount > 0) {
        console.log(`[Cleanup] Released ${expiredCount} expired leases`);
      }

      const danglingCount = await cleanupDanglingLeases();
      if (danglingCount > 0) {
        console.log(`[Cleanup] Released ${danglingCount} dangling leases`);
      }

      // Reclaim leases from offline agents
      const reclaimedCount = await reclaimDeadAgentLeases();
      if (reclaimedCount > 0) {
        console.log(`[Cleanup] Reclaimed ${reclaimedCount} leases from dead agents`);
      }

      // Recover tasks that are running but have no active run
      const recoveredCount = await recoverOrphanedRunningTasks();
      if (recoveredCount > 0) {
        console.log(`[Cleanup] Recovered ${recoveredCount} orphaned running tasks`);
      }

      // Apply concurrency limit based on busy agent count (queue and process)
      const busyAgentCount = await getBusyAgentCount();
      const quotaWaitBacklog = await hasQuotaWaitBacklog();
      const effectiveMaxConcurrentWorkers = quotaWaitBacklog
        ? Math.min(config.maxConcurrentWorkers, 1)
        : config.maxConcurrentWorkers;
      if (quotaWaitBacklog && !quotaThrottleActive) {
        console.log(
          "[Dispatch] quota_wait backlog detected. Concurrency temporarily limited to 1.",
        );
        quotaThrottleActive = true;
      } else if (!quotaWaitBacklog && quotaThrottleActive) {
        console.log("[Dispatch] quota_wait backlog cleared. Restoring normal concurrency.");
        quotaThrottleActive = false;
      }

      const availableSlots = Number.isFinite(effectiveMaxConcurrentWorkers)
        ? Math.max(0, effectiveMaxConcurrentWorkers - busyAgentCount)
        : Number.MAX_SAFE_INTEGER;

      if (availableSlots > 0) {
        // Get available tasks
        const availableTasks = await getAvailableTasks();

        if (availableTasks.length > 0) {
          const activeRunningByLane = await getActiveRunningByLane();
          const tasksToDispatch = selectTasksForDispatch({
            availableTasks,
            availableSlots,
            activeRunningByLane,
            laneLimits: LANE_LIMITS,
          });
          const laneSummary = {
            feature: activeRunningByLane.get("feature") ?? 0,
            conflict_recovery: activeRunningByLane.get("conflict_recovery") ?? 0,
            docser: activeRunningByLane.get("docser") ?? 0,
          };
          const availableByLane = countTasksByLane(availableTasks);
          const selectedByLane = countTasksByLane(tasksToDispatch);
          console.log(
            `[Dispatch] Found ${availableTasks.length} available tasks, ${availableSlots} slots available, selected=${tasksToDispatch.length}, active_by_lane=${JSON.stringify(laneSummary)}`,
          );

          const availableFeatureLike =
            (availableByLane.feature ?? 0) + (availableByLane.research ?? 0);
          const selectedFeatureLike =
            (selectedByLane.feature ?? 0) + (selectedByLane.research ?? 0);
          if (
            tasksToDispatch.length === 0 ||
            (availableFeatureLike > 0 && selectedFeatureLike === 0) ||
            ((availableByLane.conflict_recovery ?? 0) > 0 &&
              (selectedByLane.conflict_recovery ?? 0) === 0)
          ) {
            await db.insert(events).values({
              type: "dispatcher.lane_throttled",
              entityType: "system",
              entityId: SYSTEM_ENTITY_ID,
              payload: {
                availableSlots,
                availableByLane,
                selectedByLane,
                activeRunningByLane: laneSummary,
                laneLimits: LANE_LIMITS,
              },
            });
          }

          for (const task of tasksToDispatch) {
            const requiredRole = resolveAgentRoleForTask(task.role);
            const selectedAgent =
              config.launchMode === "docker"
                ? buildDockerAgentId(requiredRole, task.id)
                : (await getAvailableAgents(requiredRole))[0];

            if (!selectedAgent) {
              logNoIdleAgent(requiredRole);
              continue;
            }

            // Dispatch
            const dispatched = await dispatchTask(task, selectedAgent, requiredRole, config);
            if (dispatched) {
              dispatchedThisLoop += 1;
            }
          }
        }
      }

      // Output stats periodically
      if (Math.random() < 0.1) {
        const stats = await getAgentStats();
        const queueStats = taskQueues.size
          ? await Promise.all(Array.from(taskQueues.values()).map((queue) => getQueueStats(queue)))
          : [];
        const aggregatedStats = queueStats.reduce(
          (acc, stat) => ({
            waiting: acc.waiting + stat.waiting,
            active: acc.active + stat.active,
            completed: acc.completed + stat.completed,
            failed: acc.failed + stat.failed,
            total: acc.total + stat.total,
          }),
          { waiting: 0, active: 0, completed: 0, failed: 0, total: 0 },
        );
        console.log(
          `[Stats] Agents: ${stats.busy} busy, ${stats.idle} idle, ${stats.offline} offline | ` +
            `Queue: ${aggregatedStats.waiting} waiting, ${aggregatedStats.active} active`,
        );
      }

      if (dispatchedThisLoop > 0) {
        idleLoopStreak = 0;
      } else {
        idleLoopStreak += 1;
      }
    } catch (error) {
      console.error("[Dispatch] Error in dispatch loop:", error);
      idleLoopStreak += 1;
    }

    // Wait for next poll
    const delayMs = computeBackoffDelayMs(config.pollIntervalMs, idleLoopStreak);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

// Signal handlers
function setupSignalHandlers(): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}, stopping dispatcher...`);
    isRunning = false;

    // Stop all Workers
    await stopAllWorkers();

    // Close queue
    if (taskQueues.size > 0) {
      await Promise.all(Array.from(taskQueues.values()).map((queue) => queue.close()));
    }

    console.log("[Shutdown] Dispatcher stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Main entry
async function main(): Promise<void> {
  setupProcessLogging(process.env.OPENTIGER_LOG_NAME ?? "dispatcher", { label: "Dispatcher" });
  const config = { ...DEFAULT_CONFIG };
  config.workspacePath = resolveWorkspacePath(config);
  config.localWorktreeRoot = resolveLocalWorktreeRoot(config);

  // Validate config
  if (config.repoMode === "git" && !config.repoUrl) {
    console.error("Error: REPO_URL environment variable is required for git mode");
    process.exit(1);
  }
  if (config.repoMode === "local" && !config.localRepoPath) {
    console.error("Error: LOCAL_REPO_PATH environment variable is required for local mode");
    process.exit(1);
  }

  // Set up signal handler
  setupSignalHandlers();

  // Start dispatcher
  isRunning = true;
  await runDispatchLoop(config);
}

main().catch((error) => {
  console.error("Dispatcher crashed:", error);
  process.exit(1);
});
