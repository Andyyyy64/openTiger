import { addPRComment, mergePR, getOctokit, getRepoInfo } from "@openTiger/vcs";
import type { Policy } from "@openTiger/core";
import type {
  CIEvaluationResult,
  PolicyEvaluationResult,
  LLMEvaluationResult,
  CodeIssue,
} from "./evaluators/index";

const ALLOW_LLM_FAIL_AUTOMERGE = process.env.JUDGE_ALLOW_LLM_FAIL_AUTOMERGE !== "false";

// 判定結果
export type JudgeVerdict = "approve" | "request_changes";

// レビュー結果
export interface JudgeResult {
  verdict: JudgeVerdict;
  reasons: string[];
  suggestions: string[];
  autoMerge: boolean;
  riskLevel: "low" | "medium" | "high";
  confidence: number;
}

// 評価結果の集約
export interface EvaluationSummary {
  ci: CIEvaluationResult;
  policy: PolicyEvaluationResult;
  llm: LLMEvaluationResult;
}

// 判定を行う
export function makeJudgement(
  summary: EvaluationSummary,
  policy: Policy,
  taskRiskLevel: "low" | "medium" | "high",
): JudgeResult {
  const reasons: string[] = [];
  const suggestions: string[] = [];

  // CI評価
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

  // ポリシー評価
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

  // LLM評価
  suggestions.push(...summary.llm.suggestions);
  const maxRiskLevel = policy.autoMerge.maxRiskLevel;
  const canAutoMerge = policy.autoMerge.enabled && isRiskAllowed(taskRiskLevel, maxRiskLevel);
  const allowLlmBypass = ALLOW_LLM_FAIL_AUTOMERGE && canAutoMerge;

  if (!summary.llm.pass) {
    reasons.push(...summary.llm.reasons);
    if (allowLlmBypass) {
      suggestions.push("LLM指摘は参考情報として扱い、低リスクのため自動マージを優先します。");
      return {
        verdict: "approve",
        reasons: [],
        suggestions,
        autoMerge: canAutoMerge,
        riskLevel: taskRiskLevel,
        confidence: summary.llm.confidence,
      };
    }
    // LLMの確信度が低い場合も request_changes に統一する
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

  const shouldRequireHuman = taskRiskLevel === "high" && maxRiskLevel === "low";

  if (shouldRequireHuman) {
    return {
      verdict: "request_changes",
      reasons: ["High-risk change requires rework before merge"],
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

function isRiskAllowed(
  taskRisk: "low" | "medium" | "high",
  maxRisk: "low" | "medium" | "high",
): boolean {
  const priority = { low: 0, medium: 1, high: 2 };
  return priority[taskRisk] <= priority[maxRisk];
}

// レビューコメントを生成
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

  // CI状態
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

  // ポリシー評価
  comment += `### Policy Check: ${summary.policy.pass ? "✅ Passed" : "❌ Violations Found"}\n`;
  if (summary.policy.violations.length > 0) {
    for (const v of summary.policy.violations) {
      const icon = v.severity === "error" ? "❌" : "⚠️";
      comment += `- ${icon} ${v.message}\n`;
    }
  }
  comment += "\n";

  // LLMレビュー
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

  // 理由
  if (result.reasons.length > 0) {
    comment += "### Reasons\n";
    for (const reason of result.reasons) {
      comment += `- ${reason}\n`;
    }
    comment += "\n";
  }

  // 提案
  if (result.suggestions.length > 0) {
    comment += "### Suggestions\n";
    for (const suggestion of result.suggestions) {
      comment += `- ${suggestion}\n`;
    }
    comment += "\n";
  }

  // 自動マージ情報
  if (result.verdict === "approve") {
    if (result.autoMerge) {
      comment += "---\n";
      comment += "🤖 **This PR will be automatically merged.**\n";
    } else {
      comment += "---\n";
      comment += `ℹ️ Auto-merge disabled for ${result.riskLevel}-risk changes.\n`;
    }
  }

  // フッター
  comment += "\n---\n";
  comment += "_Reviewed by openTiger Judge_\n";

  return comment;
}

// PRにレビューコメントを投稿
export async function postReviewComment(
  prNumber: number,
  result: JudgeResult,
  summary: EvaluationSummary,
): Promise<void> {
  const comment = generateReviewComment(result, summary);
  await addPRComment(prNumber, comment);
}

// PRを承認
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

// PRに変更をリクエスト
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

// PRを自動マージ
export async function autoMergePR(
  prNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
): Promise<boolean> {
  return mergePR(prNumber, mergeMethod);
}

// 完全なレビューフローを実行
export async function reviewAndAct(
  prNumber: number,
  result: JudgeResult,
  summary: EvaluationSummary,
): Promise<{
  commented: boolean;
  merged: boolean;
  approved: boolean;
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
    // コメントを投稿
    await postReviewComment(prNumber, result, summary);
    commented = true;

    // 判定に基づいてアクション
    switch (result.verdict) {
      case "approve":
        if (isSelfAuthored) {
          console.log(`Skipping approve for own PR #${prNumber}`);
        } else {
          await approvePR(prNumber);
          approved = true;
        }

        if (result.autoMerge) {
          merged = await autoMergePR(prNumber);
          if (merged) {
            console.log(`PR #${prNumber} has been automatically merged`);
          } else {
            const sync = await trySyncPRWithBase(prNumber);
            mergeDeferred = sync.requested;
            mergeDeferredReason = sync.reason;
            if (sync.requested) {
              console.log(`Requested branch update for PR #${prNumber} before retry`);
            }
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

  return { commented, merged, approved, mergeDeferred, mergeDeferredReason };
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

    // PR作成者と認証ユーザーを比較して自己PRか判定する
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
