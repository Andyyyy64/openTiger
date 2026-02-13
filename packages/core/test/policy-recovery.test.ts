import { describe, expect, it } from "vitest";
import {
  getDefaultPolicyRecoveryConfig,
  resolvePolicyViolationAutoAllowPaths,
} from "../src/policy-recovery";

describe("resolvePolicyViolationAutoAllowPaths", () => {
  it("auto-allows command-driven paths in aggressive mode", () => {
    const config = getDefaultPolicyRecoveryConfig();
    const candidates = resolvePolicyViolationAutoAllowPaths(
      {
        title: "Enable timer interrupt and verify periodic tick",
        goal: "Implement timer interrupt handling",
        commands: [],
        context: {},
        role: "worker",
      },
      ["Makefile"],
      config,
    );

    expect(candidates).toContain("Makefile");
  });

  it("does not auto-allow command-driven paths in balanced mode without signals", () => {
    const config = { ...getDefaultPolicyRecoveryConfig(), mode: "balanced" as const };
    const candidates = resolvePolicyViolationAutoAllowPaths(
      {
        title: "Refactor timer ISR output",
        goal: "Update timer logging behavior",
        commands: [],
        context: {},
        role: "worker",
      },
      ["Makefile"],
      config,
    );

    expect(candidates).toEqual([]);
  });

  it("never auto-allows for docser role", () => {
    const config = getDefaultPolicyRecoveryConfig();
    const candidates = resolvePolicyViolationAutoAllowPaths(
      {
        title: "Update docs",
        goal: "Document timer behavior",
        commands: ["make smoke"],
        context: {},
        role: "docser",
      },
      ["Makefile"],
      config,
    );

    expect(candidates).toEqual([]);
  });
});
