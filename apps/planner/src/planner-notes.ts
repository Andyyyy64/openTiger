import { db } from "@openTiger/db";
import { tasks, events } from "@openTiger/db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import type { Requirement } from "./parser";
import type { TaskGenerationResult } from "./strategies/index";
import { clipText, normalizeStringList, extractIssueMessages } from "./planner-utils";

export type PolicyRecoveryPathHint = {
  path: string;
  role: string | null;
  count: number;
  sourceText: string;
};

function normalizePathHint(path: string): string {
  const trimmed = path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .trim();
  if (!trimmed || trimmed.startsWith("/")) {
    return "";
  }
  if (trimmed.includes("..") || /[*?[\]{}]/.test(trimmed)) {
    return "";
  }
  return trimmed;
}

function extractPathHintsFromPayload(payload: Record<string, unknown>): string[] {
  const fromAllowedPaths = normalizeStringList(payload.allowedPaths, 20);
  const fromAddedAllowedPaths = normalizeStringList(payload.addedAllowedPaths, 20);
  const merged = Array.from(new Set([...fromAllowedPaths, ...fromAddedAllowedPaths]));
  return merged.map((entry) => normalizePathHint(entry)).filter((entry) => entry.length > 0);
}

function buildHintSourceText(task: { title: string; goal: string; commands: string[] }): string {
  return [task.title, task.goal, ...task.commands].join(" ").toLowerCase();
}

function formatJudgeFeedbackEntry(payload: Record<string, unknown>): string | undefined {
  const rawPrNumber = payload.prNumber;
  const prNumber =
    typeof rawPrNumber === "number"
      ? rawPrNumber
      : typeof rawPrNumber === "string" && !Number.isNaN(Number(rawPrNumber))
        ? Number(rawPrNumber)
        : undefined;
  const verdict = typeof payload.verdict === "string" ? payload.verdict : "unknown";
  const reasons = normalizeStringList(payload.reasons, 3);
  const suggestions = normalizeStringList(payload.suggestions, 3);
  const summary = payload.summary;
  const codeIssues =
    typeof summary === "object" &&
    summary !== null &&
    "llm" in summary &&
    typeof (summary as { llm?: unknown }).llm === "object"
      ? extractIssueMessages((summary as { llm?: { codeIssues?: unknown } }).llm?.codeIssues, 3)
      : [];

  const details: string[] = [];

  if (reasons.length > 0) {
    details.push(`Reasons: ${reasons.join(" / ")}`);
  }

  if (suggestions.length > 0) {
    details.push(`Suggestions: ${suggestions.join(" / ")}`);
  }

  if (codeIssues.length > 0) {
    details.push(`Issues: ${codeIssues.join(" / ")}`);
  }

  const label = prNumber ? `PR #${prNumber}` : "PR";
  if (details.length === 0) {
    return `${label} (${verdict})`;
  }

  return `${label} (${verdict}) ${details.join(" | ")}`;
}

export async function loadJudgeFeedback(limit: number = 5): Promise<string | undefined> {
  // Fetch recent Judge review results only
  const rows = await db
    .select({
      payload: events.payload,
    })
    .from(events)
    .where(eq(events.type, "judge.review"))
    .orderBy(desc(events.createdAt))
    .limit(limit);

  const lines = rows
    .map((row) => {
      const payload = row.payload;
      if (typeof payload !== "object" || payload === null) {
        return undefined;
      }
      return formatJudgeFeedbackEntry(payload as Record<string, unknown>);
    })
    .filter((line): line is string => typeof line === "string");

  if (lines.length === 0) {
    return;
  }

  return lines.map((line) => `- ${line}`).join("\n");
}

export function attachJudgeFeedbackToRequirement(
  requirement: Requirement,
  feedback: string | undefined,
): Requirement {
  // Append Judge result to requirement notes
  if (!feedback) {
    return requirement;
  }

  const feedbackBlock = `Judge Feedback:\n${feedback}`;
  const notes = requirement.notes ? `${requirement.notes}\n\n${feedbackBlock}` : feedbackBlock;

  return { ...requirement, notes };
}

export function attachJudgeFeedbackToTasks(
  result: TaskGenerationResult,
  feedback: string | undefined,
): TaskGenerationResult {
  // Reflect feedback in task notes for Worker handoff
  if (!feedback) {
    return result;
  }

  const feedbackBlock = `Judge Feedback:\n${feedback}`;
  const tasks = result.tasks.map((task) => {
    const context = task.context ?? {};
    const notes = context.notes ? `${context.notes}\n\n${feedbackBlock}` : feedbackBlock;

    return {
      ...task,
      context: {
        ...context,
        notes,
      },
    };
  });

  return { ...result, tasks };
}

export function attachInspectionToRequirement(
  requirement: Requirement,
  inspectionNotes: string | undefined,
): Requirement {
  // Attach inspection content to requirement for task generation
  if (!inspectionNotes) {
    return requirement;
  }

  const notes = requirement.notes ? `${requirement.notes}\n\n${inspectionNotes}` : inspectionNotes;

  return { ...requirement, notes };
}

export async function loadExistingTaskHints(limit: number = 30): Promise<string | undefined> {
  try {
    const rows = await db
      .select({
        title: tasks.title,
        goal: tasks.goal,
        status: tasks.status,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(inArray(tasks.status, ["queued", "running", "blocked"]))
      .orderBy(desc(tasks.createdAt))
      .limit(limit);

    if (rows.length === 0) {
      return;
    }

    const lines = rows.map((row) => {
      const title = clipText(row.title, 120);
      const goal = clipText(row.goal, 120);
      return `- ${title} (${row.status}) : ${goal}`;
    });

    return lines.join("\n");
  } catch (error) {
    console.warn("[Planner] Failed to load existing tasks:", error);
    return;
  }
}

export function attachExistingTasksToRequirement(
  requirement: Requirement,
  hints: string | undefined,
): Requirement {
  // Share existing tasks to reduce duplicate planning
  if (!hints) {
    return requirement;
  }

  const block = `Existing Tasks (for duplicate avoidance):\n${hints}`;
  const notes = requirement.notes ? `${requirement.notes}\n\n${block}` : block;
  return { ...requirement, notes };
}

export function attachInspectionToTasks(
  result: TaskGenerationResult,
  inspectionNotes: string | undefined,
): TaskGenerationResult {
  // Share inspection content with Worker for deeper exploration
  if (!inspectionNotes) {
    return result;
  }

  const tasks = result.tasks.map((task) => {
    const context = task.context ?? {};
    const notes = context.notes ? `${context.notes}\n\n${inspectionNotes}` : inspectionNotes;

    return {
      ...task,
      context: {
        ...context,
        notes,
      },
    };
  });

  return { ...result, tasks };
}

export async function loadPolicyRecoveryPathHints(
  limit: number = 60,
): Promise<PolicyRecoveryPathHint[]> {
  try {
    const rows = await db
      .select({
        entityId: events.entityId,
        payload: events.payload,
      })
      .from(events)
      .where(eq(events.type, "task.policy_recovery_applied"))
      .orderBy(desc(events.createdAt))
      .limit(limit);

    if (rows.length === 0) {
      return [];
    }

    const taskIds = Array.from(new Set(rows.map((row) => row.entityId)));
    const taskRows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        goal: tasks.goal,
        role: tasks.role,
        commands: tasks.commands,
      })
      .from(tasks)
      .where(inArray(tasks.id, taskIds));

    const taskMap = new Map(taskRows.map((row) => [row.id, row]));
    const aggregated = new Map<
      string,
      {
        path: string;
        role: string | null;
        count: number;
        sourceText: string;
      }
    >();

    for (const row of rows) {
      const payload = row.payload;
      if (typeof payload !== "object" || payload === null) {
        continue;
      }
      const task = taskMap.get(row.entityId);
      if (!task) {
        continue;
      }
      const paths = extractPathHintsFromPayload(payload as Record<string, unknown>);
      if (paths.length === 0) {
        continue;
      }
      const sourceText = buildHintSourceText(task);
      for (const path of paths) {
        const key = `${task.role ?? ""}::${path}`;
        const prev = aggregated.get(key);
        if (!prev) {
          aggregated.set(key, {
            path,
            role: task.role ?? null,
            count: 1,
            sourceText,
          });
        } else {
          prev.count += 1;
          // Keep the most recent source text to preserve latest context.
          prev.sourceText = sourceText;
        }
      }
    }

    return Array.from(aggregated.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);
  } catch (error) {
    console.warn("[Planner] Failed to load policy recovery hints:", error);
    return [];
  }
}

export function attachPolicyRecoveryHintsToRequirement(
  requirement: Requirement,
  hints: PolicyRecoveryPathHint[],
): Requirement {
  if (hints.length === 0) {
    return requirement;
  }

  const lines = hints.slice(0, 20).map((hint) => {
    const roleLabel = hint.role ?? "any";
    return `- ${hint.path} (role=${roleLabel}, seen=${hint.count})`;
  });
  const block = `Policy Recovery Hints (recent auto-allowed paths):\n${lines.join("\n")}`;
  const notes = requirement.notes ? `${requirement.notes}\n\n${block}` : block;
  return { ...requirement, notes };
}
