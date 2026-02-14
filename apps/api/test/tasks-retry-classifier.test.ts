import { describe, expect, it } from "vitest";
import { classifyFailureForRetry } from "../src/routes/tasks";

describe("classifyFailureForRetry", () => {
  it("uses structured failureCode when available", () => {
    const failure = classifyFailureForRetry("ignored", {
      failureCode: "verification_command_unsupported_format",
    });

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
    });
  });

  it("falls back to message classification for execution_failed", () => {
    const failure = classifyFailureForRetry("Permission required: external_directory", {
      failureCode: "execution_failed",
    });

    expect(failure).toEqual({
      category: "permission",
      retryable: false,
    });
  });

  it("keeps legacy message classification when errorMeta is missing", () => {
    const failure = classifyFailureForRetry("Verification commands failed");

    expect(failure).toEqual({
      category: "test",
      retryable: true,
    });
  });
});
