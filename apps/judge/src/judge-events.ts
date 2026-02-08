import { db } from "@openTiger/db";
import { events } from "@openTiger/db/schema";
import type { EvaluationSummary, JudgeResult } from "./pr-reviewer";

export async function recordJudgeReview(
  pr: {
    prNumber: number;
    prUrl: string;
    taskId: string;
    runId: string;
  },
  result: JudgeResult,
  summary: EvaluationSummary,
  actionResult: { commented: boolean; approved: boolean; merged: boolean },
  agentId: string,
  dryRun: boolean
): Promise<void> {
  try {
    await db.insert(events).values({
      type: "judge.review",
      entityType: "task",
      entityId: pr.taskId,
      agentId,
      payload: {
        prNumber: pr.prNumber,
        prUrl: pr.prUrl,
        runId: pr.runId,
        taskId: pr.taskId,
        verdict: result.verdict,
        autoMerge: result.autoMerge,
        riskLevel: result.riskLevel,
        confidence: result.confidence,
        reasons: result.reasons,
        suggestions: result.suggestions,
        summary,
        actions: actionResult,
        dryRun,
      },
    });
  } catch (error) {
    console.error(
      `[Judge] Failed to record review event for PR #${pr.prNumber}:`,
      error
    );
  }
}

export async function recordLocalReview(
  target: {
    taskId: string;
    runId: string;
    worktreePath: string;
    baseBranch: string;
    branchName: string;
    baseRepoPath?: string;
  },
  result: JudgeResult,
  summary: EvaluationSummary,
  agentId: string,
  dryRun: boolean,
  mergeResult?: { success: boolean; error?: string }
): Promise<void> {
  try {
    await db.insert(events).values({
      type: "judge.review",
      entityType: "task",
      entityId: target.taskId,
      agentId,
      payload: {
        mode: "local",
        taskId: target.taskId,
        runId: target.runId,
        worktreePath: target.worktreePath,
        baseBranch: target.baseBranch,
        branchName: target.branchName,
        baseRepoPath: target.baseRepoPath,
        verdict: result.verdict,
        autoMerge: result.autoMerge,
        riskLevel: result.riskLevel,
        confidence: result.confidence,
        reasons: result.reasons,
        suggestions: result.suggestions,
        summary,
        dryRun,
        mergeResult,
      },
    });
  } catch (error) {
    console.error("[Judge] Failed to record local review event:", error);
  }
}
