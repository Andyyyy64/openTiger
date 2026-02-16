import { addPRComment, mergePR, getOctokit, getRepoInfo } from "@openTiger/vcs";
import type { Policy } from "@openTiger/core";
import type {
  CIEvaluationResult,
  PolicyEvaluationResult,
  LLMEvaluationResult,
} from "./evaluators/index";

const ALLOW_LLM_FAIL_AUTOMERGE = process.env.JUDGE_ALLOW_LLM_FAIL_AUTOMERGE !== "false";

// Verdict type
export type JudgeVerdict = "approve" | "request_changes";

// Review result
export interface JudgeResult {
  verdict: JudgeVerdict;
  reasons: string[];
  suggestions: string[];
  autoMerge: boolean;
  riskLevel: "low" | "medium" | "high";
  confidence: number;
}

// Aggregated evaluation result
export interface EvaluationSummary {
  ci: CIEvaluationResult;
  policy: PolicyEvaluationResult;
  llm: LLMEvaluationResult;
}

// Make judgement
export function makeJudgement(
  summary: EvaluationSummary,
  policy: Policy,
  taskRiskLevel: "low" | "medium" | "high",
): JudgeResult {
  const reasons: string[] = [];
  const suggestions: string[] = [];

  // CI evaluation
  if (!summary.ci.pass) {
    return {
      verdict: "request_changes",
      reasons: summary.ci.reasons,
      suggestions: summary.ci.suggestions,
      autoMerge: false,
      riskLevel: taskRiskLevel,
      confidence: 1.0,
    };
  }

  // Policy evaluation
  if (!summary.policy.pass) {
    reasons.push(...summary.policy.reasons);
    suggestions.push(...summary.policy.suggestions);
    return {
      verdict: "request_changes",
      reasons,
      suggestions,
      autoMerge: false,
      riskLevel: taskRiskLevel,
      confidence: 1.0,
    };
  }

  // LLM evaluation
  suggestions.push(...summary.llm.suggestions);
  const canAutoMerge = policy.autoMerge.enabled;
  const allowLlmBypass = ALLOW_LLM_FAIL_AUTOMERGE && canAutoMerge;

  if (!summary.llm.pass) {
    reasons.push(...summary.llm.reasons);
    if (allowLlmBypass) {
      suggestions.push("Treat LLM findings as informational; low risk favors auto-merge.");
      return {
        verdict: "approve",
        reasons: [],
        suggestions,
        autoMerge: canAutoMerge,
        riskLevel: taskRiskLevel,
        confidence: summary.llm.confidence,
      };
    }
    // Use request_changes when LLM confidence is low too
    if (summary.llm.confidence < 0.7) {
      return {
        verdict: "request_changes",
        reasons,
        suggestions,
        autoMerge: false,
        riskLevel: taskRiskLevel,
        confidence: summary.llm.confidence,
      };
    }
    return {
      verdict: "request_changes",
      reasons,
      suggestions,
      autoMerge: false,
      riskLevel: taskRiskLevel,
      confidence: summary.llm.confidence,
    };
  }

  return {
    verdict: "approve",
    reasons: [],
    suggestions,
    autoMerge: canAutoMerge,
    riskLevel: taskRiskLevel,
    confidence: summary.llm.confidence,
  };
}

// Generate review comment
export function generateReviewComment(result: JudgeResult, summary: EvaluationSummary): string {
  const verdictEmoji = {
    approve: "✅",
    request_changes: "❌",
  };

  const verdictLabel = {
    approve: "Approved",
    request_changes: "Changes Requested",
  };

  let comment = `## ${verdictEmoji[result.verdict]} Judge Verdict: ${verdictLabel[result.verdict]}\n\n`;

  // CI status
  comment += `### CI Status: ${summary.ci.pass ? "✅ Passed" : "❌ Failed"}\n`;
  if (summary.ci.details.length > 0) {
    for (const check of summary.ci.details.slice(0, 5)) {
      const icon = check.status === "success" ? "✅" : check.status === "failure" ? "❌" : "⏳";
      comment += `- ${icon} ${check.name}\n`;
    }
    if (summary.ci.details.length > 5) {
      comment += `- ... and ${summary.ci.details.length - 5} more checks\n`;
    }
  }
  comment += "\n";

  // Policy evaluation
  comment += `### Policy Check: ${summary.policy.pass ? "✅ Passed" : "❌ Violations Found"}\n`;
  if (summary.policy.violations.length > 0) {
    for (const v of summary.policy.violations) {
      const icon = v.severity === "error" ? "❌" : "⚠️";
      comment += `- ${icon} ${v.message}\n`;
    }
  }
  comment += "\n";

  // LLM review
  if (summary.llm.confidence > 0) {
    comment += `### Code Review: ${summary.llm.pass ? "✅ No Issues" : "⚠️ Issues Found"}\n`;
    comment += `Confidence: ${Math.round(summary.llm.confidence * 100)}%\n\n`;

    if (summary.llm.codeIssues.length > 0) {
      for (const issue of summary.llm.codeIssues.slice(0, 10)) {
        const icon = issue.severity === "error" ? "❌" : issue.severity === "warning" ? "⚠️" : "ℹ️";
        let line = `- ${icon} **${issue.category}**: ${issue.message}`;
        if (issue.file) {
          line += ` (${issue.file}${issue.line ? `:${issue.line}` : ""})`;
        }
        comment += line + "\n";
      }
    }
    comment += "\n";
  }

  // Reasons
  if (result.reasons.length > 0) {
    comment += "### Reasons\n";
    for (const reason of result.reasons) {
      comment += `- ${reason}\n`;
    }
    comment += "\n";
  }

  // Suggestions
  if (result.suggestions.length > 0) {
    comment += "### Suggestions\n";
    for (const suggestion of result.suggestions) {
      comment += `- ${suggestion}\n`;
    }
    comment += "\n";
  }

  // Auto-merge info
  if (result.verdict === "approve") {
    if (result.autoMerge) {
      comment += "---\n";
      comment += "🤖 **This PR will be automatically merged.**\n";
    } else {
      comment += "---\n";
      comment += "ℹ️ Auto-merge is disabled by policy.\n";
    }
  }

  // Footer
  comment += "\n---\n";
  comment += "_Reviewed by openTiger Judge_\n";

  return comment;
}

// Post review comment to PR
export async function postReviewComment(
  prNumber: number,
  result: JudgeResult,
  summary: EvaluationSummary,
): Promise<void> {
  const comment = generateReviewComment(result, summary);
  await addPRComment(prNumber, comment);
}

// Approve PR
export async function approvePR(prNumber: number): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "APPROVE",
  });
}

// Request changes on PR
export async function requestChanges(prNumber: number, reasons: string[]): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "REQUEST_CHANGES",
    body: reasons.join("\n"),
  });
}

// Auto-merge PR
export async function autoMergePR(
  prNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
): Promise<{ merged: boolean; status?: number; reason?: string }> {
  return mergePR(prNumber, mergeMethod);
}

function isMergeInProgressReason(reason: string | undefined): boolean {
  if (!reason) {
    return false;
  }
  const normalized = reason.toLowerCase();
  return (
    normalized.includes("merge already in progress") ||
    normalized.includes("merge is already in progress")
  );
}

async function isMergedPR(prNumber: number): Promise<boolean> {
  try {
    const octokit = getOctokit();
    const { owner, repo } = getRepoInfo();
    const pr = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return Boolean(pr.data.merged);
  } catch (error) {
    console.warn(`[Judge] Failed to re-check merge state for PR #${prNumber}:`, error);
    return false;
  }
}

export async function attemptMergeForApprovedPR(prNumber: number): Promise<{
  merged: boolean;
  mergeDeferred: boolean;
  mergeDeferredReason?: string;
}> {
  let merged = false;
  let mergeDeferred = false;
  let mergeDeferredReason: string | undefined;

  const mergeResult = await autoMergePR(prNumber);
  merged = mergeResult.merged;
  if (!merged) {
    const mergedAfterFailure = await isMergedPR(prNumber);
    if (mergedAfterFailure) {
      return {
        merged: true,
        mergeDeferred: false,
      };
    }

    if (isMergeInProgressReason(mergeResult.reason)) {
      mergeDeferred = true;
      mergeDeferredReason = "merge_already_in_progress";
    } else {
      const sync = await trySyncPRWithBase(prNumber);
      mergeDeferred = sync.requested;
      mergeDeferredReason = sync.reason;
      if (sync.requested) {
        console.log(`Requested branch update for PR #${prNumber} before retry`);
      }
    }
  }

  return { merged, mergeDeferred, mergeDeferredReason };
}

// Run full review flow
export async function reviewAndAct(
  prNumber: number,
  result: JudgeResult,
  summary: EvaluationSummary,
): Promise<{
  commented: boolean;
  merged: boolean;
  approved: boolean;
  selfAuthored: boolean;
  mergeDeferred?: boolean;
  mergeDeferredReason?: string;
}> {
  let commented = false;
  let merged = false;
  let approved = false;
  let mergeDeferred = false;
  let mergeDeferredReason: string | undefined;
  const isSelfAuthored = await isSelfAuthoredPR(prNumber);

  try {
    // Post comment
    await postReviewComment(prNumber, result, summary);
    commented = true;

    // Act based on verdict
    switch (result.verdict) {
      case "approve":
        if (isSelfAuthored) {
          console.log(`Skipping approve for own PR #${prNumber}`);
        } else {
          await approvePR(prNumber);
          approved = true;
        }

        if (result.autoMerge) {
          const mergeResult = await attemptMergeForApprovedPR(prNumber);
          merged = mergeResult.merged;
          mergeDeferred = mergeResult.mergeDeferred;
          mergeDeferredReason = mergeResult.mergeDeferredReason;
          if (merged) {
            console.log(`PR #${prNumber} has been automatically merged`);
          } else if (mergeDeferred) {
            // Keep return payload explicit so caller can enqueue merge queue retries.
            console.log(
              `PR #${prNumber} merge deferred (${mergeDeferredReason ?? "pending_branch_sync"})`,
            );
          }
        }
        break;

      case "request_changes":
        if (isSelfAuthored) {
          console.log(`Skipping request changes for own PR #${prNumber}`);
        } else {
          await requestChanges(prNumber, result.reasons);
        }
        break;
    }
  } catch (error) {
    console.error(`Failed to process PR #${prNumber}:`, error);
  }

  return {
    commented,
    merged,
    approved,
    selfAuthored: isSelfAuthored,
    mergeDeferred,
    mergeDeferredReason,
  };
}

async function trySyncPRWithBase(
  prNumber: number,
): Promise<{ requested: boolean; reason: string }> {
  try {
    const octokit = getOctokit();
    const { owner, repo } = getRepoInfo();
    await octokit.pulls.updateBranch({
      owner,
      repo,
      pull_number: prNumber,
    });
    return { requested: true, reason: "update_branch_requested" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { requested: false, reason: `update_branch_failed:${message}` };
  }
}

async function isSelfAuthoredPR(prNumber: number): Promise<boolean> {
  try {
    const octokit = getOctokit();
    const { owner, repo } = getRepoInfo();

    // Compare PR author with auth user to detect self-PR
    const [pr, user] = await Promise.all([
      octokit.pulls.get({ owner, repo, pull_number: prNumber }),
      octokit.users.getAuthenticated(),
    ]);

    const author = pr.data.user?.login?.toLowerCase();
    const viewer = user.data.login?.toLowerCase();
    return !!author && !!viewer && author === viewer;
  } catch (error) {
    console.error("Failed to detect PR author:", error);
    return false;
  }
}
