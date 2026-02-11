import type { CreateTaskInput } from "@openTiger/core";
import type { Requirement } from "../parser";
import type { CodebaseInspection } from "../inspection";
import { getPlannerOpenCodeEnv } from "../opencode-config";
import { generateAndParseWithRetry } from "../llm-json-retry";

// Task generation result
export interface PlannedTaskInput extends CreateTaskInput {
  dependsOnIndexes?: number[]; // Preserve LLM dep indexes for later resolution
}

export interface TaskGenerationResult {
  tasks: PlannedTaskInput[];
  warnings: string[];
  totalEstimatedMinutes: number;
}

// Build prompt for LLM
function buildPrompt(requirement: Requirement, inspection?: CodebaseInspection): string {
  const inspectionBlock = inspection
    ? `
## Codebase Inspection (Required Context)
Summary: ${inspection.summary}
Already Satisfied:
${inspection.satisfied.length > 0 ? inspection.satisfied.map((item) => `- ${item}`).join("\n") : "(none)"}
Gaps:
${inspection.gaps.length > 0 ? inspection.gaps.map((item) => `- ${item}`).join("\n") : "(none)"}
Evidence:
${inspection.evidence.length > 0 ? inspection.evidence.map((item) => `- ${item}`).join("\n") : "(none)"}
Notes:
${inspection.notes.length > 0 ? inspection.notes.map((item) => `- ${item}`).join("\n") : "(none)"}
`.trim()
    : "## Codebase Inspection (Required Context)\n(Inspection was not available, so reliable task generation is not possible.)";

  return `
You are an expert in decomposing software requirements into executable engineering tasks.
Read the requirement and inspection result below, then produce actionable tasks.
Do not call any tools. Reason only from the information provided here.
Create tasks only for items in inspection.gaps. Do not create tasks for inspection.satisfied items.
If gaps is empty, return an empty tasks array and include a warning such as "No meaningful implementation gaps found."

## Task Decomposition Principles

1. **Size**: each task should be completable in 30-90 minutes
2. **Verifiable**: completion must be checkable by tests or commands
3. **Independence**: minimize unnecessary dependencies
4. **Scoped changes**: clearly specify file/directory boundaries
5. **Respect existing structure**: follow the current repository layout and stack
6. **Respect allowed paths**: do not create tasks requiring changes outside allowedPaths
7. **Role split**: implementation tasks use worker; test authoring tasks use tester

## Structure and Stack Rules

- Respect the existing directory layout (do not hard-code any specific layout)
- Respect technologies already used in the project
- Do not introduce unrequested tools or frameworks
- Add new apps/modules only if explicitly required

## allowedPaths Rules

- If a task needs changes outside allowedPaths, skip creating it and explain why in warnings
- If root/dependency changes are required, split them into a dedicated dependency task
- Ensure such dependency task includes required root files in allowedPaths

## Requirement

### Goal
${requirement.goal}

### Background
${requirement.background || "(none)"}

### Constraints
${requirement.constraints.length > 0 ? requirement.constraints.map((c) => `- ${c}`).join("\n") : "(none)"}

### Acceptance Criteria
${requirement.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

### Scope
#### In Scope
${requirement.scope.inScope.map((s) => `- ${s}`).join("\n") || "(none)"}

#### Out of Scope
${requirement.scope.outOfScope.map((s) => `- ${s}`).join("\n") || "(none)"}

### Allowed Paths
${requirement.allowedPaths.map((p) => `- ${p}`).join("\n")}

### Risk Assessment
${
  requirement.riskAssessment.length > 0
    ? requirement.riskAssessment.map((r) => `- ${r.risk} (${r.impact}): ${r.mitigation}`).join("\n")
    : "(none)"
}

### Notes
${requirement.notes || "(none)"}

${inspectionBlock}

## Output Format
Return JSON only. Do not include any extra text.

\`\`\`json
{
  "tasks": [
    {
      "title": "Short task title",
      "goal": "Machine-verifiable completion condition",
      "role": "worker or tester",
      "context": {
        "files": ["Relevant file paths"],
        "specs": "Detailed implementation spec",
        "notes": "Additional context"
      },
      "allowedPaths": ["Allowed change paths (glob)"],
      "commands": ["Verification commands aligned with repo scripts (lint/test/typecheck, etc.)"],
      "priority": 10,
      "riskLevel": "low",
      "dependsOn": [],
      "timeboxMinutes": 60
    }
  ],
  "warnings": ["Any warning message"]
}
\`\`\`

## Constraints

- Express dependencies in dependsOn using task indexes
- Use dependencies only when truly required; keep parallelism high
- Avoid redundant dependency chains
- Every command must produce clear success/failure
- Do not require long-running dev servers as verification commands
- Require E2E only when explicitly asked and keep it minimal
- riskLevel must be one of "low" / "medium" / "high"
- timeboxMinutes must be between 30 and 90
- Avoid vague goals such as "improve" or "optimize"
`.trim();
}

function isTaskGenerationPayload(value: unknown): value is {
  tasks: Array<{
    title: string;
    goal: string;
    role?: string;
    context?: { files?: string[]; specs?: string; notes?: string };
    allowedPaths: string[];
    commands: string[];
    priority?: number;
    riskLevel?: string;
    dependsOn?: number[];
    timeboxMinutes?: number;
  }>;
  warnings?: string[];
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { tasks?: unknown };
  return Array.isArray(record.tasks);
}

// Resolve dep indexes to task ID references
function resolveDependencies(
  tasks: Array<{
    title: string;
    goal: string;
    role?: string;
    context?: { files?: string[]; specs?: string; notes?: string };
    allowedPaths: string[];
    commands: string[];
    priority?: number;
    riskLevel?: string;
    dependsOn?: number[];
    timeboxMinutes?: number;
  }>,
): PlannedTaskInput[] {
  // Generate all tasks first; resolve deps later
  const taskInputs: PlannedTaskInput[] = tasks.map((task, index) => ({
    title: task.title,
    goal: task.goal,
    role: (task.role as "worker" | "tester" | undefined) ?? "worker",
    context: task.context,
    allowedPaths: task.allowedPaths,
    commands: task.commands,
    priority: task.priority ?? (tasks.length - index) * 10, // Set priority from order
    riskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
    dependencies: [], // Set later
    dependsOnIndexes: task.dependsOn?.filter((dep) => Number.isInteger(dep)) ?? [],
    timeboxMinutes: task.timeboxMinutes ?? 60,
    targetArea: undefined,
    touches: [],
  }));

  return taskInputs;
}

// Generate tasks from requirement
export async function generateTasksFromRequirement(
  requirement: Requirement,
  options: {
    workdir: string;
    instructionsPath?: string;
    timeoutSeconds?: number;
    inspection?: CodebaseInspection;
  },
): Promise<TaskGenerationResult> {
  const prompt = buildPrompt(requirement, options.inspection);
  const plannerModel = process.env.PLANNER_MODEL ?? "google/gemini-3-pro-preview";

  // Parse response
  const parsed = await generateAndParseWithRetry<{
    tasks: Array<{
      title: string;
      goal: string;
      role?: string;
      context?: { files?: string[]; specs?: string; notes?: string };
      allowedPaths: string[];
      commands: string[];
      priority?: number;
      riskLevel?: string;
      dependsOn?: number[];
      timeboxMinutes?: number;
    }>;
    warnings?: string[];
  }>({
    workdir: options.workdir,
    model: plannerModel, // Planner prefers high-quality model for planning
    prompt,
    timeoutSeconds: options.timeoutSeconds ?? 300,
    // Planner judges only from prompt; no tools
    env: getPlannerOpenCodeEnv(),
    guard: isTaskGenerationPayload,
    label: "Task generation",
  });

  // Transform tasks
  const tasks = resolveDependencies(parsed.tasks);

  // Total estimated time
  const totalEstimatedMinutes = tasks.reduce((sum, t) => sum + (t.timeboxMinutes ?? 60), 0);

  return {
    tasks,
    warnings: parsed.warnings ?? [],
    totalEstimatedMinutes,
  };
}

// Generate simple tasks without LLM (fallback)
export function generateSimpleTasks(requirement: Requirement): TaskGenerationResult {
  const tasks: PlannedTaskInput[] = [];

  // Generate tasks from acceptance criteria
  requirement.acceptanceCriteria.forEach((criterion, index) => {
    tasks.push({
      title: `Implement: ${criterion.slice(0, 50)}${criterion.length > 50 ? "..." : ""}`,
      goal: criterion,
      role: "worker",
      context: {
        specs: requirement.goal,
        notes: requirement.notes,
      },
      allowedPaths: requirement.allowedPaths,
      // Do not fix commands; rely on light check per implementation
      commands: [],
      priority: (requirement.acceptanceCriteria.length - index) * 10,
      riskLevel: determineRiskLevel(requirement),
      dependencies: [],
      dependsOnIndexes: [],
      timeboxMinutes: 60,
      targetArea: undefined,
      touches: [],
    });
  });

  return {
    tasks,
    warnings: ["Tasks were generated without LLM analysis. Manual review recommended."],
    totalEstimatedMinutes: tasks.length * 60,
  };
}

// Determine risk level
function determineRiskLevel(requirement: Requirement): "low" | "medium" | "high" {
  // High-risk item makes overall high-risk
  if (requirement.riskAssessment.some((r) => r.impact === "high")) {
    return "high";
  }
  if (requirement.riskAssessment.some((r) => r.impact === "medium")) {
    return "medium";
  }
  return "low";
}
