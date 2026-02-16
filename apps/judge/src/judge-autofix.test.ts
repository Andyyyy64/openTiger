import { describe, expect, it } from "vitest";
import {
  hasMergeConflictSignals,
  isConflictAutoFixAttemptLimitReason,
  isMergeConflictReasonText,
} from "./judge-autofix";
import type { EvaluationSummary } from "./pr-reviewer";

function createSummary(overrides?: Partial<EvaluationSummary>): EvaluationSummary {
  return {
    ci: {
      pass: true,
      status: "success",
      reasons: [],
      suggestions: [],
      details: [],
    },
    policy: {
      pass: true,
      reasons: [],
      suggestions: [],
      violations: [],
    },
    llm: {
      pass: true,
      confidence: 1,
      reasons: [],
      suggestions: [],
      codeIssues: [],
    },
    ...overrides,
  };
}

describe("judge-autofix helpers", () => {
  it("detects merge conflict keywords in reason text", () => {
    expect(isMergeConflictReasonText("update_branch_failed: not mergeable")).toBe(true);
    expect(isMergeConflictReasonText("all checks passed")).toBe(false);
  });

  it("detects conflict autofix attempt limit reason", () => {
    expect(isConflictAutoFixAttemptLimitReason("conflict_autofix_attempt_limit_reached:3/3")).toBe(
      true,
    );
    expect(isConflictAutoFixAttemptLimitReason("autofix_attempt_limit_reached:3/3")).toBe(false);
  });

  it("detects conflict signals from LLM reasons and deferred merge reason", () => {
    const summary = createSummary({
      llm: {
        pass: false,
        confidence: 0.4,
        reasons: ["pr_merge_conflict_detected"],
        suggestions: [],
        codeIssues: [],
      },
    });
    expect(
      hasMergeConflictSignals({
        summary,
        mergeDeferredReason: "update_branch_failed:not mergeable",
      }),
    ).toBe(true);
  });
});
