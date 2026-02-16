import type { AvailableTask } from "./priority";

export type DispatcherLane = "feature" | "conflict_recovery" | "docser" | "research";

export type LaneLimits = {
  conflictMaxSlots: number;
  featureMinSlots: number;
  docserMaxSlots: number;
};

export function normalizeLane(task: Pick<AvailableTask, "lane">): DispatcherLane {
  if (task.lane === "conflict_recovery" || task.lane === "docser" || task.lane === "research") {
    return task.lane;
  }
  return "feature";
}

function incrementLaneCount(counter: Map<DispatcherLane, number>, lane: DispatcherLane): void {
  counter.set(lane, (counter.get(lane) ?? 0) + 1);
}

export function countTasksByLane(taskList: AvailableTask[]): Record<DispatcherLane, number> {
  const counts: Record<DispatcherLane, number> = {
    feature: 0,
    conflict_recovery: 0,
    docser: 0,
    research: 0,
  };
  for (const task of taskList) {
    const lane = normalizeLane(task);
    counts[lane] += 1;
  }
  return counts;
}

export function canDispatchInLane(params: {
  lane: DispatcherLane;
  activeRunningByLane: Map<DispatcherLane, number>;
  thisCycleDispatchByLane: Map<DispatcherLane, number>;
  laneLimits: LaneLimits;
}): boolean {
  const active = params.activeRunningByLane.get(params.lane) ?? 0;
  const dispatched = params.thisCycleDispatchByLane.get(params.lane) ?? 0;
  const effectiveUsage = active + dispatched;

  if (params.lane === "conflict_recovery") {
    return effectiveUsage < params.laneLimits.conflictMaxSlots;
  }
  if (params.lane === "docser") {
    return effectiveUsage < params.laneLimits.docserMaxSlots;
  }
  return true;
}

export function selectTasksForDispatch(params: {
  availableTasks: AvailableTask[];
  availableSlots: number;
  activeRunningByLane: Map<DispatcherLane, number>;
  laneLimits: LaneLimits;
}): AvailableTask[] {
  if (params.availableSlots <= 0 || params.availableTasks.length === 0) {
    return [];
  }

  const selected: AvailableTask[] = [];
  const selectedIds = new Set<string>();
  const pendingTargetAreas = new Set<string>();
  const thisCycleDispatchByLane = new Map<DispatcherLane, number>();

  const trySelectTask = (task: AvailableTask, forceLaneBypass = false): boolean => {
    if (selectedIds.has(task.id)) {
      return false;
    }
    if (task.targetArea && pendingTargetAreas.has(task.targetArea)) {
      return false;
    }
    if (selected.length >= params.availableSlots) {
      return false;
    }

    const lane = normalizeLane(task);
    if (
      !forceLaneBypass &&
      !canDispatchInLane({
        lane,
        activeRunningByLane: params.activeRunningByLane,
        thisCycleDispatchByLane,
        laneLimits: params.laneLimits,
      })
    ) {
      return false;
    }

    selected.push(task);
    selectedIds.add(task.id);
    if (task.targetArea) {
      pendingTargetAreas.add(task.targetArea);
    }
    incrementLaneCount(thisCycleDispatchByLane, lane);
    return true;
  };

  const activeFeature = params.activeRunningByLane.get("feature") ?? 0;
  const activeResearch = params.activeRunningByLane.get("research") ?? 0;
  const requiredFeatureDispatch = Math.max(
    0,
    params.laneLimits.featureMinSlots - (activeFeature + activeResearch),
  );
  if (requiredFeatureDispatch > 0) {
    for (const task of params.availableTasks) {
      const lane = normalizeLane(task);
      if (lane !== "feature" && lane !== "research") {
        continue;
      }
      if (
        trySelectTask(task) &&
        (thisCycleDispatchByLane.get("feature") ?? 0) +
          (thisCycleDispatchByLane.get("research") ?? 0) >=
          requiredFeatureDispatch
      ) {
        break;
      }
    }
  }

  for (const task of params.availableTasks) {
    if (selected.length >= params.availableSlots) {
      break;
    }
    trySelectTask(task);
  }

  if (selected.length === 0 && params.availableTasks.length > 0) {
    const laneOrder: DispatcherLane[] = ["feature", "research", "docser", "conflict_recovery"];
    for (const lane of laneOrder) {
      const fallback = params.availableTasks.find((task) => normalizeLane(task) === lane);
      if (fallback && trySelectTask(fallback, true)) {
        break;
      }
    }
  }

  return selected;
}
