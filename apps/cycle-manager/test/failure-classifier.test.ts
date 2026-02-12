import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/cleaners/cleanup-retry/failure-classifier";

describe("classifyFailure", () => {
  it("classifies unsupported verification command format as setup non-retryable", () => {
    const failure = classifyFailure(
      "Verification failed at file kernel/kernel.elf | grep -q 'ELF 64-bit.*RISC-V' [explicit]: Unsupported command format. Shell operators are not allowed.",
    );

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_unsupported_format",
      blockReason: "needs_rework",
    });
  });

  it("keeps missing script classification unchanged", () => {
    const failure = classifyFailure("ERR_PNPM_NO_SCRIPT Missing script: verify");

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_missing_script",
      blockReason: "needs_rework",
    });
  });

  it("treats missing package.json for npm run as verification command setup issue", () => {
    const failure = classifyFailure(
      "Verification failed at npm run dev [explicit]: npm error enoent Could not read package.json: Error: ENOENT",
    );

    expect(failure).toEqual({
      category: "setup",
      retryable: false,
      reason: "verification_command_missing_script",
      blockReason: "needs_rework",
    });
  });
});
