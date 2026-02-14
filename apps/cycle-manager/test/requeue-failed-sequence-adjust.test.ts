import { describe, expect, it } from "vitest";
import { sanitizeCommandsForVerificationSequenceIssue } from "../src/cleaners/cleanup-retry/requeue-failed";

describe("sanitizeCommandsForVerificationSequenceIssue", () => {
  it("reorders artifact existence check before clean when they are adjacent", () => {
    const adjusted = sanitizeCommandsForVerificationSequenceIssue(
      ["make", "make clean", "test -f build/kernel.elf"],
      "Verification failed at test -f build/kernel.elf [explicit]: stderr unavailable",
    );

    expect(adjusted).toEqual(["make", "test -f build/kernel.elf", "make clean"]);
  });

  it("does not adjust when command before failed check is not clean-like", () => {
    const adjusted = sanitizeCommandsForVerificationSequenceIssue(
      ["make", "test -f build/kernel.elf", "make clean"],
      "Verification failed at test -f build/kernel.elf [explicit]: stderr unavailable",
    );

    expect(adjusted).toBeNull();
  });

  it("reorders package-manager clean before quoted artifact check", () => {
    const adjusted = sanitizeCommandsForVerificationSequenceIssue(
      ["pnpm run clean", "test -s 'dist/kernel.elf'"],
      "Verification failed at test -s 'dist/kernel.elf' [explicit]: stderr unavailable",
    );

    expect(adjusted).toEqual(["test -s 'dist/kernel.elf'", "pnpm run clean"]);
  });

  it("does not adjust for non-artifact checks", () => {
    const adjusted = sanitizeCommandsForVerificationSequenceIssue(
      ["make clean", "test -f docs/guide.md"],
      "Verification failed at test -f docs/guide.md [explicit]: stderr unavailable",
    );

    expect(adjusted).toBeNull();
  });

  it("does not adjust when failed command cannot be located", () => {
    const adjusted = sanitizeCommandsForVerificationSequenceIssue(
      ["make", "make clean", "test -f build/kernel.elf"],
      "Verification failed at test -f build/other.elf [explicit]: stderr unavailable",
    );

    expect(adjusted).toBeNull();
  });

  it("adjusts using structured failedCommand metadata even when message format differs", () => {
    const adjusted = sanitizeCommandsForVerificationSequenceIssue(
      ["make clean", "test -f build/kernel.elf"],
      "unexpected verification failure message",
      { failedCommand: "test -f build/kernel.elf" },
    );

    expect(adjusted).toEqual(["test -f build/kernel.elf", "make clean"]);
  });

  it("does not adjust for paths containing wildcard", () => {
    const adjusted = sanitizeCommandsForVerificationSequenceIssue(
      ["make clean", "test -f build/*.elf"],
      "Verification failed at test -f build/*.elf [explicit]: stderr unavailable",
    );

    expect(adjusted).toBeNull();
  });
});
