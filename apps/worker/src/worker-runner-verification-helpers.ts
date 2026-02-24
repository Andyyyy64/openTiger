import {
  extractPolicyViolationPaths,
  type Policy,
  type Task,
} from "@openTiger/core";
import { discardChangesForPaths, getUntrackedFiles, checkGitIgnored } from "@openTiger/vcs";
import { executeTask, verifyChanges, type VerifyResult } from "./steps/index";
import {
  isLikelyGeneratedArtifactPath,
  normalizePathForMatch,
  persistGeneratedPathHints,
} from "./steps/verify/paths";
import { shouldAllowNoChanges } from "./worker-task-helpers";
import {
  restoreExpectedBranchContext,
} from "./worker-runner-utils";
import type { LlmInlineRecoveryHandler } from "./steps/verify/types";

export function shouldEnableNoChangeVerificationFallback(): boolean {
  const mode = (process.env.WORKER_NO_CHANGE_CONFIRM_MODE ?? "verify").trim().toLowerCase();
  if (!mode) {
    return true;
  }
  return !["off", "false", "strict", "disabled", "none"].includes(mode);
}

export function hasMeaningfulVerificationPass(verifyResult: VerifyResult): boolean {
  return verifyResult.commandResults.some((result) => result.outcome === "passed");
}

export type VisualProbeSummary = {
  id: string;
  status: "passed" | "failed" | "skipped";
  message: string;
  metrics?: {
    centerPixel: [number, number, number, number];
    clearRatio: number;
    nearBlackRatio: number;
    luminanceStdDev: number;
  };
};

export function summarizeVisualProbeResults(verifyResult: VerifyResult): VisualProbeSummary[] {
  return (verifyResult.visualProbeResults ?? []).map((probe) => ({
    id: probe.id,
    status: probe.status,
    message: probe.message,
    metrics: probe.metrics
      ? {
          centerPixel: probe.metrics.centerPixel,
          clearRatio: probe.metrics.clearRatio,
          nearBlackRatio: probe.metrics.nearBlackRatio,
          luminanceStdDev: probe.metrics.luminanceStdDev,
        }
      : undefined,
  }));
}

const DOCSER_SAFE_VERIFY_COMMAND = /^\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?check(?:\s+.*)?$/i;

export function resolveVerificationCommands(taskData: Task): string[] {
  const commands = taskData.commands ?? [];
  if (taskData.role !== "docser") {
    return commands;
  }
  const safeCommands = commands.filter((command) =>
    DOCSER_SAFE_VERIFY_COMMAND.test(command.trim()),
  );
  if (safeCommands.length !== commands.length) {
    console.warn(
      `[Worker] Skipping non-docser-safe verification commands: ${commands.join(", ") || "(none)"}`,
    );
  }
  return safeCommands;
}

export function selectGeneratedArtifactRecoveryCandidates(params: {
  violatingPaths: string[];
  untrackedFiles: string[];
  /** Paths that match .gitignore rules — definitionally generated artifacts */
  gitIgnoredFiles?: Set<string>;
}): {
  discardPaths: string[];
  generatedPaths: string[];
  untrackedOutsidePaths: string[];
  gitIgnoredPaths: string[];
} {
  const normalizedViolating = Array.from(
    new Set(
      params.violatingPaths
        .map((path) => normalizePathForMatch(path))
        .filter((path) => path.length > 0),
    ),
  );
  const untrackedSet = new Set(
    params.untrackedFiles
      .map((path) => normalizePathForMatch(path))
      .filter((path) => path.length > 0),
  );
  const gitIgnoredSet = new Set(
    [...(params.gitIgnoredFiles ?? [])]
      .map((path) => normalizePathForMatch(path))
      .filter((path) => path.length > 0),
  );

  const discardPaths: string[] = [];
  const generatedPaths: string[] = [];
  const untrackedOutsidePaths: string[] = [];
  const gitIgnoredPaths: string[] = [];

  for (const path of normalizedViolating) {
    const generatedPath = isLikelyGeneratedArtifactPath(path);
    const untrackedPath = untrackedSet.has(path);
    const gitIgnoredPath = gitIgnoredSet.has(path);
    if (!generatedPath && !untrackedPath && !gitIgnoredPath) {
      continue;
    }
    discardPaths.push(path);
    if (generatedPath) {
      generatedPaths.push(path);
    } else if (gitIgnoredPath) {
      gitIgnoredPaths.push(path);
    } else if (untrackedPath) {
      untrackedOutsidePaths.push(path);
    }
  }

  return {
    discardPaths,
    generatedPaths,
    untrackedOutsidePaths,
    gitIgnoredPaths,
  };
}

export async function attemptGeneratedArtifactRecovery(params: {
  repoPath: string;
  verifyResult: VerifyResult;
  verificationCommands: string[];
  allowedPaths: string[];
  policy: Policy;
  baseBranch: string;
  headBranch: string;
  repoMode: "git" | "local";
  allowNoChanges: boolean;
}): Promise<VerifyResult | null> {
  const violatingPaths = extractPolicyViolationPaths(params.verifyResult.policyViolations);
  if (violatingPaths.length === 0) {
    return null;
  }

  const normalizedViolating = violatingPaths.map(normalizePathForMatch).filter((p) => p.length > 0);
  const [untrackedFiles, gitIgnoredFiles] = await Promise.all([
    getUntrackedFiles(params.repoPath),
    checkGitIgnored(params.repoPath, normalizedViolating),
  ]);
  const recoveryCandidates = selectGeneratedArtifactRecoveryCandidates({
    violatingPaths,
    untrackedFiles,
    gitIgnoredFiles,
  });
  if (recoveryCandidates.discardPaths.length === 0) {
    return null;
  }
  if (recoveryCandidates.untrackedOutsidePaths.length > 0) {
    console.log(
      `[Worker] Auto-discarding untracked outside-allowed paths: ${recoveryCandidates.untrackedOutsidePaths.join(", ")}`,
    );
  }
  if (recoveryCandidates.gitIgnoredPaths.length > 0) {
    console.log(
      `[Worker] Auto-discarding gitignored outside-allowed paths: ${recoveryCandidates.gitIgnoredPaths.join(", ")}`,
    );
  }

  const cleanupResult = await discardChangesForPaths(
    params.repoPath,
    recoveryCandidates.discardPaths,
  );
  if (!cleanupResult.success) {
    console.warn(
      `[Worker] Failed to discard generated artifact candidates: ${cleanupResult.stderr || "(no stderr)"}`,
    );
    return null;
  }
  const learnedPaths = await persistGeneratedPathHints(
    params.repoPath,
    recoveryCandidates.discardPaths,
  );
  if (learnedPaths.length > 0) {
    console.log(`[Worker] Learned generated artifact path hints: ${learnedPaths.join(", ")}`);
  }

  return verifyChanges({
    repoPath: params.repoPath,
    commands: params.verificationCommands,
    allowedPaths: params.allowedPaths,
    policy: params.policy,
    baseBranch: params.baseBranch,
    headBranch: params.headBranch,
    allowLockfileOutsidePaths: true,
    allowEnvExampleOutsidePaths: params.repoMode === "local",
    allowNoChanges: params.allowNoChanges,
  });
}

export function buildLlmInlineRecoveryHandler(params: {
  repoPath: string;
  taskData: Task;
  instructionsPath?: string;
  model?: string;
  effectivePolicy: Policy;
  branchName: string;
  runtimeExecutorDisplayName: string;
  retryHints: string[];
}): LlmInlineRecoveryHandler {
  return async (recoveryParams) => {
    const hint =
      `Inline verification recovery (${recoveryParams.attempt}/${recoveryParams.maxAttempts}): ` +
      `verification command \`${recoveryParams.failedCommand}\` failed. ` +
      `stderr: ${recoveryParams.stderr.slice(0, 400)}. ` +
      "Apply the smallest possible targeted fix to make this specific command pass. " +
      "Do NOT restructure the code or undo prior work.";
    const recoveryHints = [
      hint,
      ...(recoveryParams.previousExecuteFailureHint
        ? [recoveryParams.previousExecuteFailureHint]
        : []),
      ...params.retryHints,
    ];
    const result = await executeTask({
      repoPath: params.repoPath,
      task: params.taskData,
      instructionsPath: params.instructionsPath,
      model: params.model,
      retryHints: recoveryHints,
      policy: params.effectivePolicy,
      verificationRecovery: {
        attempt: recoveryParams.attempt,
        failedCommand: recoveryParams.failedCommand,
        failedCommandSource: recoveryParams.source,
        failedCommandStderr: recoveryParams.stderr.slice(0, 400),
      },
    });
    await restoreExpectedBranchContext(
      params.repoPath,
      params.branchName,
      params.runtimeExecutorDisplayName,
    );
    return {
      success: result.success,
      executeStderr: result.success ? undefined : result.openCodeResult.stderr,
      executeError: result.success ? undefined : result.error,
    };
  };
}
