import { afterEach, describe, expect, it } from "vitest";
import {
  resolveVerificationCommandFailureCode,
  shouldSkipAutoCommandFailure,
  shouldSkipExplicitCommandFailure,
} from "../src/steps/verify/verify-changes";
import { FAILURE_CODE } from "@openTiger/core";

const originalSkipEnv = process.env.WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT;
const originalAutoNonBlockingEnv = process.env.WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS;

afterEach(() => {
  if (originalSkipEnv === undefined) {
    delete process.env.WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT;
  } else {
    process.env.WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT = originalSkipEnv;
  }
  if (originalAutoNonBlockingEnv === undefined) {
    delete process.env.WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS;
  } else {
    process.env.WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS = originalAutoNonBlockingEnv;
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
  const noTestFilesOutput = "No test files found, exiting with code 1";

  it("skips invalid auto command when prior effective command already passed", () => {
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "make test",
      output: missingMakeTargetOutput,
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: true,
      hasPriorExplicitCommandPass: false,
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
      hasPriorExplicitCommandPass: false,
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
      hasPriorExplicitCommandPass: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(false);
  });

  it("skips auto command when test runner reports no test files and prior command already passed", () => {
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "pnpm run test",
      output: noTestFilesOutput,
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: true,
      hasPriorExplicitCommandPass: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("does not skip no-test-files auto command when it is the only effective verification command", () => {
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "pnpm run test",
      output: noTestFilesOutput,
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: false,
      hasPriorExplicitCommandPass: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(false);
  });

  it("skips unknown auto command failure when explicit verification already passed", () => {
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "pnpm run test",
      output: "Unexpected framework failure signature",
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: true,
      hasPriorExplicitCommandPass: true,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("skips unknown auto command failure when any prior effective verification passed", () => {
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "pnpm run test",
      output: "Unexpected framework failure signature",
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: true,
      hasPriorExplicitCommandPass: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(true);
  });

  it("does not skip unknown auto command failure when no prior effective verification passed", () => {
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "pnpm run test",
      output: "Unexpected framework failure signature",
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: false,
      hasPriorExplicitCommandPass: false,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(false);
  });

  it("can disable unknown auto command non-blocking fallback", () => {
    process.env.WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS = "false";
    const shouldSkip = shouldSkipAutoCommandFailure({
      source: "auto",
      command: "pnpm run test",
      output: "Unexpected framework failure signature",
      hasRemainingCommands: false,
      hasPriorEffectiveCommand: true,
      hasPriorExplicitCommandPass: true,
      isDocOnlyChange: false,
      isNoOpChange: false,
    });

    expect(shouldSkip).toBe(false);
  });
});

describe("resolveVerificationCommandFailureCode", () => {
  it("maps missing package errors to setup_or_bootstrap_issue", () => {
    const code = resolveVerificationCommandFailureCode({
      verificationCommands: [
        {
          command: "pnpm --filter @flowprocure/web run test",
          source: "auto",
        },
      ],
      index: 0,
      command: "pnpm --filter @flowprocure/web run test",
      output:
        "failed to load config from /tmp/repo/apps/web/vitest.config.ts\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'vitest' imported from /tmp/repo/apps/web/node_modules/.vite-temp/vitest.config.ts.mjs",
    });

    expect(code).toBe(FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE);
  });

  it("keeps local module resolution failures as verification_command_failed", () => {
    const code = resolveVerificationCommandFailureCode({
      verificationCommands: [
        {
          command: "pnpm --filter @flowprocure/web run typecheck",
          source: "auto",
        },
      ],
      index: 0,
      command: "pnpm --filter @flowprocure/web run typecheck",
      output:
        "error TS2307: Cannot find module './request-utils' or its corresponding type declarations.",
    });

    expect(code).toBe(FAILURE_CODE.VERIFICATION_COMMAND_FAILED);
  });

  it("maps missing runtime dependency failures to setup_or_bootstrap_issue", () => {
    const code = resolveVerificationCommandFailureCode({
      verificationCommands: [
        {
          command: "pnpm --filter @flowprocure/web run test",
          source: "auto",
        },
      ],
      index: 0,
      command: "pnpm --filter @flowprocure/web run test",
      output: "MISSING DEPENDENCY  Cannot find dependency 'jsdom'",
    });

    expect(code).toBe(FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE);
  });

  it("maps command-not-found failures to setup_or_bootstrap_issue", () => {
    const code = resolveVerificationCommandFailureCode({
      verificationCommands: [
        {
          command: "pnpm --filter @flowprocure/web run test",
          source: "auto",
        },
      ],
      index: 0,
      command: "pnpm --filter @flowprocure/web run test",
      output: "sh: 1: vitest: not found\nspawn ENOENT",
    });

    expect(code).toBe(FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE);
  });

  it("maps no-test-files verification output to dedicated failure code", () => {
    const code = resolveVerificationCommandFailureCode({
      verificationCommands: [
        {
          command: "pnpm run test",
          source: "auto",
        },
      ],
      index: 0,
      command: "pnpm run test",
      output: "No test files found, exiting with code 1",
    });

    expect(code).toBe(FAILURE_CODE.VERIFICATION_COMMAND_NO_TEST_FILES);
  });

  it("maps runtime engine compatibility failures to setup_or_bootstrap_issue", () => {
    const code = resolveVerificationCommandFailureCode({
      verificationCommands: [
        {
          command: "pnpm --filter @flowprocure/web run test",
          source: "auto",
        },
      ],
      index: 0,
      command: "pnpm --filter @flowprocure/web run test",
      output:
        'Error: require() of ES Module /tmp/repo/node_modules/.pnpm/@exodus+bytes/node_modules/@exodus/bytes/encoding-lite.js not supported.\ncode: "ERR_REQUIRE_ESM"\nunsupported engine wanted: {"node":">=20.0.0"}',
    });

    expect(code).toBe(FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE);
  });

  it("keeps app-level ESM import errors as verification_command_failed", () => {
    const code = resolveVerificationCommandFailureCode({
      verificationCommands: [
        {
          command: "pnpm --filter @flowprocure/web run test",
          source: "auto",
        },
      ],
      index: 0,
      command: "pnpm --filter @flowprocure/web run test",
      output:
        "Error [ERR_REQUIRE_ESM]: Must use import to load ES Module: /tmp/repo/src/utils/test-helper.ts",
    });

    expect(code).toBe(FAILURE_CODE.VERIFICATION_COMMAND_FAILED);
  });
});
