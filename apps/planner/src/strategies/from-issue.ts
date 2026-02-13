import type { CreateTaskInput } from "@openTiger/core";
import { getPlannerOpenCodeEnv } from "../opencode-config";
import { generateAndParseWithRetry } from "../llm-json-retry";

// GitHub Issue info
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  milestone?: string;
}

// Issue analysis result
export interface IssueAnalysisResult {
  tasks: CreateTaskInput[];
  warnings: string[];
  issueNumber: number;
}

export type IssueTaskRole = "worker" | "tester" | "docser";

// Build LLM prompt from Issue
function buildPromptFromIssue(
  issue: GitHubIssue,
  allowedPaths: string[],
  explicitRole: IssueTaskRole,
): string {
  return `
You are an expert in decomposing software engineering work into executable tasks.
Read the GitHub Issue below and split it into actionable tasks.
Do not call tools. Reason only from the information provided here.

## Task Decomposition Principles

1. **Size**: each task should be completable in 30-90 minutes
2. **Verifiable**: completion must be checkable by tests or commands
3. **Independence**: minimize unnecessary dependencies
4. **Scoped changes**: clearly specify file/directory boundaries
5. **Respect existing structure**: follow the current repository layout and stack
6. **Respect allowed paths**: do not create tasks requiring changes outside allowedPaths
7. **Fixed role**: this issue role is fixed to ${explicitRole}; every task role must be ${explicitRole}

## Structure and Stack Rules

- Respect the existing directory layout (do not hard-code a specific layout)
- Respect technologies already used in the project and issue assumptions
- Do not introduce unrequested tools or frameworks
- Add new apps/modules only if explicitly requested in the issue

## allowedPaths Rules

- If a task needs changes outside allowedPaths, skip it and explain the reason in warnings
- If root/dependency changes are required, split them into a dedicated dependency task
- Ensure such dependency task includes required root files in allowedPaths

## GitHub Issue #${issue.number}

### Title
${issue.title}

### Labels
${issue.labels.length > 0 ? issue.labels.join(", ") : "(none)"}

### Body
${issue.body || "(empty)"}

### Allowed Paths
${allowedPaths.map((p) => `- ${p}`).join("\n")}

## Output Format
Return JSON only. Do not include any extra text.

\`\`\`json
{
  "tasks": [
    {
      "title": "Short task title",
      "goal": "Machine-verifiable completion condition",
      "role": "${explicitRole}",
      "context": {
        "files": ["Relevant file paths"],
        "specs": "Detailed implementation spec",
        "notes": "Additional context"
      },
      "allowedPaths": ["Allowed change paths"],
      "commands": ["Verification commands aligned with repo scripts (lint/test/typecheck, etc.)"],
      "priority": 10,
      "riskLevel": "low",
      "dependsOn": [],
      "timeboxMinutes": 60
    }
  ],
  "warnings": []
}
\`\`\`

## Constraints

- Consider execution order and express required dependencies via dependsOn
- Keep dependsOn minimal; avoid unnecessary serialization
- Every command must return clear success/failure
- Do not include long-running commands such as dev servers for verification
- For frontend-related work, include minimum critical-path E2E coverage
- role must always be ${explicitRole} (no other roles allowed)
- riskLevel must be one of "low" / "medium" / "high"
- timeboxMinutes must be between 30 and 90
- Infer riskLevel from issue labels when possible
`.trim();
}

function normalizeRoleToken(value: string | null | undefined): IssueTaskRole | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "worker" || normalized === "tester" || normalized === "docser") {
    return normalized;
  }
  return null;
}

function parseRoleFromLabels(labels: string[]): IssueTaskRole | null {
  for (const raw of labels) {
    const label = raw.trim().toLowerCase().replace(/\s+/g, "");
    if (label === "role:worker" || label === "agent:worker" || label === "worker") {
      return "worker";
    }
    if (label === "role:tester" || label === "agent:tester" || label === "tester") {
      return "tester";
    }
    if (label === "role:docser" || label === "agent:docser" || label === "docser") {
      return "docser";
    }
  }
  return null;
}

function parseRoleFromInlineBody(body: string): IssueTaskRole | null {
  if (!body) {
    return null;
  }
  const inline = body.match(
    /^(?:\s*[-*]\s*)?(?:agent(?:\s*role)?|role)\s*[:：]\s*(worker|tester|docser)\s*$/im,
  );
  return normalizeRoleToken(inline?.[1] ?? null);
}

function parseRoleFromSectionBody(body: string): IssueTaskRole | null {
  if (!body) {
    return null;
  }
  const lines = body.split(/\r?\n/);
  let inRoleSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (/^#{1,6}\s*(agent|role)\b/i.test(line)) {
      inRoleSection = true;
      continue;
    }
    if (inRoleSection && /^#{1,6}\s+/.test(line)) {
      break;
    }
    if (!inRoleSection) {
      continue;
    }
    const bullet = line.match(/^[-*]\s*(.+)$/)?.[1] ?? line;
    const sectionRole = bullet.match(/\b(worker|tester|docser)\b/i)?.[1] ?? null;
    const normalized = normalizeRoleToken(sectionRole);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function parseExplicitRoleFromIssue(issue: GitHubIssue): IssueTaskRole | null {
  const fromLabel = parseRoleFromLabels(issue.labels);
  if (fromLabel) {
    return fromLabel;
  }
  const fromInline = parseRoleFromInlineBody(issue.body);
  if (fromInline) {
    return fromInline;
  }
  return parseRoleFromSectionBody(issue.body);
}

function buildMissingRoleWarning(issueNumber: number): string {
  return `Issue #${issueNumber}: explicit role is required. Add label role:worker|role:tester|role:docser or set "Agent: <role>" / "Role: <role>" in body.`;
}

// Infer risk level from labels
function inferRiskFromLabels(labels: string[]): "low" | "medium" | "high" {
  const lowercaseLabels = labels.map((l) => l.toLowerCase());

  if (
    lowercaseLabels.some(
      (l) => l.includes("critical") || l.includes("security") || l.includes("breaking"),
    )
  ) {
    return "high";
  }

  if (
    lowercaseLabels.some((l) => l.includes("bug") || l.includes("fix") || l.includes("important"))
  ) {
    return "medium";
  }

  return "low";
}

function isIssueTaskPayload(value: unknown): value is {
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

// Generate tasks from GitHub Issue
export async function generateTasksFromIssue(
  issue: GitHubIssue,
  options: {
    workdir: string;
    allowedPaths: string[];
    instructionsPath?: string;
    timeoutSeconds?: number;
  },
): Promise<IssueAnalysisResult> {
  const explicitRole = parseExplicitRoleFromIssue(issue);
  if (!explicitRole) {
    return {
      tasks: [],
      warnings: [buildMissingRoleWarning(issue.number)],
      issueNumber: issue.number,
    };
  }

  const prompt = buildPromptFromIssue(issue, options.allowedPaths, explicitRole);
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
    guard: isIssueTaskPayload,
    label: "Issue task generation",
  });

  // Transform tasks
  const defaultRisk = inferRiskFromLabels(issue.labels);
  const roleOverrideWarnings: string[] = [];
  const tasks: CreateTaskInput[] = parsed.tasks.map((task, index) => {
    const requestedRole = normalizeRoleToken(task.role ?? null);
    if (requestedRole && requestedRole !== explicitRole) {
      roleOverrideWarnings.push(
        `Issue #${issue.number}: task "${task.title}" role "${requestedRole}" was overridden to "${explicitRole}".`,
      );
    }
    return {
      title: task.title,
      goal: task.goal,
      role: explicitRole,
      kind: "code",
      context: {
        ...task.context,
        notes: `GitHub Issue #${issue.number}: ${issue.title}\n${task.context?.notes ?? ""}`,
      },
      allowedPaths: task.allowedPaths,
      commands: task.commands,
      priority: task.priority ?? (parsed.tasks.length - index) * 10,
      riskLevel: (task.riskLevel as "low" | "medium" | "high") ?? defaultRisk,
      dependencies: [],
      timeboxMinutes: task.timeboxMinutes ?? 60,
      targetArea: undefined,
      touches: [],
    };
  });

  return {
    tasks,
    warnings: [...(parsed.warnings ?? []), ...roleOverrideWarnings],
    issueNumber: issue.number,
  };
}

// Generate simple tasks from Issue without LLM (fallback)
export function generateSimpleTaskFromIssue(
  issue: GitHubIssue,
  allowedPaths: string[],
): IssueAnalysisResult {
  const riskLevel = inferRiskFromLabels(issue.labels);
  const explicitRole = parseExplicitRoleFromIssue(issue);
  if (!explicitRole) {
    return {
      tasks: [],
      warnings: [buildMissingRoleWarning(issue.number)],
      issueNumber: issue.number,
    };
  }

  const task: CreateTaskInput = {
    title: issue.title,
    goal: `Resolve GitHub Issue #${issue.number}`,
    role: explicitRole,
    kind: "code",
    context: {
      specs: issue.body,
      notes: `Labels: ${issue.labels.join(", ") || "none"}`,
    },
    allowedPaths,
    // Do not fix commands; rely on light check
    commands: [],
    priority: 50,
    riskLevel,
    dependencies: [],
    timeboxMinutes: 60,
    targetArea: undefined,
    touches: [],
  };

  return {
    tasks: [task],
    warnings: ["Single task created from issue. Consider manual breakdown for complex issues."],
    issueNumber: issue.number,
  };
}
