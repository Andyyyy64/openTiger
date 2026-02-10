import { describe, expect, it } from "vitest";
import { applyTesterCommandPolicy } from "../src/task-policies";
import type { TaskGenerationResult } from "../src/strategies";

function createResult(overrides?: Partial<TaskGenerationResult>): TaskGenerationResult {
  return {
    tasks: [
      {
        title: "default task",
        goal: "default goal",
        role: "tester",
        allowedPaths: ["apps/**"],
        commands: ["pnpm run test"],
      },
    ],
    warnings: [],
    totalEstimatedMinutes: 60,
    ...overrides,
  };
}

describe("applyTesterCommandPolicy", () => {
  it("appends e2e command when tester task explicitly requires e2e", () => {
    const result = createResult({
      tasks: [
        {
          title: "Add E2E for reservation critical path",
          goal: "Cover user flow from create to cancel",
          role: "tester",
          allowedPaths: ["apps/**"],
          commands: ["pnpm run test"],
        },
      ],
    });

    const updated = applyTesterCommandPolicy(result, "pnpm run test:e2e");

    expect(updated.tasks[0]?.commands).toEqual(["pnpm run test", "pnpm run test:e2e"]);
  });

  it("does not append e2e command for tester task without explicit e2e requirement", () => {
    const result = createResult({
      tasks: [
        {
          title: "Add unit tests for parser",
          goal: "Increase branch coverage for parser",
          role: "tester",
          allowedPaths: ["apps/planner/**"],
          commands: ["pnpm run test"],
        },
      ],
    });

    const updated = applyTesterCommandPolicy(result, "pnpm run test:e2e");

    expect(updated.tasks[0]?.commands).toEqual(["pnpm run test"]);
  });

  it("does not append e2e command for non-tester tasks", () => {
    const result = createResult({
      tasks: [
        {
          title: "Implement parser",
          goal: "Support new requirement format",
          role: "worker",
          allowedPaths: ["apps/planner/**"],
          commands: ["pnpm run test"],
        },
      ],
    });

    const updated = applyTesterCommandPolicy(result, "pnpm run test:e2e");

    expect(updated.tasks[0]?.commands).toEqual(["pnpm run test"]);
  });

  it("does not duplicate e2e command when already present", () => {
    const result = createResult({
      tasks: [
        {
          title: "Update E2E tests",
          goal: "Refresh playwright flow",
          role: "tester",
          allowedPaths: ["apps/**"],
          commands: ["pnpm run test", "pnpm run test:e2e"],
        },
      ],
    });

    const updated = applyTesterCommandPolicy(result, "pnpm run test:e2e");

    expect(updated.tasks[0]?.commands).toEqual(["pnpm run test", "pnpm run test:e2e"]);
  });
});
