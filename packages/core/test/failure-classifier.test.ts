import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  classifyFailureByCode,
  extractFailedCommandFromErrorMeta,
  extractFailureCode,
  extractPolicyViolationsFromErrorMeta,
  normalizeFailureSignature,
} from "../src/failure-classifier";

describe("failure-classifier", () => {
  it("classifies by failureCode when structured metadata exists", () => {
    const failure = classifyFailure("ignored message", {
      failureCode: "verification_command_unsupported_format",
    });

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_unsupported_format",
    });
  });

  it("maps structured missing make target code", () => {
    const failure = classifyFailure("ignored", {
      failureCode: "verification_command_missing_make_target",
    });

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_missing_make_target",
    });
  });

  it("maps structured no-test-files code", () => {
    const failure = classifyFailure("ignored", {
      failureCode: "verification_command_no_test_files",
    });

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_no_test_files",
    });
  });

  it("maps structured setup_or_bootstrap_issue code", () => {
    const failure = classifyFailure("ignored", {
      failureCode: "setup_or_bootstrap_issue",
    });

    expect(failure).toEqual({
      category: "setup",
      retryable: true,
      reason: "setup_or_bootstrap_issue",
    });
  });

  it("falls back to message classification for execution_failed", () => {
    const failure = classifyFailure("Permission required: external_directory", {
      failureCode: "execution_failed",
    });

    expect(failure).toEqual({
      category: "permission",
      retryable: false,
      reason: "external_directory_permission_prompt",
    });
  });

  it("classifies branch divergence as non-retryable setup failure", () => {
    const failure = classifyFailure("branch_diverged_requires_recreate:local_behind_remote");

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "branch_diverged_requires_recreate",
    });
  });

  it("keeps legacy message fallback when errorMeta is missing", () => {
    const failure = classifyFailure("ERR_PNPM_NO_SCRIPT Missing script: verify");

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_missing_script",
    });
  });

  it("classifies no-test-files output as setup failure", () => {
    const failure = classifyFailure("No test files found, exiting with code 1");

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_no_test_files",
    });
  });

  it("returns null for unknown structured failure code", () => {
    const mapped = classifyFailureByCode("unknown_code");
    expect(mapped).toBeNull();
  });

  it("extracts structured failure metadata fields", () => {
    const errorMeta = {
      failureCode: "policy_violation",
      failedCommand: "make test",
      policyViolations: ["change outside allowed paths: Makefile", "  "],
    };

    expect(extractFailureCode(errorMeta)).toBe("policy_violation");
    expect(extractFailedCommandFromErrorMeta(errorMeta)).toBe("make test");
    expect(extractPolicyViolationsFromErrorMeta(errorMeta)).toEqual([
      "change outside allowed paths: Makefile",
    ]);
  });

  it("prefixes normalized signature with failure code", () => {
    const signature = normalizeFailureSignature(
      "Verification failed at make test [auto]: stderr unavailable",
      { failureCode: "verification_command_failed" },
    );

    expect(signature.startsWith("code:verification_command_failed ")).toBe(true);
  });
});
