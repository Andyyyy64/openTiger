import { db } from "@openTiger/db";
import { tasks, leases, runs, artifacts } from "@openTiger/db/schema";
import { eq, and, inArray, gt, count, isNull, desc } from "drizzle-orm";

// Task selection result
export interface AvailableTask {
  id: string;
  title: string;
  goal: string;
  priority: number;
  riskLevel: string;
  role: string;
  timeboxMinutes: number;
  dependencies: string[];
  allowedPaths: string[];
  commands: string[];
  context: Record<string, unknown> | null;
  targetArea: string | null;
  touches: string[];
}

const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;
const BLOCK_ON_AWAITING_JUDGE_BACKLOG = process.env.DISPATCH_BLOCK_ON_AWAITING_JUDGE === "true";
let lastObservedJudgeBacklog = -1;
let lastObservedPendingJudgeRun = false;
let lastObservedJudgeBacklogBlocked = false;

function isQuotaFailureMessage(message: string): boolean {
  return /quota exceeded|resource has been exhausted|resource_exhausted|quota limit reached|generate_requests_per_model_per_day|generate_content_paid_tier_input_token_count|retryinfo/i.test(
    message,
  );
}

function getRetryDelayMs(): number {
  const raw = process.env.DISPATCH_RETRY_DELAY_MS ?? String(DEFAULT_RETRY_DELAY_MS);
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RETRY_DELAY_MS;
  }

  return parsed;
}

// Get available tasks by priority
export async function getAvailableTasks(): Promise<AvailableTask[]> {
  // Do not dispatch new tasks while PR/Judge backlog remains.
  // Ensures order: PR first, then Issue/Planner.
  // Default: do not hard stop; prefer normal task progress.
  const [awaitingJudgeTasks] = await db
    .select({ count: count() })
    .from(tasks)
    .where(and(eq(tasks.status, "blocked"), eq(tasks.blockReason, "awaiting_judge")));
  const [pendingJudgeRun] = await db
    .select({ runId: runs.id })
    .from(runs)
    .innerJoin(artifacts, eq(artifacts.runId, runs.id))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(runs.status, "success"),
        isNull(runs.judgedAt),
        inArray(artifacts.type, ["pr", "worktree"]),
        eq(tasks.status, "blocked"),
        eq(tasks.blockReason, "awaiting_judge"),
      ),
    )
    .limit(1);
  const judgeBacklogCount = awaitingJudgeTasks?.count ?? 0;
  const hasPendingJudgeRun = Boolean(pendingJudgeRun?.runId);

  if (judgeBacklogCount > 0 || hasPendingJudgeRun) {
    if (
      lastObservedJudgeBacklog !== judgeBacklogCount ||
      lastObservedPendingJudgeRun !== hasPendingJudgeRun
    ) {
      console.log(
        `[Priority] Awaiting_judge backlog observed: backlog=${judgeBacklogCount}, pending_judge_run=${hasPendingJudgeRun}, hard_block=${BLOCK_ON_AWAITING_JUDGE_BACKLOG}`,
      );
    }
    lastObservedJudgeBacklog = judgeBacklogCount;
    lastObservedPendingJudgeRun = hasPendingJudgeRun;
    if (BLOCK_ON_AWAITING_JUDGE_BACKLOG) {
      lastObservedJudgeBacklogBlocked = true;
      return [];
    }
  } else if (lastObservedJudgeBacklog > 0 || lastObservedPendingJudgeRun) {
    console.log("[Priority] Awaiting_judge backlog cleared");
    lastObservedJudgeBacklog = 0;
    lastObservedPendingJudgeRun = false;
  }
  if (lastObservedJudgeBacklogBlocked && !(judgeBacklogCount > 0 || hasPendingJudgeRun)) {
    console.log("[Priority] Dispatch resumed after awaiting_judge backlog gate");
    lastObservedJudgeBacklogBlocked = false;
  }

  // Fetch queued tasks
  const queuedTasks = await db.select().from(tasks).where(eq(tasks.status, "queued"));

  if (queuedTasks.length === 0) {
    console.log("[Priority] No queued tasks found");
    return [];
  }

  const misqueuedPrReviewTaskIds = queuedTasks
    .filter(
      (task) =>
        task.goal.startsWith("Review and process open PR #") ||
        task.title.startsWith("[PR] Review #"),
    )
    .map((task) => task.id);
  if (misqueuedPrReviewTaskIds.length > 0) {
    // PR review is Judge-only; return misqueued to awaiting_judge
    await db
      .update(tasks)
      .set({
        status: "blocked",
        blockReason: "awaiting_judge",
        updatedAt: new Date(),
      })
      .where(inArray(tasks.id, misqueuedPrReviewTaskIds));
    console.log(
      `[Priority] Moved ${misqueuedPrReviewTaskIds.length} PR-review task(s) back to blocked(awaiting_judge)`,
    );
  }

  const dispatchableQueuedTasks = queuedTasks.filter(
    (task) => !misqueuedPrReviewTaskIds.includes(task.id),
  );

  if (dispatchableQueuedTasks.length === 0) {
    console.log("[Priority] No dispatchable queued tasks found");
    return [];
  }

  console.log(`[Priority] Found ${dispatchableQueuedTasks.length} dispatchable queued tasks`);

  const cooldownBlockedIds = new Set<string>();
  const retryDelayMs = getRetryDelayMs();

  if (retryDelayMs > 0) {
    const queuedIds = dispatchableQueuedTasks.map((task) => task.id);
    const cutoff = new Date(Date.now() - retryDelayMs);
    const recentFailures = await db
      .select({
        taskId: runs.taskId,
        status: runs.status,
        errorMessage: runs.errorMessage,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(
        and(
          inArray(runs.taskId, queuedIds),
          inArray(runs.status, ["failed", "cancelled"]),
          gt(runs.finishedAt, cutoff),
        ),
      )
      .orderBy(desc(runs.finishedAt));

    const latestFailureByTaskId = new Map<string, (typeof recentFailures)[number]>();
    for (const run of recentFailures) {
      if (!latestFailureByTaskId.has(run.taskId)) {
        latestFailureByTaskId.set(run.taskId, run);
      }
    }

    for (const run of latestFailureByTaskId.values()) {
      // Allow immediate redispatch for agent-restart recovery cancels
      const message = (run.errorMessage ?? "").toLowerCase();

      const isAgentRestartRecoveryCancel =
        run.status === "cancelled" &&
        message.includes("agent process restarted before task completion");
      const isWorkspaceCleanupRace =
        message.includes("enotempty") || message.includes("directory not empty");
      const isQuotaFailure = run.status === "failed" && isQuotaFailureMessage(message);

      if (isAgentRestartRecoveryCancel || isWorkspaceCleanupRace || isQuotaFailure) {
        continue;
      }
      cooldownBlockedIds.add(run.taskId);
    }
  }

  // Get leased task IDs
  const leasedTasks = await db.select({ taskId: leases.taskId }).from(leases);
  const leasedIds = new Set(leasedTasks.map((l) => l.taskId));

  // Get targetArea from running tasks
  const runningTasks = await db
    .select({ targetArea: tasks.targetArea })
    .from(tasks)
    .where(eq(tasks.status, "running"));
  const activeTargetAreas = new Set(
    runningTasks.map((t) => t.targetArea).filter((a): a is string => !!a),
  );

  const resolvedDependencyTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(inArray(tasks.status, ["done", "cancelled", "failed"]));
  const resolvedDependencyIds = new Set(resolvedDependencyTasks.map((t) => t.id));

  // Filter: no lease, deps resolved, no targetArea conflict
  const available = dispatchableQueuedTasks.filter((task) => {
    // Cooldown recent failures before redispatch
    if (cooldownBlockedIds.has(task.id)) {
      console.log(`[Priority] Task ${task.id} blocked by cooldown`);
      return false;
    }

    // Exclude leased
    if (leasedIds.has(task.id)) {
      console.log(`[Priority] Task ${task.id} blocked by lease`);
      return false;
    }

    // Exclude targetArea conflicts
    if (task.targetArea && activeTargetAreas.has(task.targetArea)) {
      console.log(`[Priority] Task ${task.id} blocked by targetArea conflict`);
      return false;
    }

    // Dependency check
    const deps = task.dependencies ?? [];
    const unresolvedDeps = deps.filter((depId) => !resolvedDependencyIds.has(depId));
    if (unresolvedDeps.length > 0) {
      console.log(
        `[Priority] Task ${task.id} blocked by unresolved deps: ${unresolvedDeps.join(", ")}`,
      );
      return false;
    }

    return true;
  });

  console.log(`[Priority] ${available.length} tasks passed filters`);

  // Calculate priority score and sort
  const scored = available.map((task) => ({
    task,
    score: calculatePriorityScore(task),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.map(({ task }) => ({
    id: task.id,
    title: task.title,
    goal: task.goal,
    priority: task.priority ?? 0,
    riskLevel: task.riskLevel ?? "low",
    role: task.role ?? "worker",
    timeboxMinutes: task.timeboxMinutes ?? 60,
    dependencies: task.dependencies ?? [],
    allowedPaths: task.allowedPaths ?? [],
    commands: task.commands ?? [],
    context: task.context as Record<string, unknown> | null,
    targetArea: task.targetArea,
    touches: task.touches ?? [],
  }));
}

// Calculate priority score
function calculatePriorityScore(task: {
  priority: number | null;
  riskLevel: string | null;
  createdAt: Date;
  timeboxMinutes: number | null;
}): number {
  let score = 0;

  // Base priority (0-100)
  score += (task.priority ?? 0) * 10;

  // Risk adjustment (prefer low risk)
  const riskMultiplier: Record<string, number> = {
    low: 1.5,
    medium: 1.0,
    high: 0.5,
  };
  score *= riskMultiplier[task.riskLevel ?? "low"] ?? 1.0;

  // Waiting time adjustment (prefer older tasks)
  const waitingHours = (Date.now() - task.createdAt.getTime()) / (1000 * 60 * 60);
  score += Math.min(waitingHours * 2, 20); // Max 20 points

  // Slightly prefer shorter tasks
  const timebox = task.timeboxMinutes ?? 60;
  if (timebox <= 30) {
    score += 5;
  }

  return score;
}

// Build dependency graph
export async function buildDependencyGraph(): Promise<Map<string, Set<string>>> {
  const allTasks = await db.select().from(tasks);
  const graph = new Map<string, Set<string>>();

  for (const task of allTasks) {
    const deps = new Set(task.dependencies ?? []);
    graph.set(task.id, deps);
  }

  return graph;
}

// Detect cycle dependencies
export function detectCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): boolean {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const deps = graph.get(node) ?? new Set();
    for (const dep of deps) {
      if (!visited.has(dep)) {
        if (dfs(dep)) {
          return true;
        }
      } else if (recursionStack.has(dep)) {
        // Cycle detected
        const cycleStart = path.indexOf(dep);
        cycles.push(path.slice(cycleStart));
        return true;
      }
    }

    path.pop();
    recursionStack.delete(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}
