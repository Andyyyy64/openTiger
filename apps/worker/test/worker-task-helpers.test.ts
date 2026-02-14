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
  });
});
