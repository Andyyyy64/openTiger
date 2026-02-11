import type { Task } from "@openTiger/core";

// Handle PR info associated with task

interface TaskPrContext {
  number: number;
  headRef?: string;
  baseRef?: string;
}

export function resolveTaskPrContext(task: Task): TaskPrContext | null {
  if (!task.context || typeof task.context !== "object") {
    return null;
  }
  const contextRecord = task.context as Record<string, unknown>;
  const pr = contextRecord.pr;
  if (!pr || typeof pr !== "object") {
    return null;
  }
  const prRecord = pr as Record<string, unknown>;
  const number = prRecord.number;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) {
    return null;
  }
  const headRef =
    typeof prRecord.headRef === "string" && prRecord.headRef.trim().length > 0
      ? prRecord.headRef.trim()
      : undefined;
  const baseRef =
    typeof prRecord.baseRef === "string" && prRecord.baseRef.trim().length > 0
      ? prRecord.baseRef.trim()
      : undefined;
  return { number, headRef, baseRef };
}

export function buildPrFetchRefspecs(prContext: TaskPrContext | null): string[] {
  if (!prContext) {
    return [];
  }
  if (prContext.headRef) {
    return [`+refs/heads/${prContext.headRef}:refs/remotes/origin/${prContext.headRef}`];
  }
  return [`+refs/pull/${prContext.number}/head:refs/remotes/origin/pull/${prContext.number}`];
}

export function resolveBranchBaseRef(
  prContext: TaskPrContext | null,
  fallbackBaseBranch: string,
): string {
  if (!prContext) {
    return fallbackBaseBranch;
  }
  if (prContext.headRef) {
    return `origin/${prContext.headRef}`;
  }
  return `origin/pull/${prContext.number}`;
}
