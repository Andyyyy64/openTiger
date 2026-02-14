import { describe, expect, it } from "vitest";
import { isJudgeReviewTask, isPrReviewTask } from "../src/cleaners/cleanup-retry/task-context";

describe("task context judge classification", () => {
  it("keeps canonical PR review tasks as judge-review tasks", () => {
    const task = {
      title: "[PR] Review #42",
      goal: "Review and process open PR #42",
      context: {
        pr: {
          number: 42,
          url: "https://example.com/pr/42",
        },
      },
    };

    expect(isPrReviewTask(task)).toBe(true);
    expect(isJudgeReviewTask(task)).toBe(true);
  });

  it("treats conflict autofix tasks as non judge-review tasks", () => {
    const task = {
      title: "[AutoFix-Conflict] PR #42 (attempt 1/3)",
      goal: "Resolve merge conflicts for PR #42",
      context: {
        pr: {
          number: 42,
          sourceTaskId: "source-task",
        },
      },
    };

    expect(isPrReviewTask(task)).toBe(true);
    expect(isJudgeReviewTask(task)).toBe(false);
  });

  it("treats autofix tasks as non judge-review tasks", () => {
    const task = {
      title: "[AutoFix] PR #13 (attempt 2/3)",
      goal: "Fix CI failures for PR #13",
      context: {
        pr: {
          number: 13,
          sourceTaskId: "source-task",
        },
      },
    };

    expect(isPrReviewTask(task)).toBe(true);
    expect(isJudgeReviewTask(task)).toBe(false);
  });
});
