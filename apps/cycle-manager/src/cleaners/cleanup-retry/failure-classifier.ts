import { db } from "@openTiger/db";
import { runs } from "@openTiger/db/schema";
import { classifyFailure as classifyFailureCore, normalizeFailureSignature } from "@openTiger/core";
import { eq, inArray, and, desc } from "drizzle-orm";
import type { FailureClassification } from "./types";

export function classifyFailure(
  errorMessage: string | null,
  errorMeta?: unknown,
): FailureClassification {
  const classification = classifyFailureCore(errorMessage, errorMeta);
  return {
    ...classification,
    blockReason: "needs_rework",
  };
}

export async function hasRepeatedFailureSignature(
  taskId: string,
  latestErrorMessage: string | null,
  latestErrorMeta?: unknown,
  threshold = 4,
): Promise<boolean> {
  if (threshold <= 1) {
    return true;
  }

  const latestSignature = normalizeFailureSignature(latestErrorMessage, latestErrorMeta);
  if (!latestSignature) {
    return false;
  }

  const recentRuns = await db
    .select({ errorMessage: runs.errorMessage, errorMeta: runs.errorMeta })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, ["failed", "cancelled"])))
    .orderBy(desc(runs.startedAt))
    .limit(threshold);

  if (recentRuns.length < threshold) {
    return false;
  }

  return recentRuns.every(
    (run) => normalizeFailureSignature(run.errorMessage, run.errorMeta) === latestSignature,
  );
}
