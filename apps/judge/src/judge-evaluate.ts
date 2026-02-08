import {
  evaluateCI,
  evaluatePolicy,
  evaluateLLM,
  evaluateLLMDiff,
  evaluateSimple,
  evaluateRiskLevel,
  getPRDiffStats,
  evaluateLocalCI,
  evaluateLocalPolicy,
  getLocalDiffStats,
  getLocalDiffText,
} from "./evaluators/index.js";
import {
  makeJudgement,
  type EvaluationSummary,
  type JudgeResult,
} from "./pr-reviewer.js";
import { precheckPRMergeability, createLLMFailureResult } from "./judge-precheck.js";
import type { JudgeConfig } from "./judge-config.js";

export async function judgeSinglePR(
  pr: {
    prNumber: number;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
  },
  config: JudgeConfig
): Promise<{ result: JudgeResult; summary: EvaluationSummary }> {
  console.log(`\n[Evaluating PR #${pr.prNumber}]`);
  const evaluationPolicy = config.policy;

  // 1. CI評価
  console.log("  - Checking CI status...");
  const ciResult = await evaluateCI(pr.prNumber);
  console.log(`    CI: ${ciResult.pass ? "PASS" : "FAIL"}`);

  // 2. ポリシー評価
  console.log("  - Checking policy compliance...");
  const diffStats = await getPRDiffStats(pr.prNumber);
  const policyResult = await evaluatePolicy(
    pr.prNumber,
    evaluationPolicy,
    pr.allowedPaths
  );
  console.log(`    Policy: ${policyResult.pass ? "PASS" : "FAIL"}`);

  // 計算されたリスクレベル
  const computedRisk = evaluateRiskLevel(diffStats, evaluationPolicy);
  console.log(`    Computed Risk: ${computedRisk} (Task Risk: ${pr.taskRiskLevel})`);

  // 3. LLM評価
  let llmResult;
  if (config.useLlm && ciResult.pass && policyResult.pass) {
    const precheck = await precheckPRMergeability(pr.prNumber);
    if (precheck.shouldSkipLLM) {
      llmResult = precheck.llmFallback ?? createLLMFailureResult(
        "LLM skipped: mergeability_precheck_blocked",
        ["Retry judge review after mergeability precheck."]
      );
      console.log(`    LLM: SKIPPED (${llmResult.reasons.join("; ")})`);
    } else {
      console.log("  - Running LLM code review...");
      llmResult = await evaluateLLM(pr.prNumber, {
        taskGoal: pr.taskGoal,
        instructionsPath: config.instructionsPath,
      });
      console.log(
        `    LLM: ${llmResult.pass ? "PASS" : "FAIL"} (confidence: ${Math.round(llmResult.confidence * 100)}%)`
      );
    }
  } else {
    llmResult = evaluateSimple();
    console.log("    LLM: SKIPPED");
  }

  const summary: EvaluationSummary = {
    ci: ciResult,
    policy: policyResult,
    llm: llmResult,
  };

  // 判定（計算されたリスクと自己申告リスクのうち、高い方を採用）
  const riskPriority = { low: 0, medium: 1, high: 2 };
  const effectiveRisk =
    riskPriority[computedRisk] > riskPriority[pr.taskRiskLevel]
      ? computedRisk
      : pr.taskRiskLevel;

  const result = makeJudgement(summary, config.policy, effectiveRisk);

  console.log(`  => Verdict: ${result.verdict.toUpperCase()}`);
  if (result.autoMerge) {
    console.log("  => Will auto-merge");
  }

  return { result, summary };
}

export async function judgeSingleWorktree(
  target: {
    worktreePath: string;
    baseBranch: string;
    branchName: string;
    baseRepoPath?: string;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
  },
  config: JudgeConfig
): Promise<{ result: JudgeResult; summary: EvaluationSummary; diffFiles: string[] }> {
  console.log(`\n[Evaluating Worktree ${target.worktreePath}]`);
  const evaluationPolicy = config.policy;

  const ciResult = evaluateLocalCI();

  const diffStats = await getLocalDiffStats(
    target.worktreePath,
    target.baseBranch,
    target.branchName
  );
  const diffFiles = diffStats.files.map((file) => file.filename);

  const policyResult = await evaluateLocalPolicy(
    target.worktreePath,
    target.baseBranch,
    target.branchName,
    evaluationPolicy,
    target.allowedPaths
  );

  const computedRisk = evaluateRiskLevel(diffStats, evaluationPolicy);

  let llmResult;
  if (config.useLlm && ciResult.pass && policyResult.pass) {
    const diffText = await getLocalDiffText(
      target.worktreePath,
      target.baseBranch,
      target.branchName
    );
    llmResult = await evaluateLLMDiff(diffText, target.taskGoal, {
      instructionsPath: config.instructionsPath,
    });
  } else {
    llmResult = evaluateSimple();
  }

  const summary: EvaluationSummary = {
    ci: ciResult,
    policy: policyResult,
    llm: llmResult,
  };

  const riskPriority = { low: 0, medium: 1, high: 2 };
  const effectiveRisk =
    riskPriority[computedRisk] > riskPriority[target.taskRiskLevel]
      ? computedRisk
      : target.taskRiskLevel;

  const result = makeJudgement(summary, config.policy, effectiveRisk);
  return { result, summary, diffFiles };
}

export function buildJudgeFailureMessage(
  result: JudgeResult,
  actionError?: unknown
): string {
  const parts = [`Judge verdict: ${result.verdict}`];
  if (result.reasons.length > 0) {
    parts.push(`Reasons: ${result.reasons.slice(0, 3).join(" / ")}`);
  }
  if (actionError) {
    const message = actionError instanceof Error ? actionError.message : String(actionError);
    parts.push(`Action error: ${message}`);
  }
  return parts.join(" | ").slice(0, 1000);
}

export function hasActionableLLMFailures(summary: EvaluationSummary): boolean {
  return !summary.llm.pass && summary.llm.codeIssues.length > 0;
}

export function isDoomLoopFailure(summary: EvaluationSummary): boolean {
  if (summary.llm.pass) {
    return false;
  }
  return summary.llm.reasons.some((reason) => reason.toLowerCase().includes("doom_loop_detected"));
}

export function isNonActionableLLMFailure(summary: EvaluationSummary): boolean {
  if (summary.llm.pass) {
    return false;
  }
  if (summary.llm.codeIssues.length > 0) {
    return false;
  }
  const reasonText = summary.llm.reasons.join(" ").toLowerCase();
  if (reasonText.length === 0) {
    return summary.llm.confidence <= 0;
  }
  return (
    summary.llm.confidence <= 0
    || reasonText.includes("quota")
    || reasonText.includes("rate limit")
    || reasonText.includes("resource_exhausted")
    || reasonText.includes("pr_merge_conflict_detected")
    || reasonText.includes("pr_base_behind")
    || reasonText.includes("mergeability_precheck_failed")
    || reasonText.includes("llm review failed")
    || reasonText.includes("encountered an error")
    || reasonText.includes("manual review recommended")
  );
}
