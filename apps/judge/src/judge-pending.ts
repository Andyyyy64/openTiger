import { db } from "@openTiger/db";
import { artifacts, runs, tasks } from "@openTiger/db/schema";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getLocalRepoPath } from "@openTiger/core";

export type PendingPR = {
  prNumber: number;
  prUrl: string;
  taskId: string;
  runId: string;
  startedAt: Date;
  taskTitle: string;
  taskGoal: string;
  taskRiskLevel: "low" | "medium" | "high";
  allowedPaths: string[];
  commands: string[];
};

export type PendingWorktree = {
  worktreePath: string;
  baseBranch: string;
  branchName: string;
  baseRepoPath?: string;
  taskId: string;
  runId: string;
  startedAt: Date;
  taskGoal: string;
  taskRiskLevel: "low" | "medium" | "high";
  allowedPaths: string[];
};

export async function getPendingPRs(): Promise<PendingPR[]> {
  const result = await db
    .select({
      prNumber: artifacts.ref,
      prUrl: artifacts.url,
      taskId: runs.taskId,
      runId: runs.id,
      startedAt: runs.startedAt,
    })
    .from(artifacts)
    .innerJoin(runs, eq(artifacts.runId, runs.id))
    .where(
      and(
        eq(artifacts.type, "pr"),
        eq(runs.status, "success"),
        isNull(runs.judgedAt),
        isNotNull(artifacts.ref),
      ),
    )
    .orderBy(desc(runs.startedAt));

  const pendingPRs: PendingPR[] = [];
  const seenTaskIds = new Set<string>();

  for (const row of result) {
    if (!row.prNumber) continue;
    if (seenTaskIds.has(row.taskId)) continue;

    const prNumber = parseInt(row.prNumber, 10);
    if (Number.isNaN(prNumber)) continue;

    const taskResult = await db.select().from(tasks).where(eq(tasks.id, row.taskId));

    const task = taskResult[0];
    if (!task) continue;

    // Only review tasks waiting for Judge (blocked)
    if (task.status !== "blocked") continue;

    pendingPRs.push({
      prNumber,
      prUrl: row.prUrl ?? "",
      taskId: row.taskId,
      runId: row.runId,
      startedAt: row.startedAt,
      taskTitle: task.title,
      taskGoal: task.goal,
      taskRiskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
      allowedPaths: task.allowedPaths ?? [],
      commands: task.commands ?? [],
    });
    seenTaskIds.add(row.taskId);
  }

  return pendingPRs;
}

export async function getPendingWorktrees(): Promise<PendingWorktree[]> {
  const result = await db
    .select({
      worktreePath: artifacts.ref,
      metadata: artifacts.metadata,
      taskId: runs.taskId,
      runId: runs.id,
      startedAt: runs.startedAt,
    })
    .from(artifacts)
    .innerJoin(runs, eq(artifacts.runId, runs.id))
    .where(
      and(
        eq(artifacts.type, "worktree"),
        eq(runs.status, "success"),
        isNull(runs.judgedAt),
        isNotNull(artifacts.ref),
      ),
    )
    .orderBy(desc(runs.startedAt));

  const pendingWorktrees: PendingWorktree[] = [];
  const seenTaskIds = new Set<string>();

  for (const row of result) {
    if (!row.worktreePath) continue;
    if (seenTaskIds.has(row.taskId)) continue;
    const metadata = row.metadata;
    const baseBranch =
      typeof metadata === "object" && metadata && "baseBranch" in metadata
        ? String((metadata as { baseBranch?: unknown }).baseBranch ?? "main")
        : (process.env.BASE_BRANCH ?? "main");
    const branchName =
      typeof metadata === "object" && metadata && "branchName" in metadata
        ? String((metadata as { branchName?: unknown }).branchName ?? "HEAD")
        : "HEAD";

    const taskResult = await db.select().from(tasks).where(eq(tasks.id, row.taskId));

    const task = taskResult[0];
    if (!task) continue;
    // Only review tasks waiting for Judge (blocked)
    if (task.status !== "blocked") continue;

    pendingWorktrees.push({
      worktreePath: row.worktreePath,
      baseBranch,
      branchName,
      baseRepoPath:
        typeof metadata === "object" && metadata && "baseRepoPath" in metadata
          ? String((metadata as { baseRepoPath?: unknown }).baseRepoPath ?? "")
          : getLocalRepoPath(),
      taskId: row.taskId,
      runId: row.runId,
      startedAt: row.startedAt,
      taskGoal: task.goal,
      taskRiskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
      allowedPaths: task.allowedPaths ?? [],
    });
    seenTaskIds.add(row.taskId);
  }

  return pendingWorktrees;
}
