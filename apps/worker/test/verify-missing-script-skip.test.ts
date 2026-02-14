import { afterEach, describe, expect, it } from "vitest";
import {
  shouldSkipAutoCommandFailure,
  shouldSkipExplicitCommandFailure,
} from "../src/steps/verify/verify-changes";

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
  const unsupportedFormatOutput = "Unsupported command format. Shell operators are not allowed.";
  const missingMakeTargetOutput = "make: *** No rule to make target 'test'.  Stop.";
  const missingManifestOutput =
    "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/tmp/repo/package.json'";

  it("skips when explicit command has remaining verification commands", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "npm run dev",
      output: missingScriptOutput,
      hasRemainingCommands: true,
      hasPriorEffectiveCommand: false,
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
      hasPriorEffectiveCommand: false,
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
      hasPriorEffectiveCommand: false,
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
      hasPriorEffectiveCommand: false,
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
      hasPriorEffectiveCommand: false,
      isDocOnlyChange: false,
      isNoOpChange: true,
    });

    expect(shouldSkip).toBe(true);
  });

  it("treats missing make target as skippable explicit setup failure when remaining commands exist", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "make test",
      output: missingMakeTargetOutput,
      hasRemainingCommands: true,
      hasPriorEffectiveCommand: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("skips explicit unsupported command format when remaining commands exist", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "file kernel/kernel.elf | grep -q riscv",
      output: unsupportedFormatOutput,
      hasRemainingCommands: true,
      hasPriorEffectiveCommand: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("skips command substitution format when remaining commands exist", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: 'test -z "$(git ls-files tests/test_runner)"',
      output: "",
      hasRemainingCommands: true,
      hasPriorEffectiveCommand: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("does not skip explicit unsupported command format when it is the last non-doc command", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "file kernel/kernel.elf | grep -q riscv",
      output: unsupportedFormatOutput,
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(false);
  });

  it("does not skip command substitution format when it is the last non-doc command", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: 'test -z "$(git ls-files tests/test_runner)"',
      output: "",
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(false);
  });

  it("skips unsupported format when prior command already passed", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "timeout 5 scripts/qemu-run.sh | grep -q boot",
      output: unsupportedFormatOutput,
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: true,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("skips missing package manifest on doc-only explicit command", () => {
    const shouldSkip = shouldSkipExplicitCommandFailure({
      source: "explicit",
      command: "npm run dev",
      output: missingManifestOutput,
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: false,
      isDocOnlyChange: true,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });
});

describe("shouldSkipAutoCommandFailure", () => {
  const missingScriptOutput = 'npm error Missing script: "verify"';
  const missingMakeTargetOutput = "make: *** No rule to make target 'test'.  Stop.";

  it("skips invalid auto command when prior effective command already passed", () => {
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "make test",
      output: missingMakeTargetOutput,
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: true,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("skips invalid auto command when remaining commands exist", () => {
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "pnpm run verify",
      output: missingScriptOutput,
      hasRemainingCommands: true,
      hasPriorEffectiveCommand: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("does not skip auto command when no prior effective command and no remaining commands", () => {
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "make test",
      output: missingMakeTargetOutput,
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(false);
  });
});
