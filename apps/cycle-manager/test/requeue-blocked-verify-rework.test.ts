import { describe, expect, it } from "vitest";
import {
  extractVerifyReworkMeta,
  resolveOutsideAllowedViolationPaths,
  shouldRetryBlockedNeedsReworkInPlace,
  shouldRetryBlockedSetupFailure,
  stripVerifyReworkMarkers,
} from "../src/cleaners/cleanup-retry/requeue-blocked";

describe("verify rework marker helpers", () => {
  it("extracts verify rework metadata from encoded marker line", () => {
    const payload = encodeURIComponent(
      JSON.stringify({
        failedCommand: "pnpm --filter web run lint",
        failedCommandSource: "auto",
        stderrSummary: "ESLint couldn't find config",
      }),
    );
    const notes = `context line\n[verify-rework-json]${payload}\nother line`;

    const parsed = extractVerifyReworkMeta(notes);

    expect(parsed).toEqual({
      failedCommand: "pnpm --filter web run lint",
      failedCommandSource: "auto",
      stderrSummary: "ESLint couldn't find config",
    });
  });

  it("returns null when marker is malformed", () => {
    const notes = "[verify-rework-json]%%%invalid%%%";

    expect(extractVerifyReworkMeta(notes)).toBeNull();
  });

  it("strips marker lines while keeping other notes", () => {
    const payload = encodeURIComponent(
      JSON.stringify({
        failedCommand: "pnpm --filter web run build",
      }),
    );
    const notes = `line-1\n[verify-rework-json]${payload}\nline-2`;

    expect(stripVerifyReworkMarkers(notes)).toBe("line-1\nline-2");
  });

  it("prefers structured policy violations from errorMeta", () => {
    const paths = resolveOutsideAllowedViolationPaths("legacy message", {
      policyViolations: ["change outside allowed paths: apps/api/src/routes/tasks.ts"],
    });

    expect(paths).toEqual(["apps/api/src/routes/tasks.ts"]);
  });

  it("retries blocked setup failures while under setup retry limit", () => {
    const shouldRetry = shouldRetryBlockedSetupFailure({
      failureReason: "setup_or_bootstrap_issue",
      nextRetryCount: 2,
      setupRetryLimit: 3,
    });

    expect(shouldRetry).toBe(true);
  });

  it("stops retrying blocked setup failures after setup retry limit", () => {
    const shouldRetry = shouldRetryBlockedSetupFailure({
      failureReason: "setup_or_bootstrap_issue",
      nextRetryCount: 4,
      setupRetryLimit: 3,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not apply setup retry policy to other failure reasons", () => {
    const shouldRetry = shouldRetryBlockedSetupFailure({
      failureReason: "verification_command_failed",
      nextRetryCount: 1,
      setupRetryLimit: 3,
    });

    expect(shouldRetry).toBe(false);
  });

  it("retries blocked needs_rework in place for retryable non-policy failures", () => {
    const shouldRetry = shouldRetryBlockedNeedsReworkInPlace({
      failureReason: "verification_command_failed",
      failureRetryable: true,
      nextRetryCount: 2,
      inPlaceRetryLimit: 3,
    });

    expect(shouldRetry).toBe(true);
  });

  it("does not retry blocked needs_rework in place for policy violations", () => {
    const shouldRetry = shouldRetryBlockedNeedsReworkInPlace({
      failureReason: "policy_violation",
      failureRetryable: true,
      nextRetryCount: 1,
      inPlaceRetryLimit: 3,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not retry blocked needs_rework in place for non-retryable failures", () => {
    const shouldRetry = shouldRetryBlockedNeedsReworkInPlace({
      failureReason: "verification_command_no_test_files",
      failureRetryable: false,
      nextRetryCount: 1,
      inPlaceRetryLimit: 3,
    });

    expect(shouldRetry).toBe(false);
  });

  it("stops blocked needs_rework in-place retry after limit", () => {
    const shouldRetry = shouldRetryBlockedNeedsReworkInPlace({
      failureReason: "verification_command_failed",
      failureRetryable: true,
      nextRetryCount: 4,
      inPlaceRetryLimit: 3,
    });

    expect(shouldRetry).toBe(false);
  });
});
