import { afterEach, describe, expect, it } from "vitest";
import { shouldSkipExplicitCommandFailure } from "../src/steps/verify/verify-changes";

const originalSkipEnv = process.env.WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT;

afterEach(() => {
  if (originalSkipEnv === undefined) {
    delete process.env.WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT;
  } else {
    process.env.WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT = originalSkipEnv;
  }
});

describe("shouldSkipExplicitCommandFailure", () => {
  const missingScriptOutput = 'npm error Missing script: "dev"';

  it("skips when explicit command has remaining verification commands", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "npm run dev",
      output: missingScriptOutput,
      hasRemainingCommands: true,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("skips doc-only explicit missing script even when last command", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "npm run dev",
      output: missingScriptOutput,
      hasRemainingCommands: false,
      isDocOnlyChange: true,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("does not skip non-doc explicit missing script when last command", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "npm run dev",
      output: missingScriptOutput,
      hasRemainingCommands: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(false);
  });

  it("does not skip when feature is disabled", () => {
    process.env.WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT = "false";
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "npm run dev",
      output: missingScriptOutput,
      hasRemainingCommands: true,
      isDocOnlyChange: true,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(false);
  });

  it("skips no-op explicit missing script even when last command", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "npm run dev",
      output: missingScriptOutput,
      hasRemainingCommands: false,
      isDocOnlyChange: false,
      isNoOpChange: true,
    });

    expect(shouldSkip).toBe(true);
  });
});
