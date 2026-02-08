import { db } from "@openTiger/db";
import { tasks, events } from "@openTiger/db/schema";
import { and, eq } from "drizzle-orm";
import { SYSTEM_ENTITY_ID, getRepoMode } from "@openTiger/core";
import { createIssue } from "@openTiger/vcs";
import type { Requirement } from "./parser";
import type { PlannedTaskInput, TaskGenerationResult } from "./strategies/index";

type DbLike = typeof db;

// タスクをDBに保存
export async function saveTasks(
  taskInputs: PlannedTaskInput[],
  database: DbLike = db,
  options?: {
    initialStateResolver?: (input: PlannedTaskInput) => {
      status?: "queued" | "blocked";
      blockReason?: string | null;
    };
  },
): Promise<string[]> {
  const savedIds: string[] = [];

  for (const input of taskInputs) {
    const initialState = options?.initialStateResolver?.(input) ?? {};
    const result = await database
      .insert(tasks)
      .values({
        title: input.title,
        goal: input.goal,
        context: input.context,
        allowedPaths: input.allowedPaths,
        commands: input.commands,
        priority: input.priority ?? 0,
        riskLevel: input.riskLevel ?? "low",
        role: input.role ?? "worker",
        targetArea: input.targetArea,
        touches: input.touches ?? [],
        dependencies: input.dependencies ?? [],
        timeboxMinutes: input.timeboxMinutes ?? 60,
        status: initialState.status ?? "queued",
        blockReason: initialState.blockReason ?? null,
      })
      .returning({ id: tasks.id });

    const saved = result[0];
    if (saved) {
      savedIds.push(saved.id);
    }
  }

  return savedIds;
}

// 依存関係を解決してDBのIDで更新
export async function resolveDependencies(
  savedIds: string[],
  originalTasks: PlannedTaskInput[],
  database: DbLike = db,
): Promise<void> {
  // 元のタスクにdependsOnがあった場合、インデックスからIDに変換
  for (let i = 0; i < originalTasks.length; i++) {
    const original = originalTasks[i];
    const savedId = savedIds[i];

    if (!original || !savedId) continue;

    const dependsOnIndexes = original.dependsOnIndexes ?? [];
    if (dependsOnIndexes.length === 0) continue;

    const dependencyIds = dependsOnIndexes
      .map((depIndex) => savedIds[depIndex])
      .filter((depId): depId is string => typeof depId === "string");

    if (dependencyIds.length === 0) {
      console.warn(`[Planner] dependencies resolve failed for task ${savedId}`);
      continue;
    }

    if (dependencyIds.length !== dependsOnIndexes.length) {
      console.warn(
        `[Planner] dependencies mismatch for task ${savedId} (indexes: ${dependsOnIndexes.join(", ")})`,
      );
    }

    await database
      .update(tasks)
      .set({ dependencies: dependencyIds, updatedAt: new Date() })
      .where(eq(tasks.id, savedId));
  }
}

export async function recordPlannerPlanEvent(params: {
  requirementPath: string;
  requirement: Requirement;
  result: TaskGenerationResult;
  savedIds: string[];
  agentId: string;
  signature?: { signature: string; requirementHash: string; repoHeadSha: string };
  database?: DbLike;
}): Promise<void> {
  const { requirementPath, requirement, result, savedIds, agentId, signature } = params;
  const database = params.database ?? db;
  const taskSummaries = result.tasks
    .map((task, index) => {
      const id = savedIds[index];
      if (!id) {
        return undefined;
      }
      return {
        id,
        title: task.title,
        goal: task.goal,
        role: task.role ?? "worker",
        riskLevel: task.riskLevel ?? "low",
        priority: task.priority ?? 0,
        dependencies: task.dependencies ?? [],
      };
    })
    .filter((task): task is NonNullable<typeof task> => typeof task !== "undefined");

  try {
    await database.insert(events).values({
      type: "planner.plan_created",
      entityType: "system",
      entityId: SYSTEM_ENTITY_ID,
      agentId,
      payload: {
        requirementPath,
        requirement: {
          goal: requirement.goal,
          acceptanceCriteriaCount: requirement.acceptanceCriteria.length,
          allowedPaths: requirement.allowedPaths,
          notes: requirement.notes,
        },
        signature: signature?.signature,
        requirementHash: signature?.requirementHash,
        repoHeadSha: signature?.repoHeadSha,
        summary: {
          totalTasks: result.tasks.length,
          totalEstimatedMinutes: result.totalEstimatedMinutes,
          warnings: result.warnings,
        },
        taskIds: taskSummaries.map((task) => task.id),
        tasks: taskSummaries,
      },
    });
  } catch (error) {
    console.warn("[Planner] Failed to record plan event:", error);
  }
}

function buildIssueTitle(task: PlannedTaskInput): string {
  return `[Task] ${task.title}`;
}

function buildIssueBody(params: {
  taskId: string;
  task: PlannedTaskInput;
  requirement: Requirement;
}): string {
  const { taskId, task, requirement } = params;
  const role = task.role ?? "worker";
  const riskLevel = task.riskLevel ?? "low";
  const timebox = task.timeboxMinutes ?? 60;
  const notes = task.context?.notes?.trim();
  const specs = task.context?.specs?.trim();
  const files = task.context?.files ?? [];
  const allowedPaths = task.allowedPaths ?? [];
  const commands = task.commands ?? [];

  const lines: string[] = [
    "## Task",
    "",
    `- Task ID: \`${taskId}\``,
    `- Role: ${role}`,
    `- Risk Level: ${riskLevel}`,
    `- Timebox: ${timebox} minutes`,
    "",
    "## Goal",
    "",
    task.goal,
    "",
    "## Requirement",
    "",
    requirement.goal,
    "",
    "## Allowed Paths",
    "",
  ];

  if (allowedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const path of allowedPaths) {
      lines.push(`- ${path}`);
    }
  }

  lines.push("", "## Commands", "");

  if (commands.length === 0) {
    lines.push("- (none)");
  } else {
    for (const command of commands) {
      lines.push(`- \`${command}\``);
    }
  }

  if (files.length > 0) {
    lines.push("", "## Related Files", "");
    for (const file of files) {
      lines.push(`- ${file}`);
    }
  }

  if (specs) {
    lines.push("", "## Specs", "", specs);
  }

  if (notes) {
    lines.push("", "## Notes", "", notes);
  }

  lines.push("", "---", "", "このIssueはPlannerが自動生成しました。");

  return lines.join("\n");
}

export async function createIssuesForTasks(params: {
  requirement: Requirement;
  tasks: PlannedTaskInput[];
  savedIds: string[];
}): Promise<void> {
  const repoMode = getRepoMode();
  if (repoMode !== "git") {
    console.warn(`[Planner] REPO_MODE=${repoMode} のためIssue作成をスキップします。`);
    return;
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_OWNER || !process.env.GITHUB_REPO) {
    console.warn("[Planner] GitHub設定がないためIssue作成をスキップします。");
    return;
  }

  const { requirement, tasks: taskInputs, savedIds } = params;

  // Plannerで生成したタスクをIssue化して追跡しやすくする
  for (let index = 0; index < taskInputs.length; index += 1) {
    const task = taskInputs[index];
    const taskId = savedIds[index];
    if (!task || !taskId) continue;
    if (task.context?.issue?.number) {
      await db
        .update(tasks)
        .set({
          status: "queued",
          blockReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.status, "blocked"),
            eq(tasks.blockReason, "issue_linking"),
          ),
        );
      continue;
    }

    try {
      const issue = await createIssue({
        title: buildIssueTitle(task),
        body: buildIssueBody({ taskId, task, requirement }),
      });

      const updatedContext = {
        ...task.context,
        issue: {
          number: issue.number,
          url: issue.url,
          title: issue.title,
        },
      };

      await db
        .update(tasks)
        .set({
          context: updatedContext,
          status: "queued",
          blockReason: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Planner] Failed to create issue for task ${taskId}: ${message}`);
      // Issue連携失敗時でも実行自体は止めない（自動クローズ連携は失われる）
      await db
        .update(tasks)
        .set({
          status: "queued",
          blockReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.status, "blocked"),
            eq(tasks.blockReason, "issue_linking"),
          ),
        );
    }
  }
}
