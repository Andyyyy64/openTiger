import { describe, expect, it } from "vitest";
import { FAILURE_CODE } from "@openTiger/core";
import { shouldAttemptVerifyRecovery } from "../src/worker-runner-utils";
import type { VerifyResult } from "../src/steps";

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
  it("does not attempt verify recovery for setup_or_bootstrap_issue", () => {
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
