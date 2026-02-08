import { db } from "@openTiger/db";
import { tasks, events } from "@openTiger/db/schema";
import { and, inArray, sql } from "drizzle-orm";
import { getOctokit, getRepoInfo } from "@openTiger/vcs";
import {
  JUDGE_AUTO_FIX_ON_FAIL,
  JUDGE_AUTO_FIX_MAX_ATTEMPTS,
  formatJudgeAutoFixLimit,
  isJudgeAutoFixUnlimited,
} from "./judge-config";
import type { EvaluationSummary } from "./pr-reviewer";

export function escapeSqlLikePattern(input: string): string {
  return input
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function summarizeLLMIssuesForTask(summary: EvaluationSummary): string {
  const issues = summary.llm.codeIssues.slice(0, 12).map((issue, index) => {
    const location = issue.file
      ? `${issue.file}${issue.line ? `:${issue.line}` : ""}`
      : "unknown";
    const suggestion = issue.suggestion ? ` | fix: ${issue.suggestion}` : "";
    return `${index + 1}. [${issue.severity}] ${issue.category} @ ${location}: ${issue.message}${suggestion}`;
  });
  if (issues.length === 0) {
    return summary.llm.reasons.join("\n");
  }
  return issues.join("\n");
}

export function isMergeConflictReasonText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return (
    lower.includes("not mergeable")
    || lower.includes("merge conflict")
    || lower.includes("conflict")
    || lower.includes("pr_merge_conflict_detected")
    || lower.includes("mergeable_state")
    || lower.includes("dirty")
    || lower.includes("update_branch_failed")
  );
}

export function hasMergeConflictSignals(params: {
  summary: EvaluationSummary;
  mergeDeferredReason?: string;
}): boolean {
  if (isMergeConflictReasonText(params.mergeDeferredReason)) {
    return true;
  }
  if (params.summary.llm.reasons.some((reason) => isMergeConflictReasonText(reason))) {
    return true;
  }
  return params.summary.llm.suggestions.some((suggestion) =>
    isMergeConflictReasonText(suggestion)
  );
}

export async function getPrBranchContext(prNumber: number): Promise<{
  headRef?: string;
  headSha?: string;
  baseRef?: string;
}> {
  try {
    const octokit = getOctokit();
    const { owner, repo } = getRepoInfo();
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return {
      headRef: response.data.head.ref ?? undefined,
      headSha: response.data.head.sha ?? undefined,
      baseRef: response.data.base.ref ?? undefined,
    };
  } catch (error) {
    console.warn(
      `[Judge] Failed to resolve PR branch context for #${prNumber}:`,
      error
    );
    return {};
  }
}

export async function createAutoFixTaskForPr(params: {
  prNumber: number;
  prUrl: string;
  sourceTaskId: string;
  sourceRunId: string;
  sourceTaskTitle: string;
  sourceTaskGoal: string;
  allowedPaths: string[];
  commands: string[];
  summary: EvaluationSummary;
  agentId: string;
}): Promise<{ created: boolean; taskId?: string; reason: string }> {
  if (!JUDGE_AUTO_FIX_ON_FAIL) {
    return { created: false, reason: "auto_fix_disabled" };
  }
  if (params.summary.llm.pass) {
    return { created: false, reason: "llm_pass" };
  }

  const titlePrefix = `[AutoFix] PR #${params.prNumber}`;
  const titlePattern = `${escapeSqlLikePattern(titlePrefix)}%`;
  const maxAttempts = JUDGE_AUTO_FIX_MAX_ATTEMPTS;
  const maxAttemptsLabel = formatJudgeAutoFixLimit(maxAttempts);

  const [activeTask] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(
      and(
        sql`${tasks.title} like ${titlePattern} escape '\\'`,
        inArray(tasks.status, ["queued", "running", "blocked"])
      )
    )
    .limit(1);
  if (activeTask?.id) {
    return { created: false, reason: `existing_active_autofix:${activeTask.id}` };
  }

  const [attemptRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(sql`${tasks.title} like ${titlePattern} escape '\\'`);
  const attemptCount = Number(attemptRow?.count ?? 0);
  if (!isJudgeAutoFixUnlimited() && attemptCount >= maxAttempts) {
    return {
      created: false,
      reason: `autofix_attempt_limit_reached:${attemptCount}/${maxAttemptsLabel}`,
    };
  }

  const issueFiles = Array.from(
    new Set(
      params.summary.llm.codeIssues
        .map((issue) => issue.file?.trim())
        .filter((file): file is string => Boolean(file))
    )
  );
  const summarizedIssues = summarizeLLMIssuesForTask(params.summary);
  const nextAttempt = attemptCount + 1;
  const prBranchContext = await getPrBranchContext(params.prNumber);

  const [taskRow] = await db
    .insert(tasks)
    .values({
      title: `${titlePrefix} (attempt ${nextAttempt}/${maxAttemptsLabel})`,
      goal:
        `Fix judge-reported issues for PR #${params.prNumber} and create a follow-up PR that passes review. ` +
        `Original review task: ${params.sourceTaskId}.`,
      context: {
        files: issueFiles,
        specs:
          "Resolve the issues listed in notes. Keep scope minimal and aligned with allowed paths. " +
          "Do not run long-running dev/watch/start commands.",
        notes: summarizedIssues,
        pr: {
          number: params.prNumber,
          url: params.prUrl,
          sourceTaskId: params.sourceTaskId,
          sourceRunId: params.sourceRunId,
          headRef: prBranchContext.headRef,
          headSha: prBranchContext.headSha,
          baseRef: prBranchContext.baseRef,
        },
      },
      allowedPaths: params.allowedPaths.length > 0 ? params.allowedPaths : ["**"],
      commands: params.commands,
      dependencies: [],
      priority: 80,
      riskLevel: "medium",
      role: "worker",
      status: "queued",
      timeboxMinutes: 60,
    })
    .returning({ id: tasks.id });

  if (!taskRow?.id) {
    return { created: false, reason: "autofix_task_insert_failed" };
  }

  await db.insert(events).values({
    type: "judge.autofix_task_created",
    entityType: "task",
    entityId: taskRow.id,
    agentId: params.agentId,
    payload: {
      prNumber: params.prNumber,
      sourceTaskId: params.sourceTaskId,
      sourceRunId: params.sourceRunId,
      sourceTaskTitle: params.sourceTaskTitle,
      sourceTaskGoal: params.sourceTaskGoal,
      attempt: nextAttempt,
      maxAttempts: maxAttempts < 0 ? null : maxAttempts,
    },
  });

  return { created: true, taskId: taskRow.id, reason: "created" };
}

export async function createConflictAutoFixTaskForPr(params: {
  prNumber: number;
  prUrl: string;
  sourceTaskId: string;
  sourceRunId: string;
  sourceTaskTitle: string;
  sourceTaskGoal: string;
  allowedPaths: string[];
  commands: string[];
  summary: EvaluationSummary;
  agentId: string;
  mergeDeferredReason?: string;
}): Promise<{ created: boolean; taskId?: string; reason: string }> {
  if (!JUDGE_AUTO_FIX_ON_FAIL) {
    return { created: false, reason: "auto_fix_disabled" };
  }

  const titlePrefix = `[AutoFix-Conflict] PR #${params.prNumber}`;
  const titlePattern = `${escapeSqlLikePattern(titlePrefix)}%`;
  const maxAttempts = JUDGE_AUTO_FIX_MAX_ATTEMPTS;
  const maxAttemptsLabel = formatJudgeAutoFixLimit(maxAttempts);

  const [activeTask] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(
      and(
        sql`${tasks.title} like ${titlePattern} escape '\\'`,
        inArray(tasks.status, ["queued", "running", "blocked"])
      )
    )
    .limit(1);
  if (activeTask?.id) {
    return { created: false, reason: `existing_active_conflict_autofix:${activeTask.id}` };
  }

  const [attemptRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(sql`${tasks.title} like ${titlePattern} escape '\\'`);
  const attemptCount = Number(attemptRow?.count ?? 0);
  if (!isJudgeAutoFixUnlimited() && attemptCount >= maxAttempts) {
    return {
      created: false,
      reason: `conflict_autofix_attempt_limit_reached:${attemptCount}/${maxAttemptsLabel}`,
    };
  }

  const reasonLine = params.mergeDeferredReason
    ? `merge_reason: ${params.mergeDeferredReason}`
    : "merge_reason: unknown";
  const llmReasonLines = params.summary.llm.reasons.length > 0
    ? params.summary.llm.reasons.map((reason) => `- ${reason}`).join("\n")
    : "- (none)";
  const nextAttempt = attemptCount + 1;
  const prBranchContext = await getPrBranchContext(params.prNumber);

  const [taskRow] = await db
    .insert(tasks)
    .values({
      title: `${titlePrefix} (attempt ${nextAttempt}/${maxAttemptsLabel})`,
      goal:
        `Resolve merge conflicts for PR #${params.prNumber} and make it mergeable without human intervention. ` +
        `Original review task: ${params.sourceTaskId}.`,
      context: {
        files: [],
        specs:
          "Resolve base-branch conflicts for the target PR. Prefer updating the existing PR branch. " +
          "If not feasible, create a replacement PR that contains equivalent changes and references the original PR.",
        notes:
          `${reasonLine}\n` +
          "Judge/LLM reasons:\n" +
          `${llmReasonLines}\n` +
          "Do not run long-running dev/watch/start commands.",
        pr: {
          number: params.prNumber,
          url: params.prUrl,
          sourceTaskId: params.sourceTaskId,
          sourceRunId: params.sourceRunId,
          headRef: prBranchContext.headRef,
          headSha: prBranchContext.headSha,
          baseRef: prBranchContext.baseRef,
        },
      },
      allowedPaths: params.allowedPaths.length > 0 ? params.allowedPaths : ["**"],
      commands: params.commands,
      dependencies: [],
      priority: 90,
      riskLevel: "medium",
      role: "worker",
      status: "queued",
      timeboxMinutes: 60,
    })
    .returning({ id: tasks.id });

  if (!taskRow?.id) {
    return { created: false, reason: "conflict_autofix_task_insert_failed" };
  }

  await db.insert(events).values({
    type: "judge.conflict_autofix_task_created",
    entityType: "task",
    entityId: taskRow.id,
    agentId: params.agentId,
    payload: {
      prNumber: params.prNumber,
      sourceTaskId: params.sourceTaskId,
      sourceRunId: params.sourceRunId,
      sourceTaskTitle: params.sourceTaskTitle,
      sourceTaskGoal: params.sourceTaskGoal,
      attempt: nextAttempt,
      maxAttempts: maxAttempts < 0 ? null : maxAttempts,
      mergeDeferredReason: params.mergeDeferredReason,
    },
  });

  return { created: true, taskId: taskRow.id, reason: "created" };
}
