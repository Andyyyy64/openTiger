import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/cleaners/cleanup-retry/failure-classifier";

describe("classifyFailure", () => {
  it("maps structured unsupported verification command format to setup non-retryable", () => {
    const failure = classifyFailure(null, {
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

  it("falls back to model_or_unknown when failure code is unknown", () => {
    const failure = classifyFailure("any message", { failureCode: "unknown_code" });

    expect(failure).toEqual({
      category: "model",
      retryable: true,
      reason: "model_or_unknown_failure",
      blockReason: "needs_rework",
    });
  });

  it("does not classify message-only failures without structured failure code", () => {
    const failure = classifyFailure("ERR_PNPM_NO_SCRIPT Missing script: verify");

    expect(failure).toEqual({
      category: "model",
      retryable: true,
      reason: "model_or_unknown_failure",
      blockReason: "needs_rework",
    });
  });
});
