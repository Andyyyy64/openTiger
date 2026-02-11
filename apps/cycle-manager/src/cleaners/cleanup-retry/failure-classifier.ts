import { db } from "@openTiger/db";
import { runs } from "@openTiger/db/schema";
import { eq, inArray, and, desc } from "drizzle-orm";
import type { FailureClassification } from "./types";

// Strip ANSI escapes to stabilize failure messages
const ANSI_ESCAPE_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function classifyFailure(errorMessage: string | null): FailureClassification {
  const message = (errorMessage ?? "").toLowerCase();

  if (
    /external_directory permission prompt|permission required:\s*external_directory/.test(message)
  ) {
    return {
      category: "permission",
      retryable: false,
      reason: "external_directory_permission_prompt",
      blockReason: "needs_rework",
    };
  }

  if (/no changes were made|no relevant changes were made|no commits between/.test(message)) {
    return {
      category: "noop",
      retryable: false,
      reason: "no_actionable_changes",
      blockReason: "needs_rework",
    };
  }

  if (/policy violation|denied command|outside allowed paths|change to denied path/.test(message)) {
    return {
      category: "policy",
      retryable: true,
      reason: "policy_violation",
      blockReason: "needs_rework",
    };
  }

  if (/err_pnpm_no_script|missing script/.test(message)) {
    return {
      category: "setup",
      retryable: false,
      reason: "verification_command_missing_script",
      blockReason: "needs_rework",
    };
  }

  if (
    /package\.json|pnpm-workspace\.yaml|cannot find module|enoent|command not found|repository not found|authentication failed|permission denied|no commits between|no history in common/.test(
      message,
    )
  ) {
    return {
      category: "setup",
      retryable: true,
      reason: "setup_or_bootstrap_issue",
      blockReason: "needs_rework",
    };
  }

  if (/database_url|redis_url|connection refused|dns|env/.test(message)) {
    return {
      category: "env",
      retryable: true,
      reason: "environment_issue",
      blockReason: "needs_rework",
    };
  }

  if (/vitest|playwright|assert|expected|test failed|verification commands failed/.test(message)) {
    return {
      category: "test",
      retryable: true,
      reason: "test_failure",
      blockReason: "needs_rework",
    };
  }

  if (
    /rate limit|429|503|502|timeout|timed out|econnreset|eai_again|temporarily unavailable/.test(
      message,
    )
  ) {
    return {
      category: "flaky",
      retryable: true,
      reason: "transient_or_flaky_failure",
      blockReason: "needs_rework",
    };
  }

  if (
    /doom loop detected|excessive planning chatter detected|unsupported pseudo tool call detected: todo/.test(
      message,
    )
  ) {
    return {
      category: "model_loop",
      retryable: true,
      reason: "model_doom_loop",
      blockReason: "needs_rework",
    };
  }

  return {
    category: "model",
    retryable: true,
    reason: "model_or_unknown_failure",
    blockReason: "needs_rework",
  };
}

function normalizeFailureSignature(errorMessage: string | null): string {
  return (errorMessage ?? "")
    .toLowerCase()
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>")
    .replace(/\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export async function hasRepeatedFailureSignature(
  taskId: string,
  latestErrorMessage: string | null,
  threshold = 3,
): Promise<boolean> {
  if (threshold <= 1) {
    return true;
  }

  const latestSignature = normalizeFailureSignature(latestErrorMessage);
  if (!latestSignature) {
    return false;
  }

  const recentRuns = await db
    .select({ errorMessage: runs.errorMessage })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, ["failed", "cancelled"])))
    .orderBy(desc(runs.startedAt))
    .limit(threshold);

  if (recentRuns.length < threshold) {
    return false;
  }

  return recentRuns.every((run) => normalizeFailureSignature(run.errorMessage) === latestSignature);
}
