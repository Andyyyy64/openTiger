import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/cleaners/cleanup-retry/failure-classifier";

describe("classifyFailure", () => {
  it("maps structured unsupported verification command format to setup non-retryable", () => {
    const failure = classifyFailure("ignored", {
      failureCode: "verification_command_unsupported_format",
    });

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_unsupported_format",
      blockReason: "needs_rework",
    });
  });

  it("maps structured missing script code to setup non-retryable", () => {
    const failure = classifyFailure(null, { failureCode: "verification_command_missing_script" });

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_missing_script",
      blockReason: "needs_rework",
    });
  });

  it("maps structured missing make target code to setup non-retryable", () => {
    const failure = classifyFailure(null, {
      failureCode: "verification_command_missing_make_target",
    });

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_missing_make_target",
      blockReason: "needs_rework",
    });
  });

  it("maps structured no-test-files code to setup non-retryable", () => {
    const failure = classifyFailure(null, {
      failureCode: "verification_command_no_test_files",
    });

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_no_test_files",
      blockReason: "needs_rework",
    });
  });

  it("maps structured sequence issue code to setup non-retryable", () => {
    const failure = classifyFailure(null, { failureCode: "verification_command_sequence_issue" });

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_sequence_issue",
      blockReason: "needs_rework",
    });
  });

  it("maps structured verification command failed code to test category", () => {
    const failure = classifyFailure(null, { failureCode: "verification_command_failed" });

    expect(failure).toEqual({
      category: "test",
      retryable: true,
      reason: "test_failure",
      blockReason: "needs_rework",
    });
  });

  it("maps structured setup_or_bootstrap_issue code to setup retryable", () => {
    const failure = classifyFailure(null, { failureCode: "setup_or_bootstrap_issue" });

    expect(failure).toEqual({
      category: "setup",
      retryable: true,
      reason: "setup_or_bootstrap_issue",
      blockReason: "needs_rework",
    });
  });

  it("falls back to message parsing when failure code is unknown", () => {
    const failure = classifyFailure("Policy violation: change outside allowed paths", {
      failureCode: "unknown_code",
    });

    expect(failure).toEqual({
      category: "policy",
      retryable: true,
      reason: "policy_violation",
      blockReason: "needs_rework",
    });
  });

  it("falls back to message parsing when failure code is execution_failed", () => {
    const failure = classifyFailure("Permission required: external_directory", {
      failureCode: "execution_failed",
    });

    expect(failure).toEqual({
      category: "permission",
      retryable: false,
      reason: "external_directory_permission_prompt",
      blockReason: "needs_rework",
    });
  });

  it("classifies message-only missing script failures", () => {
    const failure = classifyFailure("ERR_PNPM_NO_SCRIPT Missing script: verify");

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_missing_script",
      blockReason: "needs_rework",
    });
  });

  it("classifies message-only sequence issue failures", () => {
    const failure = classifyFailure(
      "Verification failed at test -f build/kernel.elf [explicit]: stderr unavailable",
    );

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_sequence_issue",
      blockReason: "needs_rework",
    });
  });

  it("classifies message-only no-test-files failures", () => {
    const failure = classifyFailure("No test files found, exiting with code 1");

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_no_test_files",
      blockReason: "needs_rework",
    });
  });

  it("falls back to model_or_unknown when both structured and message classification are unavailable", () => {
    const failure = classifyFailure("something unknown", { failureCode: "unknown_code" });

    expect(failure).toEqual({
      category: "model",
      retryable: true,
      reason: "model_or_unknown_failure",
      blockReason: "needs_rework",
    });
  });
});
