import { db } from "@openTiger/db";
import { tasks, events } from "@openTiger/db/schema";
import { desc, eq, inArray } from "drizzle-orm";
import type { Requirement } from "./parser.js";
import type { TaskGenerationResult } from "./strategies/index.js";
import { clipText, normalizeStringList, extractIssueMessages } from "./planner-utils.js";

function formatJudgeFeedbackEntry(payload: Record<string, unknown>): string | undefined {
  const rawPrNumber = payload.prNumber;
  const prNumber = typeof rawPrNumber === "number"
    ? rawPrNumber
    : typeof rawPrNumber === "string" && !Number.isNaN(Number(rawPrNumber))
      ? Number(rawPrNumber)
      : undefined;
  const verdict = typeof payload.verdict === "string" ? payload.verdict : "unknown";
  const reasons = normalizeStringList(payload.reasons, 3);
  const suggestions = normalizeStringList(payload.suggestions, 3);
  const summary = payload.summary;
  const codeIssues =
    typeof summary === "object"
    && summary !== null
    && "llm" in summary
    && typeof (summary as { llm?: unknown }).llm === "object"
    ? extractIssueMessages(
      (summary as { llm?: { codeIssues?: unknown } }).llm?.codeIssues,
      3
    )
    : [];

  const details: string[] = [];

  if (reasons.length > 0) {
    details.push(`理由: ${reasons.join(" / ")}`);
  }

  if (suggestions.length > 0) {
    details.push(`改善案: ${suggestions.join(" / ")}`);
  }

  if (codeIssues.length > 0) {
    details.push(`指摘: ${codeIssues.join(" / ")}`);
  }

  const label = prNumber ? `PR #${prNumber}` : "PR";
  if (details.length === 0) {
    return `${label} (${verdict})`;
  }

  return `${label} (${verdict}) ${details.join(" | ")}`;
}

export async function loadJudgeFeedback(limit: number = 5): Promise<string | undefined> {
  // Judgeのレビュー結果を直近分だけ取得する
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
  feedback: string | undefined
): Requirement {
  // 要件のノートにJudgeの結果を補足する
  if (!feedback) {
    return requirement;
  }

  const feedbackBlock = `Judgeフィードバック:\n${feedback}`;
  const notes = requirement.notes
    ? `${requirement.notes}\n\n${feedbackBlock}`
    : feedbackBlock;

  return { ...requirement, notes };
}

export function attachJudgeFeedbackToTasks(
  result: TaskGenerationResult,
  feedback: string | undefined
): TaskGenerationResult {
  // Workerに引き継ぐためタスクのノートへ反映する
  if (!feedback) {
    return result;
  }

  const feedbackBlock = `Judgeフィードバック:\n${feedback}`;
  const tasks = result.tasks.map((task) => {
    const context = task.context ?? {};
    const notes = context.notes
      ? `${context.notes}\n\n${feedbackBlock}`
      : feedbackBlock;

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
  inspectionNotes: string | undefined
): Requirement {
  // 差分点検の内容を要件に残してタスク生成へ引き継ぐ
  if (!inspectionNotes) {
    return requirement;
  }

  const notes = requirement.notes
    ? `${requirement.notes}\n\n${inspectionNotes}`
    : inspectionNotes;

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
  hints: string | undefined
): Requirement {
  // 既存タスクを共有して重複した計画の生成を抑える
  if (!hints) {
    return requirement;
  }

  const block = `既存タスク（重複回避の参考）:\n${hints}`;
  const notes = requirement.notes ? `${requirement.notes}\n\n${block}` : block;
  return { ...requirement, notes };
}

export function attachInspectionToTasks(
  result: TaskGenerationResult,
  inspectionNotes: string | undefined
): TaskGenerationResult {
  // 差分点検の内容をWorkerにも共有して探索を深める
  if (!inspectionNotes) {
    return result;
  }

  const tasks = result.tasks.map((task) => {
    const context = task.context ?? {};
    const notes = context.notes
      ? `${context.notes}\n\n${inspectionNotes}`
      : inspectionNotes;

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
