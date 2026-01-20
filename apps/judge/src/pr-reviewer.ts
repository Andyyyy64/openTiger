import { addPRComment, mergePR, getOctokit, getRepoInfo } from "@h1ve/vcs";
import type { Policy } from "@h1ve/core";
import type { CIEvaluationResult, PolicyEvaluationResult, LLMEvaluationResult, CodeIssue } from "./evaluators/index.js";

// 判定結果
export type JudgeVerdict = "approve" | "request_changes" | "needs_human";

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
  taskRiskLevel: "low" | "medium" | "high"
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

  if (!summary.llm.pass) {
    reasons.push(...summary.llm.reasons);
    // LLMの確信度が低い場合は人間レビューを要求
    if (summary.llm.confidence < 0.7) {
      return {
        verdict: "needs_human",
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

  // 高リスクの場合は人間レビューを要求
  if (taskRiskLevel === "high") {
    return {
      verdict: "needs_human",
      reasons: ["High-risk change requires human review"],
      suggestions,
      autoMerge: false,
      riskLevel: taskRiskLevel,
      confidence: summary.llm.confidence,
    };
  }

  // 自動マージの判定
  const canAutoMerge =
    policy.autoMerge.enabled &&
    (taskRiskLevel === "low" ||
      (taskRiskLevel === "medium" && policy.autoMerge.maxRiskLevel !== "low"));

  return {
    verdict: "approve",
    reasons: [],
    suggestions,
    autoMerge: canAutoMerge,
    riskLevel: taskRiskLevel,
    confidence: summary.llm.confidence,
  };
}

// レビューコメントを生成
export function generateReviewComment(
  result: JudgeResult,
  summary: EvaluationSummary
): string {
  const verdictEmoji = {
    approve: "✅",
    request_changes: "❌",
    needs_human: "👀",
  };

  const verdictLabel = {
    approve: "Approved",
    request_changes: "Changes Requested",
    needs_human: "Human Review Required",
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
  comment += "_Reviewed by h1ve Judge_\n";

  return comment;
}

// PRにレビューコメントを投稿
export async function postReviewComment(
  prNumber: number,
  result: JudgeResult,
  summary: EvaluationSummary
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
export async function requestChanges(
  prNumber: number,
  reasons: string[]
): Promise<void> {
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
  mergeMethod: "merge" | "squash" | "rebase" = "squash"
): Promise<boolean> {
  return mergePR(prNumber, mergeMethod);
}

// 完全なレビューフローを実行
export async function reviewAndAct(
  prNumber: number,
  result: JudgeResult,
  summary: EvaluationSummary
): Promise<{ commented: boolean; merged: boolean; approved: boolean }> {
  let commented = false;
  let merged = false;
  let approved = false;

  try {
    // コメントを投稿
    await postReviewComment(prNumber, result, summary);
    commented = true;

    // 判定に基づいてアクション
    switch (result.verdict) {
      case "approve":
        await approvePR(prNumber);
        approved = true;

        if (result.autoMerge) {
          merged = await autoMergePR(prNumber);
          if (merged) {
            console.log(`PR #${prNumber} has been automatically merged`);
          }
        }
        break;

      case "request_changes":
        await requestChanges(prNumber, result.reasons);
        break;

      case "needs_human":
        // 人間レビューが必要な場合は何もしない
        break;
    }
  } catch (error) {
    console.error(`Failed to process PR #${prNumber}:`, error);
  }

  return { commented, merged, approved };
}
