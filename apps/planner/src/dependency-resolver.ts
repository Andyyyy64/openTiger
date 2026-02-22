import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { eq, or } from "drizzle-orm";
import type { CreateTaskInput } from "@openTiger/core";

// Dependency inference result
export interface DependencyResolution {
  taskIndex: number;
  dependsOnIndices: number[];
  dependsOnIds: string[];
  confidence: number;
  reason: string;
}

// Infer dependencies between tasks
export function inferDependencies(tasks: CreateTaskInput[]): DependencyResolution[] {
  const resolutions: DependencyResolution[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (!task) continue;

    const dependsOnIndices: number[] = [];
    const reasons: string[] = [];

    for (let j = 0; j < i; j++) {
      const prevTask = tasks[j];
      if (!prevTask) continue;

      // Dependency inference rules

      // 1. File path overlap: a later task references files modified by an earlier task
      const prevPaths = prevTask.allowedPaths;
      const currPaths = task.allowedPaths;
      const pathOverlap = prevPaths.some((p) => currPaths.some((c) => pathsOverlap(p, c)));

      if (pathOverlap) {
        dependsOnIndices.push(j);
        reasons.push(`File path overlap with task ${j}`);
        continue;
      }

      // 2. context.files reference relationship
      const prevFiles = prevTask.context?.files ?? [];
      const currFiles = task.context?.files ?? [];
      const fileOverlap = prevFiles.some((f) => currFiles.includes(f));

      if (fileOverlap) {
        dependsOnIndices.push(j);
        reasons.push(`Context file overlap with task ${j}`);
        continue;
      }

      // 3. Keyword matching from titles and descriptions
      const prevKeywords = extractKeywords(prevTask.title + " " + prevTask.goal);
      const currKeywords = extractKeywords(task.title + " " + task.goal);
      const keywordOverlap = prevKeywords.filter((k) => currKeywords.includes(k));

      if (keywordOverlap.length >= 2) {
        dependsOnIndices.push(j);
        reasons.push(`Keyword overlap: ${keywordOverlap.slice(0, 3).join(", ")}`);
      }
    }

    // Calculate confidence
    const confidence = dependsOnIndices.length > 0 ? 0.7 : 1.0;

    resolutions.push({
      taskIndex: i,
      dependsOnIndices,
      dependsOnIds: [], // converted to IDs later
      confidence,
      reason: reasons.join("; ") || "No dependencies detected",
    });
  }

  return resolutions;
}

function normalizePathForOverlap(path: string): string {
  return path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "")
    .replace(/^\/+/u, "")
    .replace(/\*\*/gu, "")
    .replace(/\*/gu, "")
    .replace(/\/+/gu, "/")
    .replace(/\/$/u, "");
}

// Check if paths overlap (glob-aware)
export function pathsOverlap(path1: string, path2: string): boolean {
  const trimmed1 = path1.trim();
  const trimmed2 = path2.trim();
  if (trimmed1 === "**" || trimmed2 === "**") {
    return true;
  }

  const normalized1 = normalizePathForOverlap(path1);
  const normalized2 = normalizePathForOverlap(path2);
  if (!normalized1 || !normalized2) {
    return false;
  }

  return (
    normalized1 === normalized2 ||
    normalized1.startsWith(`${normalized2}/`) ||
    normalized2.startsWith(`${normalized1}/`)
  );
}

// Extract keywords from text
function extractKeywords(text: string): string[] {
  // Exclude common stop words
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "as",
    "is",
    "was",
    "are",
    "were",
    "been",
    "be",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "add",
    "update",
    "fix",
    "create",
    "implement",
    "remove",
    "delete",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

// Convert indices to task IDs
export async function resolveIndicesToIds(
  resolutions: DependencyResolution[],
  taskIds: string[],
): Promise<DependencyResolution[]> {
  return resolutions.map((r) => ({
    ...r,
    dependsOnIds: r.dependsOnIndices
      .map((idx) => taskIds[idx])
      .filter((id): id is string => id !== undefined),
  }));
}

// Duplicate task detection
export interface DuplicateDetection {
  taskIndex: number;
  duplicateOfId?: string;
  duplicateOfIndex?: number;
  similarity: number;
  reason: string;
}

// Check for duplicates between new tasks and existing tasks
export async function detectDuplicates(newTasks: CreateTaskInput[]): Promise<DuplicateDetection[]> {
  const detections: DuplicateDetection[] = [];

  // Fetch existing queued and running tasks
  const existingTasks = await db
    .select()
    .from(tasks)
    .where(
      or(eq(tasks.status, "queued"), eq(tasks.status, "running"), eq(tasks.status, "blocked")),
    );

  for (let i = 0; i < newTasks.length; i++) {
    const newTask = newTasks[i];
    if (!newTask) continue;

    // Check for identical title
    const sameTitleTask = existingTasks.find(
      (t) => t.title.toLowerCase() === newTask.title.toLowerCase(),
    );

    if (sameTitleTask) {
      detections.push({
        taskIndex: i,
        duplicateOfId: sameTitleTask.id,
        similarity: 1.0,
        reason: "Identical title",
      });
      continue;
    }

    // Check for similar goal
    const similarGoalTask = existingTasks.find((t) => {
      const similarity = calculateSimilarity(t.goal, newTask.goal);
      return similarity > 0.8;
    });

    if (similarGoalTask) {
      const similarity = calculateSimilarity(similarGoalTask.goal, newTask.goal);
      detections.push({
        taskIndex: i,
        duplicateOfId: similarGoalTask.id,
        similarity,
        reason: "Similar goal",
      });
      continue;
    }

    // Combination of identical file paths and similar title
    const pathOverlapTask = existingTasks.find((t) => {
      const pathMatch = t.allowedPaths.some((p) =>
        newTask.allowedPaths.some((np) => pathsOverlap(p, np)),
      );
      const titleSimilarity = calculateSimilarity(t.title, newTask.title);
      return pathMatch && titleSimilarity > 0.6;
    });

    if (pathOverlapTask) {
      const similarity = calculateSimilarity(pathOverlapTask.title, newTask.title);
      detections.push({
        taskIndex: i,
        duplicateOfId: pathOverlapTask.id,
        similarity,
        reason: "Same file paths with similar title",
      });
      continue;
    }

    // No duplicate
    detections.push({
      taskIndex: i,
      similarity: 0,
      reason: "No duplicate detected",
    });
  }

  // Also check for duplicates among new tasks
  for (let i = 0; i < newTasks.length; i++) {
    const task1 = newTasks[i];
    if (!task1) continue;

    for (let j = i + 1; j < newTasks.length; j++) {
      const task2 = newTasks[j];
      if (!task2) continue;

      const similarity = calculateSimilarity(
        task1.title + " " + task1.goal,
        task2.title + " " + task2.goal,
      );

      if (similarity > 0.8) {
        // Mark the later task as a duplicate
        const existing = detections.find((d) => d.taskIndex === j);
        if (existing && (!existing.duplicateOfIndex || existing.similarity < similarity)) {
          existing.duplicateOfIndex = i;
          existing.similarity = similarity;
          existing.reason = `Duplicate of new task ${i}`;
        }
      }
    }
  }

  return detections;
}

// Calculate string similarity (Jaccard coefficient based)
function calculateSimilarity(str1: string, str2: string): number {
  const words1 = new Set(extractKeywords(str1));
  const words2 = new Set(extractKeywords(str2));

  if (words1.size === 0 || words2.size === 0) {
    return 0;
  }

  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

// Return a task list with duplicates removed
export function filterDuplicateTasks(
  tasks: CreateTaskInput[],
  detections: DuplicateDetection[],
  similarityThreshold: number = 0.8,
): {
  uniqueTasks: CreateTaskInput[];
  skippedIndices: number[];
  skippedReasons: string[];
} {
  const skippedIndices: number[] = [];
  const skippedReasons: string[] = [];

  for (const detection of detections) {
    if (
      detection.similarity >= similarityThreshold &&
      (detection.duplicateOfId || detection.duplicateOfIndex !== undefined)
    ) {
      skippedIndices.push(detection.taskIndex);
      skippedReasons.push(detection.reason);
    }
  }

  const uniqueTasks = tasks.filter((_, i) => !skippedIndices.includes(i));

  return {
    uniqueTasks,
    skippedIndices,
    skippedReasons,
  };
}
