import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { resolveDeterministicTargetArea, type CreateTaskInput } from "@openTiger/core";
import { inArray } from "drizzle-orm";
import { pathsOverlap } from "./dependency-resolver";

type ActiveBacklogTask = {
  id: string;
  targetArea: string | null;
  touches: string[];
  allowedPaths: string[];
  context: unknown;
};

function normalizePath(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function collectTaskPaths(task: {
  touches?: string[] | null;
  allowedPaths?: string[] | null;
  context?: unknown;
}): string[] {
  const contextFiles =
    typeof task.context === "object" &&
    task.context !== null &&
    "files" in task.context &&
    Array.isArray((task.context as { files?: unknown }).files)
      ? ((task.context as { files?: unknown }).files as unknown[])
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
  const all = [...(task.touches ?? []), ...(task.allowedPaths ?? []), ...contextFiles]
    .map((path) => normalizePath(path))
    .filter((path) => path.length > 0);
  return Array.from(new Set(all));
}

function hasPathOverlap(taskPaths: string[], activeTaskPaths: string[]): boolean {
  return taskPaths.some((path) =>
    activeTaskPaths.some((activePath) => pathsOverlap(path, activePath)),
  );
}

async function loadActiveBacklogTasks(): Promise<ActiveBacklogTask[]> {
  const rows = await db
    .select({
      id: tasks.id,
      targetArea: tasks.targetArea,
      touches: tasks.touches,
      allowedPaths: tasks.allowedPaths,
      context: tasks.context,
    })
    .from(tasks)
    .where(inArray(tasks.status, ["queued", "running", "blocked"]));

  return rows.map((row) => ({
    id: row.id,
    targetArea: row.targetArea ?? null,
    touches: row.touches ?? [],
    allowedPaths: row.allowedPaths ?? [],
    context: row.context,
  }));
}

export async function applyHotFilePlanning(taskInputs: CreateTaskInput[]): Promise<{
  tasks: CreateTaskInput[];
  overlapCount: number;
}> {
  if (taskInputs.length === 0) {
    return { tasks: taskInputs, overlapCount: 0 };
  }

  const activeBacklog = await loadActiveBacklogTasks();
  if (activeBacklog.length === 0) {
    return { tasks: taskInputs, overlapCount: 0 };
  }

  let overlapCount = 0;
  const nextTasks = taskInputs.map((task, index) => {
    const taskArea = resolveDeterministicTargetArea({
      id: `plan:${index}`,
      kind: task.kind,
      targetArea: task.targetArea,
      touches: task.touches,
      allowedPaths: task.allowedPaths,
      context: task.context,
    });
    const taskPaths = collectTaskPaths(task);

    const overlappedTaskIds = activeBacklog
      .filter((activeTask) => {
        if (taskArea && activeTask.targetArea && taskArea === activeTask.targetArea) {
          return true;
        }
        return hasPathOverlap(
          taskPaths,
          collectTaskPaths({
            touches: activeTask.touches,
            allowedPaths: activeTask.allowedPaths,
            context: activeTask.context,
          }),
        );
      })
      .map((activeTask) => activeTask.id);

    if (overlappedTaskIds.length === 0) {
      return task;
    }

    overlapCount += 1;
    const existingDependencies = task.dependencies ?? [];
    const mergedDependencies = Array.from(new Set([...existingDependencies, ...overlappedTaskIds]));
    return {
      ...task,
      targetArea: taskArea ?? task.targetArea,
      dependencies: mergedDependencies,
    };
  });

  return { tasks: nextTasks, overlapCount };
}
