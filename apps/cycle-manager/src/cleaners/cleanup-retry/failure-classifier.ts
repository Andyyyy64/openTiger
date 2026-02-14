import { db } from "@openTiger/db";
import { runs } from "@openTiger/db/schema";
import { eq, inArray, and, desc } from "drizzle-orm";
import type { FailureClassification } from "./types";

// Strip ANSI escapes to stabilize failure messages
const ANSI_ESCAPE_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractFailureCode(errorMeta: unknown): string | null {
  if (!isRecord(errorMeta)) {
    return null;
  }
  const raw = errorMeta.failureCode;
  if (typeof raw !== "string") {
    return null;
  }
  const code = raw.trim();
  return code.length > 0 ? code : null;
}

function classifyFailureByCode(failureCode: string): FailureClassification | null {
  const code = failureCode.toLowerCase();
  if (code === "external_directory_permission_prompt") {
    return {
      category: "permission",
      retryable: false,
      reason: "external_directory_permission_prompt",
      blockReason: "needs_rework",
    };
  }
  if (code === "no_actionable_changes") {
    return {
      category: "noop",
      retryable: false,
      reason: "no_actionable_changes",
      blockReason: "needs_rework",
    };
  }
  if (code === "policy_violation") {
    return {
      category: "policy",
      retryable: true,
      reason: "policy_violation",
      blockReason: "needs_rework",
    };
  }
  if (code === "verification_command_missing_script") {
    return {
      category: "setup",
      retryable: false,
      reason: "verification_command_missing_script",
      blockReason: "needs_rework",
    };
  }
  if (code === "verification_command_unsupported_format") {
    return {
      category: "setup",
      retryable: false,
      reason: "verification_command_unsupported_format",
      blockReason: "needs_rework",
    };
  }
  if (code === "verification_command_sequence_issue") {
    return {
      category: "setup",
      retryable: false,
      reason: "verification_command_sequence_issue",
      blockReason: "needs_rework",
    };
  }
  if (code === "setup_or_bootstrap_issue") {
    return {
      category: "setup",
      retryable: true,
      reason: "setup_or_bootstrap_issue",
      blockReason: "needs_rework",
    };
  }
  if (code === "environment_issue" || code === "quota_failure") {
    return {
      category: "env",
      retryable: true,
      reason: "environment_issue",
      blockReason: "needs_rework",
    };
  }
  if (code === "verification_command_failed" || code === "test_failure") {
    return {
      category: "test",
      retryable: true,
      reason: "test_failure",
      blockReason: "needs_rework",
    };
  }
  if (code === "transient_or_flaky_failure") {
    return {
      category: "flaky",
      retryable: true,
      reason: "transient_or_flaky_failure",
      blockReason: "needs_rework",
    };
  }
  if (code === "model_doom_loop") {
    return {
      category: "model_loop",
      retryable: true,
      reason: "model_doom_loop",
      blockReason: "needs_rework",
    };
  }
  if (code === "model_or_unknown_failure" || code === "execution_failed") {
    return {
      category: "model",
      retryable: true,
      reason: "model_or_unknown_failure",
      blockReason: "needs_rework",
    };
  }
  return null;
}

export function classifyFailure(
  _errorMessage: string | null,
  errorMeta?: unknown,
): FailureClassification {
  const structuredFailureCode = extractFailureCode(errorMeta);
  if (structuredFailureCode) {
    const structuredClassification = classifyFailureByCode(structuredFailureCode);
    if (structuredClassification) {
      return structuredClassification;
    }
  }

  return {
    category: "model",
    retryable: true,
    reason: "model_or_unknown_failure",
    blockReason: "needs_rework",
  };
}

function normalizeFailureSignature(errorMessage: string | null, errorMeta?: unknown): string {
  const failureCodePrefix = extractFailureCode(errorMeta);
  const normalizedMessage = (errorMessage ?? "")
    .toLowerCase()
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>")
    .replace(/\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  if (!failureCodePrefix) {
    return normalizedMessage;
  }
  return `code:${failureCodePrefix.toLowerCase()} ${normalizedMessage}`.trim();
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
