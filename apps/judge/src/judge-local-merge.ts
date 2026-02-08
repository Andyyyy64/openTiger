import { db } from "@openTiger/db";
import { artifacts, events } from "@openTiger/db/schema";
import {
  checkoutBranch,
  mergeBranch,
  getChangedFiles,
  resetHard,
  getWorkingTreeDiff,
  getUntrackedFiles,
  stashChanges,
  getLatestStashRef,
  applyStash,
  dropStash,
  stageAll,
  commitChanges,
  isMergeInProgress,
  abortMerge,
  cleanUntracked,
} from "@openTiger/vcs";
import { evaluateLLMDiff } from "./evaluators/index";
import type { BaseRepoRecoveryRules } from "./judge-config";

export async function recoverDirtyBaseRepo(options: {
  baseRepoPath: string;
  baseBranch: string;
  runId: string;
  taskId: string;
  agentId: string;
  workdir: string;
  instructionsPath: string;
  useLlm: boolean;
  recoveryMode: "none" | "stash" | "llm";
  recoveryRules: BaseRepoRecoveryRules;
}): Promise<{ success: boolean; error?: string }> {
  if (options.recoveryMode === "none") {
    return { success: false, error: "base repo has uncommitted changes" };
  }

  const diffResult = await getWorkingTreeDiff(options.baseRepoPath);
  const fullDiff = diffResult.success ? diffResult.stdout : "";
  const untrackedFiles = await getUntrackedFiles(options.baseRepoPath);
  const dirtyFiles = await getChangedFiles(options.baseRepoPath);

  const diffTruncated = fullDiff.length > options.recoveryRules.diffLimit;
  const diffForRecord = diffTruncated
    ? `${fullDiff.slice(0, options.recoveryRules.diffLimit)}\n... (truncated)`
    : fullDiff;

  // Stash base changes to prevent merge process from stopping
  const stashMessage = `openTiger base repo auto stash ${new Date().toISOString()}`;
  const stashResult = await stashChanges(options.baseRepoPath, stashMessage);
  if (!stashResult.success) {
    return {
      success: false,
      error: `failed to stash changes: ${stashResult.stderr}`,
    };
  }

  const stashRef = await getLatestStashRef(options.baseRepoPath);

  try {
    await db.insert(artifacts).values({
      runId: options.runId,
      type: "base_repo_diff",
      ref: stashRef ?? null,
      metadata: {
        baseRepoPath: options.baseRepoPath,
        baseBranch: options.baseBranch,
        dirtyFiles,
        untrackedFiles,
        diff: diffForRecord,
        diffTruncated,
      },
    });
  } catch (error) {
    console.warn("[Judge] Failed to save base repo diff artifact:", error);
  }

  await db.insert(events).values({
    type: "judge.base_repo_stashed",
    entityType: "run",
    entityId: options.runId,
    agentId: options.agentId,
    payload: {
      taskId: options.taskId,
      baseRepoPath: options.baseRepoPath,
      baseBranch: options.baseBranch,
      stashRef,
      dirtyFiles,
      untrackedFiles,
      diffTruncated,
      recoveryLevel: options.recoveryRules.level,
    },
  });

  if (!options.useLlm || options.recoveryMode !== "llm") {
    return { success: true };
  }

  // stash した内容をLLMで判定して復帰の可否を決める
  const llmResult = await evaluateLLMDiff(
    fullDiff,
    "ローカルベースリポジトリの未コミット変更です。システム専用リポジトリに残すべきか判断してください。",
    {
      instructionsPath: options.instructionsPath,
      timeoutSeconds: 300,
    }
  );

  await db.insert(events).values({
    type: "judge.base_repo_recovery_decision",
    entityType: "run",
    entityId: options.runId,
    agentId: options.agentId,
    payload: {
      taskId: options.taskId,
      stashRef,
      pass: llmResult.pass,
      confidence: llmResult.confidence,
      reasons: llmResult.reasons,
      suggestions: llmResult.suggestions,
      recoveryLevel: options.recoveryRules.level,
    },
  });

  const hasError = llmResult.codeIssues.some((issue) => issue.severity === "error");
  const hasWarning = llmResult.codeIssues.some((issue) => issue.severity === "warning");
  const meetsConfidence = llmResult.confidence >= options.recoveryRules.minConfidence;
  const meetsErrors = !options.recoveryRules.requireNoErrors || !hasError;
  const meetsWarnings = !options.recoveryRules.requireNoWarnings || !hasWarning;
  const shouldRestore =
    llmResult.pass && meetsConfidence && meetsErrors && meetsWarnings;
  if (!shouldRestore || !stashRef) {
    return { success: true };
  }

  const applyResult = await applyStash(options.baseRepoPath, stashRef);
  if (!applyResult.success) {
    console.warn("[Judge] Failed to apply stash:", applyResult.stderr);
    await checkoutBranch(options.baseRepoPath, options.baseBranch);
    await resetHard(options.baseRepoPath, options.baseBranch);
    await cleanUntracked(options.baseRepoPath);
    return { success: true };
  }

  // Only commit if recovery is deemed valid to keep base clean
  const stageResult = await stageAll(options.baseRepoPath);
  if (!stageResult.success) {
    await checkoutBranch(options.baseRepoPath, options.baseBranch);
    await resetHard(options.baseRepoPath, options.baseBranch);
    await cleanUntracked(options.baseRepoPath);
    return {
      success: true,
      error: `failed to stage recovered changes: ${stageResult.stderr}`,
    };
  }

  const commitResult = await commitChanges(
    options.baseRepoPath,
    "chore: recover base repo changes"
  );
  if (!commitResult.success) {
    const combinedMessage = `${commitResult.stdout}\n${commitResult.stderr}`;
    if (!combinedMessage.includes("nothing to commit")) {
      await checkoutBranch(options.baseRepoPath, options.baseBranch);
      await resetHard(options.baseRepoPath, options.baseBranch);
      await cleanUntracked(options.baseRepoPath);
      return {
        success: true,
        error: `failed to commit recovered changes: ${commitResult.stderr}`,
      };
    }
  }

  const dropResult = await dropStash(options.baseRepoPath, stashRef);
  if (!dropResult.success) {
    console.warn("[Judge] Failed to drop stash:", dropResult.stderr);
  }

  return { success: true };
}

export async function mergeLocalBranch(target: {
  baseRepoPath?: string;
  baseBranch: string;
  branchName: string;
  runId: string;
  taskId: string;
  agentId: string;
  workdir: string;
  instructionsPath: string;
  useLlm: boolean;
  recoveryMode: "none" | "stash" | "llm";
  recoveryRules: BaseRepoRecoveryRules;
}): Promise<{ success: boolean; error?: string }> {
  if (!target.baseRepoPath) {
    return { success: false, error: "baseRepoPath is missing" };
  }

  const dirtyFiles = await getChangedFiles(target.baseRepoPath);
  if (dirtyFiles.length > 0) {
    const mergeInProgress = await isMergeInProgress(target.baseRepoPath);
    if (mergeInProgress) {
      const abortResult = await abortMerge(target.baseRepoPath);
      if (!abortResult.success) {
        return {
          success: false,
          error: `failed to abort merge: ${abortResult.stderr}`,
        };
      }
    }

    const recoverResult = await recoverDirtyBaseRepo({
      baseRepoPath: target.baseRepoPath,
      baseBranch: target.baseBranch,
      runId: target.runId,
      taskId: target.taskId,
      agentId: target.agentId,
      workdir: target.workdir,
      instructionsPath: target.instructionsPath,
      useLlm: target.useLlm,
      recoveryMode: target.recoveryMode,
      recoveryRules: target.recoveryRules,
    });
    if (!recoverResult.success) {
      return {
        success: false,
        error: recoverResult.error ?? "base repo has uncommitted changes",
      };
    }

    const afterRecover = await getChangedFiles(target.baseRepoPath);
    if (afterRecover.length > 0) {
      // Clean untracked files from local working base before re-evaluating
      const cleanResult = await cleanUntracked(target.baseRepoPath);
      if (!cleanResult.success) {
        return {
          success: false,
          error: `failed to clean untracked files: ${cleanResult.stderr}`,
        };
      }
      const afterClean = await getChangedFiles(target.baseRepoPath);
      if (afterClean.length > 0) {
        return {
          success: false,
          error: "base repo has uncommitted changes",
        };
      }
    }
  }

  const checkoutResult = await checkoutBranch(
    target.baseRepoPath,
    target.baseBranch
  );
  if (!checkoutResult.success) {
    return {
      success: false,
      error: `failed to checkout base branch: ${checkoutResult.stderr}`,
    };
  }

  // まずはfast-forwardで安全に取り込み、失敗時はマージコミットを許可する
  const ffResult = await mergeBranch(
    target.baseRepoPath,
    target.branchName,
    { ffOnly: true }
  );
  if (!ffResult.success) {
    const mergeResult = await mergeBranch(
      target.baseRepoPath,
      target.branchName,
      { ffOnly: false, noEdit: true }
    );
    if (!mergeResult.success) {
      const abortResult = await abortMerge(target.baseRepoPath);
      if (!abortResult.success) {
        return {
          success: false,
          error: `failed to abort merge: ${abortResult.stderr}`,
        };
      }
      return {
        success: false,
        error: `failed to merge branch: ${mergeResult.stderr}`,
      };
    }
  }

  return { success: true };
}
