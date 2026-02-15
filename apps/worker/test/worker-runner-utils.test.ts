import { afterEach, describe, expect, it } from "vitest";
import { FAILURE_CODE } from "@openTiger/core";
import {
  shouldAttemptVerifyRecovery,
  isSetupBootstrapFailure,
  buildExecuteFailureHint,
} from "../src/worker-runner-utils";
import type { VerifyResult } from "../src/steps";

const originalSetupRecoveryEnv = process.env.WORKER_SETUP_IN_PROCESS_RECOVERY;

afterEach(() => {
  if (originalSetupRecoveryEnv === undefined) {
    delete process.env.WORKER_SETUP_IN_PROCESS_RECOVERY;
  } else {
    process.env.WORKER_SETUP_IN_PROCESS_RECOVERY = originalSetupRecoveryEnv;
  }
});

function createVerifyResult(overrides: Partial<VerifyResult>): VerifyResult {
  return {
    success: false,
    commandResults: [],
    policyViolations: [],
    changedFiles: [],
    stats: { additions: 0, deletions: 0 },
    failedCommand: "pnpm --filter @flowprocure/web run test",
    failedCommandSource: "auto",
    ...overrides,
  };
}

describe("shouldAttemptVerifyRecovery", () => {
  it("allows in-process recovery for setup_or_bootstrap_issue by default", () => {
    const shouldRecover = shouldAttemptVerifyRecovery(
      createVerifyResult({
        failureCode: FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE,
      }),
      true,
    );

    expect(shouldRecover).toBe(true);
  });

  it("does not attempt verify recovery for setup_or_bootstrap_issue when disabled", () => {
    process.env.WORKER_SETUP_IN_PROCESS_RECOVERY = "false";
    const shouldRecover = shouldAttemptVerifyRecovery(
      createVerifyResult({
        failureCode: FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE,
      }),
      true,
    );

    expect(shouldRecover).toBe(false);
  });

  it("still attempts verify recovery for generic verification command failures", () => {
    const shouldRecover = shouldAttemptVerifyRecovery(
      createVerifyResult({
        failureCode: FAILURE_CODE.VERIFICATION_COMMAND_FAILED,
      }),
      true,
    );

    expect(shouldRecover).toBe(true);
  });
});

describe("isSetupBootstrapFailure", () => {
  it("returns true for setup_or_bootstrap_issue failure code", () => {
    const result = createVerifyResult({
      failureCode: FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE,
    });
    expect(isSetupBootstrapFailure(result)).toBe(true);
  });

  it("returns false for other failure codes", () => {
    const result = createVerifyResult({
      failureCode: FAILURE_CODE.VERIFICATION_COMMAND_FAILED,
    });
    expect(isSetupBootstrapFailure(result)).toBe(false);
  });
});

describe("buildExecuteFailureHint", () => {
  it("includes stderr summary in the hint", () => {
    const hint = buildExecuteFailureHint("Error: ENOENT", undefined);
    expect(hint).toContain("ENOENT");
    expect(hint).toContain("Previous recovery execution itself failed");
  });

  it("falls back to error when stderr is undefined", () => {
    const hint = buildExecuteFailureHint(undefined, "Task execution timed out");
    expect(hint).toContain("timed out");
  });
});
