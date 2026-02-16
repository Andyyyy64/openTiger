import { describe, expect, it } from "vitest";
import {
  countTasksByLane,
  selectTasksForDispatch,
  type DispatcherLane,
} from "../src/scheduler/lane-policy";
import type { AvailableTask } from "../src/scheduler/priority";

function createTask(
  id: string,
  lane: DispatcherLane,
  options?: { targetArea?: string | null; priority?: number },
): AvailableTask {
  return {
    id,
    title: `task-${id}`,
    goal: "test",
    priority: options?.priority ?? 0,
    riskLevel: "low",
    role: "worker",
    lane,
    timeboxMinutes: 60,
    dependencies: [],
    allowedPaths: [],
    commands: [],
    context: null,
    targetArea: options?.targetArea ?? null,
    touches: [],
  };
}

describe("lane-policy", () => {
  const laneLimits = {
    conflictMaxSlots: 2,
    featureMinSlots: 1,
    docserMaxSlots: 1,
  };

  it("prioritizes feature lane to prevent starvation", () => {
    const selected = selectTasksForDispatch({
      availableTasks: [createTask("c1", "conflict_recovery"), createTask("f1", "feature")],
      availableSlots: 1,
      activeRunningByLane: new Map(),
      laneLimits,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.lane).toBe("feature");
  });

  it("respects conflict lane cap using active running count", () => {
    const selected = selectTasksForDispatch({
      availableTasks: [
        createTask("c1", "conflict_recovery"),
        createTask("c2", "conflict_recovery"),
        createTask("f1", "feature"),
      ],
      availableSlots: 2,
      activeRunningByLane: new Map([["conflict_recovery", 2]]),
      laneLimits,
    });

    expect(selected.map((task) => task.id)).toEqual(["f1"]);
  });

  it("does not select tasks with duplicate targetArea in same cycle", () => {
    const selected = selectTasksForDispatch({
      availableTasks: [
        createTask("f1", "feature", { targetArea: "path:apps/api" }),
        createTask("f2", "feature", { targetArea: "path:apps/api" }),
        createTask("f3", "feature", { targetArea: "path:apps/judge" }),
      ],
      availableSlots: 3,
      activeRunningByLane: new Map(),
      laneLimits,
    });

    expect(selected.map((task) => task.id)).toEqual(["f1", "f3"]);
  });

  it("applies fallback lane override when all lanes are capped", () => {
    const selected = selectTasksForDispatch({
      availableTasks: [createTask("c1", "conflict_recovery")],
      availableSlots: 1,
      activeRunningByLane: new Map([["conflict_recovery", 2]]),
      laneLimits,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.id).toBe("c1");
  });

  it("counts lane distribution correctly", () => {
    const counts = countTasksByLane([
      createTask("f1", "feature"),
      createTask("r1", "research"),
      createTask("d1", "docser"),
      createTask("c1", "conflict_recovery"),
      createTask("f2", "feature"),
    ]);

    expect(counts).toEqual({
      feature: 2,
      research: 1,
      docser: 1,
      conflict_recovery: 1,
    });
  });
});
