import { FAILURE_CODE } from "./failure-codes";

export type FailureCategory =
  | "env"
  | "setup"
  | "permission"
  | "noop"
  | "policy"
  | "test"
  | "flaky"
  | "model"
  | "model_loop";

export type FailureClassification = {
  category: FailureCategory;
  retryable: boolean;
  reason: string;
};

const ANSI_ESCAPE_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNormalizedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function extractFailureCode(errorMeta: unknown): string | null {
  if (!isRecord(errorMeta)) {
    return null;
  }
  return toNormalizedString(errorMeta.failureCode);
}

export function extractFailedCommandFromErrorMeta(errorMeta: unknown): string | null {
  if (!isRecord(errorMeta)) {
    return null;
  }
  return toNormalizedString(errorMeta.failedCommand);
}

export function extractPolicyViolationsFromErrorMeta(errorMeta: unknown): string[] {
  if (!isRecord(errorMeta)) {
    return [];
  }
  const raw = errorMeta.policyViolations;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isCommandSubstitutionVerificationFailure(message: string): boolean {
  return /verification failed at .*?\$\(.+?\).*?\[explicit\]:\s*stderr unavailable/.test(message);
}

function isExplicitArtifactPresenceCheckFailure(message: string): boolean {
  return (
    /verification failed at\s+test\s+-(?:f|s)\s+.+?\s+\[explicit\]:\s*stderr unavailable/.test(
      message,
    ) && /(?:^|[\s"'./])(artifact|artifacts|build|debug|dist|out|release|target)\//.test(message)
  );
}

export function classifyFailureByCode(failureCode: string): FailureClassification | null {
  const code = failureCode.toLowerCase();
  if (code === FAILURE_CODE.EXTERNAL_DIRECTORY_PERMISSION_PROMPT) {
    return {
      category: "permission",
      retryable: false,
      reason: FAILURE_CODE.EXTERNAL_DIRECTORY_PERMISSION_PROMPT,
    };
  }
  if (code === FAILURE_CODE.NO_ACTIONABLE_CHANGES) {
    return {
      category: "noop",
      retryable: false,
      reason: FAILURE_CODE.NO_ACTIONABLE_CHANGES,
    };
  }
  if (code === FAILURE_CODE.POLICY_VIOLATION) {
    return {
      category: "policy",
      retryable: true,
      reason: FAILURE_CODE.POLICY_VIOLATION,
    };
  }
  if (code === FAILURE_CODE.VERIFICATION_COMMAND_MISSING_SCRIPT) {
    return {
      category: "setup",
      retryable: false,
      reason: FAILURE_CODE.VERIFICATION_COMMAND_MISSING_SCRIPT,
    };
  }
  if (code === FAILURE_CODE.VERIFICATION_COMMAND_NO_TEST_FILES) {
    return {
      category: "setup",
      retryable: false,
      reason: FAILURE_CODE.VERIFICATION_COMMAND_NO_TEST_FILES,
    };
  }
  if (code === FAILURE_CODE.VERIFICATION_COMMAND_MISSING_MAKE_TARGET) {
    return {
      category: "setup",
      retryable: false,
      reason: FAILURE_CODE.VERIFICATION_COMMAND_MISSING_MAKE_TARGET,
    };
  }
  if (code === FAILURE_CODE.VERIFICATION_COMMAND_UNSUPPORTED_FORMAT) {
    return {
      category: "setup",
      retryable: false,
      reason: FAILURE_CODE.VERIFICATION_COMMAND_UNSUPPORTED_FORMAT,
    };
  }
  if (code === FAILURE_CODE.VERIFICATION_COMMAND_SEQUENCE_ISSUE) {
    return {
      category: "setup",
      retryable: false,
      reason: FAILURE_CODE.VERIFICATION_COMMAND_SEQUENCE_ISSUE,
    };
  }
  if (code === FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE) {
    return {
      category: "setup",
      retryable: true,
      reason: FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE,
    };
  }
  if (code === FAILURE_CODE.ENVIRONMENT_ISSUE || code === FAILURE_CODE.QUOTA_FAILURE) {
    return {
      category: "env",
      retryable: true,
      reason: FAILURE_CODE.ENVIRONMENT_ISSUE,
    };
  }
  if (code === FAILURE_CODE.VERIFICATION_COMMAND_FAILED || code === FAILURE_CODE.TEST_FAILURE) {
    return {
      category: "test",
      retryable: true,
      reason: FAILURE_CODE.TEST_FAILURE,
    };
  }
  if (code === FAILURE_CODE.TRANSIENT_OR_FLAKY_FAILURE) {
    return {
      category: "flaky",
      retryable: true,
      reason: FAILURE_CODE.TRANSIENT_OR_FLAKY_FAILURE,
    };
  }
  if (code === FAILURE_CODE.MODEL_DOOM_LOOP) {
    return {
      category: "model_loop",
      retryable: true,
      reason: FAILURE_CODE.MODEL_DOOM_LOOP,
    };
  }
  if (code === FAILURE_CODE.MODEL_OR_UNKNOWN_FAILURE) {
    return {
      category: "model",
      retryable: true,
      reason: FAILURE_CODE.MODEL_OR_UNKNOWN_FAILURE,
    };
  }
  if (code === FAILURE_CODE.EXECUTION_FAILED) {
    return null;
  }
  return null;
}

export function classifyFailure(
  errorMessage: string | null,
  errorMeta?: unknown,
): FailureClassification {
  const structuredFailureCode = extractFailureCode(errorMeta);
  if (structuredFailureCode) {
    const structuredClassification = classifyFailureByCode(structuredFailureCode);
    if (structuredClassification) {
      return structuredClassification;
    }
  }

  const message = (errorMessage ?? "").toLowerCase();

  if (
    /external_directory permission prompt|permission required:\s*external_directory/.test(message)
  ) {
    return {
      category: "permission",
      retryable: false,
      reason: FAILURE_CODE.EXTERNAL_DIRECTORY_PERMISSION_PROMPT,
    };
  }

  if (/no changes were made|no relevant changes were made|no commits between/.test(message)) {
    return {
      category: "noop",
      retryable: false,
      reason: FAILURE_CODE.NO_ACTIONABLE_CHANGES,
    };
  }

  if (/policy violation|denied command|outside allowed paths|change to denied path/.test(message)) {
    return {
      category: "policy",
      retryable: true,
      reason: FAILURE_CODE.POLICY_VIOLATION,
    };
  }

  if (
    /no test files found|no tests found|no files found matching/.test(message)
  ) {
    return {
      category: "setup",
      retryable: false,
      reason: FAILURE_CODE.VERIFICATION_COMMAND_NO_TEST_FILES,
    };
  }

  if (
    /err_pnpm_no_script|missing script|could not read package\.json|enoent.*package\.json|no rule to make target/.test(
      message,
    )
  ) {
    return {
      category: "setup",
      retryable: false,
      reason: FAILURE_CODE.VERIFICATION_COMMAND_MISSING_SCRIPT,
    };
  }

  if (
    /unsupported command format|shell operators are not allowed|verification failed at .*shell operators/.test(
      message,
    ) ||
    isCommandSubstitutionVerificationFailure(message)
  ) {
    return {
      category: "setup",
      retryable: false,
      reason: FAILURE_CODE.VERIFICATION_COMMAND_UNSUPPORTED_FORMAT,
    };
  }

  if (isExplicitArtifactPresenceCheckFailure(message)) {
    return {
      category: "setup",
      retryable: false,
      reason: FAILURE_CODE.VERIFICATION_COMMAND_SEQUENCE_ISSUE,
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
      reason: FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE,
    };
  }

  if (/database_url|redis_url|connection refused|dns|env/.test(message)) {
    return {
      category: "env",
      retryable: true,
      reason: FAILURE_CODE.ENVIRONMENT_ISSUE,
    };
  }

  if (/vitest|playwright|assert|expected|test failed|verification commands failed/.test(message)) {
    return {
      category: "test",
      retryable: true,
      reason: FAILURE_CODE.TEST_FAILURE,
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
      reason: FAILURE_CODE.TRANSIENT_OR_FLAKY_FAILURE,
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
      reason: FAILURE_CODE.MODEL_DOOM_LOOP,
    };
  }

  return {
    category: "model",
    retryable: true,
    reason: FAILURE_CODE.MODEL_OR_UNKNOWN_FAILURE,
  };
}

export function normalizeFailureSignature(
  errorMessage: string | null,
  errorMeta?: unknown,
  maxLength = 400,
): string {
  const failureCodePrefix = extractFailureCode(errorMeta);
  const normalizedMessage = (errorMessage ?? "")
    .toLowerCase()
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<uuid>")
    .replace(/\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  if (!failureCodePrefix) {
    return normalizedMessage;
  }
  return `code:${failureCodePrefix.toLowerCase()} ${normalizedMessage}`.trim();
}
