import { describe, expect, it } from "vitest";
import {
  isExternalDirectoryPermissionPromptFailure,
  isQuotaFailure,
} from "../src/worker-task-helpers";

describe("worker-task-helpers", () => {
  it("detects external directory permission prompts", () => {
    expect(
      isExternalDirectoryPermissionPromptFailure(
        "[OpenCode] external_directory permission prompt blocked the run",
      ),
    ).toBe(true);
    expect(
      isExternalDirectoryPermissionPromptFailure("Permission required: external_directory"),
    ).toBe(true);
  });

  it("does not treat unrelated errors as permission prompts", () => {
    expect(isExternalDirectoryPermissionPromptFailure("make: *** [test] Error 1")).toBe(false);
  });

  it("detects quota failures", () => {
    expect(isQuotaFailure("Quota limit reached. Aborting.")).toBe(true);
    expect(isQuotaFailure("RESOURCE_EXHAUSTED")).toBe(true);
    expect(
      isQuotaFailure(
        "Claude Code failed with exit code 1: rate_limit\nYou've hit your limit · resets 12am (Asia/Tokyo)",
      ),
    ).toBe(true);
    expect(isQuotaFailure("HTTP 429 Too Many Requests")).toBe(true);
    expect(
      isQuotaFailure(
        "Executor throttled this API request. Please wait 5 minutes, then retry.",
      ),
    ).toBe(true);
    expect(isQuotaFailure("Request rate-limited. Reset at 00:00 UTC.")).toBe(true);
  });

  it("does not over-classify non-quota failures", () => {
    expect(isQuotaFailure("Unit test failed: expected rate limit header to equal 10")).toBe(false);
    expect(isQuotaFailure("Build failed: memory limit exceeded in webpack")).toBe(false);
  });
});
