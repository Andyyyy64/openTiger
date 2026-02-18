import type { PlannedTaskInput, TaskGenerationResult } from "./strategies/index";
import type { Requirement } from "./parser";
import { formatRequirementMarkdown } from "./requirement-markdown";

const REQUIREMENT_SYNC_NOTE_MARKER = "planner_requirement_sync: true";

export function buildRequirementSyncTask(params: {
  requirement: Requirement;
  checkCommand?: string;
}): PlannedTaskInput {
  const requirementMarkdown = formatRequirementMarkdown(params.requirement);
  const commands = ["test -f docs/requirement.md"];
  if (params.checkCommand) {
    commands.push(params.checkCommand);
  }

  return {
    title: "Sync completed requirement document",
    goal: "Commit the complemented requirement as docs/requirement.md before implementation tasks start.",
    role: "docser",
    kind: "code",
    context: {
      files: ["docs/requirement.md"],
      specs: [
        "Overwrite `docs/requirement.md` with the exact markdown below.",
        "```md",
        requirementMarkdown,
        "```",
      ].join("\n"),
      notes: REQUIREMENT_SYNC_NOTE_MARKER,
    },
    allowedPaths: ["docs/requirement.md"],
    commands,
    priority: 1000,
    riskLevel: "low",
    dependencies: [],
    dependsOnIndexes: [],
    timeboxMinutes: 30,
    targetArea: "docs",
    touches: ["docs/requirement.md"],
  };
}

function hasRequirementSyncTask(result: TaskGenerationResult): boolean {
  return result.tasks.some((task) => task.context?.notes?.includes(REQUIREMENT_SYNC_NOTE_MARKER));
}

export function injectRequirementSyncTask(
  result: TaskGenerationResult,
  requirementSyncTask: PlannedTaskInput,
): TaskGenerationResult {
  if (hasRequirementSyncTask(result)) {
    return result;
  }

  const shifted = result.tasks.map((task) => ({
    ...task,
    dependsOnIndexes: (task.dependsOnIndexes ?? []).map((dep) => dep + 1),
  }));
  const tasks = shifted.map((task, index) => {
    const deps = new Set(task.dependsOnIndexes ?? []);
    deps.add(0);
    return {
      ...task,
      dependsOnIndexes: Array.from(deps).filter((dep) => dep < index + 1),
    };
  });

  return {
    ...result,
    tasks: [requirementSyncTask, ...tasks],
    warnings: [
      ...result.warnings,
      "Injected requirement sync task; all tasks depend on docs/requirement.md commit first.",
    ],
    totalEstimatedMinutes: result.totalEstimatedMinutes + (requirementSyncTask.timeboxMinutes ?? 0),
  };
}
