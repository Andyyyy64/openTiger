import { describe, expect, it } from "vitest";
import {
  applyVerificationRecoveryAdjustment,
  extractFailedVerificationCommand,
  resolveOutsideAllowedViolationPaths,
} from "../src/cleaners/cleanup-retry/requeue-failed";

describe("requeue-failed structured metadata helpers", () => {
  it("prefers failedCommand from errorMeta", () => {
    const command = extractFailedVerificationCommand(
      "Verification failed at make test [auto]: stderr unavailable",
      { failedCommand: 'grep -q "\\[boot\\] kernel entry" build/boot_smoke.log' },
    );

    expect(command).toBe('grep -q "\\[boot\\] kernel entry" build/boot_smoke.log');
  });

  it("falls back to parsing command from errorMessage", () => {
    const command = extractFailedVerificationCommand(
      "Verification failed at pnpm run check [explicit]: stderr unavailable",
    );

    expect(command).toBe("pnpm run check");
  });

  it("prefers policyViolations from errorMeta", () => {
    const paths = resolveOutsideAllowedViolationPaths("other message", {
      policyViolations: ["change outside allowed paths: Makefile"],
    });

    expect(paths).toEqual(["Makefile"]);
  });

  it("drops failed make target command using structured metadata", () => {
    const adjustment = applyVerificationRecoveryAdjustment({
      reason: "verification_command_missing_make_target",
      commands: ["make test", "pnpm run check"],
      errorMessage: "legacy message",
      errorMeta: { failedCommand: "make test" },
    });

    expect(adjustment).toMatchObject({
      nextCommands: ["pnpm run check"],
      eventReason: "verification_command_missing_make_target_adjusted",
      recoveryRule: "drop_failed_command",
    });
  });

  it("drops failed no-test-files command using structured metadata", () => {
    const adjustment = applyVerificationRecoveryAdjustment({
      reason: "verification_command_no_test_files",
      commands: ["pnpm run test", "pnpm run typecheck"],
      errorMessage: "legacy message",
      errorMeta: { failedCommand: "pnpm run test" },
    });

    expect(adjustment).toMatchObject({
      nextCommands: ["pnpm run typecheck"],
      eventReason: "verification_command_no_test_files_adjusted",
      recoveryRule: "drop_failed_command",
    });
  });
});
