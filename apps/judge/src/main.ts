import type { Policy } from "@h1ve/core";

// Judge: PRの採用/差し戻しを判定する
// 評価順序:
// 1. CI結果（必須）
// 2. ポリシー違反チェック
// 3. LLMレビュー（補助）

type JudgeVerdict = "approve" | "request_changes" | "needs_human";

interface JudgeResult {
  verdict: JudgeVerdict;
  reasons: string[];
  suggestions: string[];
  autoMerge: boolean;
}

interface PRInfo {
  number: number;
  title: string;
  branch: string;
  diff: string;
  ciStatus: "success" | "failure" | "pending";
  ciLogs?: string;
}

interface EvaluatorResult {
  pass: boolean;
  reasons: string[];
  suggestions: string[];
}

// CI結果評価
async function evaluateCI(pr: PRInfo): Promise<EvaluatorResult> {
  if (pr.ciStatus === "pending") {
    return {
      pass: false,
      reasons: ["CI is still running"],
      suggestions: ["Wait for CI to complete"],
    };
  }

  if (pr.ciStatus === "failure") {
    return {
      pass: false,
      reasons: ["CI failed"],
      suggestions: ["Fix the failing tests"],
    };
  }

  return {
    pass: true,
    reasons: [],
    suggestions: [],
  };
}

// ポリシー評価
async function evaluatePolicy(
  pr: PRInfo,
  policy: Policy
): Promise<EvaluatorResult> {
  const reasons: string[] = [];
  const suggestions: string[] = [];

  // TODO: diff解析して以下をチェック
  // - 変更行数
  // - 変更ファイル数
  // - 禁止パスへの変更
  // - 禁止コマンドの使用

  return {
    pass: reasons.length === 0,
    reasons,
    suggestions,
  };
}

// LLMレビュー
async function evaluateLLM(pr: PRInfo): Promise<EvaluatorResult> {
  // TODO: LLMを使ってコードレビュー
  // - コード品質
  // - セキュリティ
  // - パフォーマンス

  return {
    pass: true,
    reasons: [],
    suggestions: [],
  };
}

async function judgePR(pr: PRInfo, policy: Policy): Promise<JudgeResult> {
  console.log(`Judging PR #${pr.number}: ${pr.title}`);

  const allReasons: string[] = [];
  const allSuggestions: string[] = [];

  // 1. CI評価（必須）
  const ciResult = await evaluateCI(pr);
  if (!ciResult.pass) {
    return {
      verdict: "request_changes",
      reasons: ciResult.reasons,
      suggestions: ciResult.suggestions,
      autoMerge: false,
    };
  }

  // 2. ポリシー評価
  const policyResult = await evaluatePolicy(pr, policy);
  allReasons.push(...policyResult.reasons);
  allSuggestions.push(...policyResult.suggestions);

  if (!policyResult.pass) {
    return {
      verdict: "request_changes",
      reasons: allReasons,
      suggestions: allSuggestions,
      autoMerge: false,
    };
  }

  // 3. LLMレビュー（補助）
  const llmResult = await evaluateLLM(pr);
  allSuggestions.push(...llmResult.suggestions);

  // 判定
  const verdict: JudgeVerdict = llmResult.pass ? "approve" : "needs_human";

  // 自動マージ可否
  const autoMerge =
    policy.autoMerge.enabled &&
    verdict === "approve" &&
    allReasons.length === 0;

  return {
    verdict,
    reasons: allReasons,
    suggestions: allSuggestions,
    autoMerge,
  };
}

// メイン処理
async function main() {
  console.log("Judge started");
  console.log("Waiting for PRs to review...");

  // TODO: Webhookまたはポーリングで新規PRを検出して評価
}

main().catch(console.error);
