import { describe, expect, it } from "vitest";
import { buildRequirementSyncTask, injectRequirementSyncTask } from "../src/requirement-sync-task";
import type { Requirement } from "../src/parser";
import type { TaskGenerationResult } from "../src/strategies";

function sampleRequirement(): Requirement {
  return {
    goal: "Build a lightweight notes web app.",
    background: "Current workflow is manual.",
    constraints: ["Use existing stack"],
    acceptanceCriteria: ["Users can create notes"],
    scope: {
      inScope: ["CRUD for notes"],
      outOfScope: ["Authentication"],
    },
    allowedPaths: ["apps/web/**", "apps/api/**"],
    riskAssessment: [
      {
        risk: "Ambiguous requirements",
        impact: "medium",
        mitigation: "Ship incrementally",
      },
    ],
    notes: "Keep implementation simple.",
    rawContent: "Build a lightweight notes web app.",
  };
}

function sampleResult(): TaskGenerationResult {
  return {
    tasks: [
      {
        title: "Implement API",
        goal: "Add notes create/read endpoints.",
        role: "worker",
        kind: "code",
        context: {},
        allowedPaths: ["apps/api/**"],
        commands: [],
        priority: 10,
        riskLevel: "low",
        dependencies: [],
        dependsOnIndexes: [],
        timeboxMinutes: 60,
        targetArea: undefined,
        touches: [],
      },
      {
        title: "Implement UI",
        goal: "Add notes UI page.",
        role: "worker",
        kind: "code",
        context: {},
        allowedPaths: ["apps/web/**"],
        commands: [],
        priority: 9,
        riskLevel: "low",
        dependencies: [],
        dependsOnIndexes: [0],
        timeboxMinutes: 60,
        targetArea: undefined,
        touches: [],
      },
    ],
    warnings: [],
    totalEstimatedMinutes: 120,
  };
}

describe("requirement sync task", () => {
  it("builds task for docs/requirement.md", () => {
    const task = buildRequirementSyncTask({
      requirement: sampleRequirement(),
      checkCommand: "pnpm run check",
    });
    expect(task.allowedPaths).toEqual(["docs/requirement.md"]);
    expect(task.context?.files).toEqual(["docs/requirement.md"]);
    expect(task.commands).toContain("test -f docs/requirement.md");
    expect(task.commands).toContain("pnpm run check");
  });

  it("prepends sync task and makes all tasks depend on it", () => {
    const sync = buildRequirementSyncTask({ requirement: sampleRequirement() });
    const result = injectRequirementSyncTask(sampleResult(), sync);

    expect(result.tasks[0]?.title).toBe("Sync completed requirement document");
    expect(result.tasks[1]?.dependsOnIndexes).toEqual([0]);
    expect(result.tasks[2]?.dependsOnIndexes).toEqual([1, 0]);
  });
});
