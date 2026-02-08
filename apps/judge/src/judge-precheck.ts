import { getOctokit, getRepoInfo } from "@openTiger/vcs";
import type { LLMEvaluationResult } from "./evaluators/index.js";
import {
  JUDGE_PR_MERGEABLE_PRECHECK_RETRIES,
  JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS,
} from "./judge-config.js";

interface PRMergeabilitySnapshot {
  mergeable: boolean | null;
  mergeableState: string;
}

export interface PRMergeabilityPrecheck {
  shouldSkipLLM: boolean;
  llmFallback?: LLMEvaluationResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLLMFailureResult(
  reason: string,
  suggestions: string[]
): LLMEvaluationResult {
  return {
    pass: false,
    confidence: 0,
    reasons: [reason],
    suggestions,
    codeIssues: [],
  };
}

function isMergeConflictState(snapshot: PRMergeabilitySnapshot): boolean {
  if (snapshot.mergeable === true) {
    return false;
  }
  return snapshot.mergeableState === "dirty";
}

async function getPRMergeabilitySnapshot(prNumber: number): Promise<PRMergeabilitySnapshot> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();
  const maxRetries = Number.isFinite(JUDGE_PR_MERGEABLE_PRECHECK_RETRIES)
    ? Math.max(1, JUDGE_PR_MERGEABLE_PRECHECK_RETRIES)
    : 3;
  const retryDelayMs = Number.isFinite(JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS)
    ? Math.max(0, JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS)
    : 1000;

  let mergeable: boolean | null = null;
  let mergeableState = "unknown";

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    mergeable = response.data.mergeable;
    mergeableState = response.data.mergeable_state ?? "unknown";

    if (mergeable !== null || attempt === maxRetries) {
      break;
    }
    await sleep(retryDelayMs);
  }

  return { mergeable, mergeableState };
}

async function tryUpdatePRBranch(
  prNumber: number
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

export async function precheckPRMergeability(
  prNumber: number
): Promise<PRMergeabilityPrecheck> {
  try {
    const snapshot = await getPRMergeabilitySnapshot(prNumber);

    if (isMergeConflictState(snapshot)) {
      return {
        shouldSkipLLM: true,
        llmFallback: createLLMFailureResult("LLM skipped: pr_merge_conflict_detected", [
          "Resolve merge conflicts with base branch before running LLM review.",
        ]),
      };
    }

    if (snapshot.mergeableState === "behind") {
      const sync = await tryUpdatePRBranch(prNumber);
      return {
        shouldSkipLLM: true,
        llmFallback: createLLMFailureResult(
          `LLM skipped: pr_base_behind (${sync.reason})`,
          ["Wait for branch sync and retry judge review."]
        ),
      };
    }

    return { shouldSkipLLM: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      shouldSkipLLM: true,
      llmFallback: createLLMFailureResult(`LLM skipped: mergeability_precheck_failed (${message})`, [
        "Retry judge review after precheck error cooldown.",
      ]),
    };
  }
}
