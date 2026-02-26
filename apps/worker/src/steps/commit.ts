import {
  stageChanges,
  commit,
  push,
  getCurrentBranch,
  fetchRemoteBranch,
  getCommitSha,
  isAncestorRef,
} from "@openTiger/vcs";
import { getRepoMode } from "@openTiger/core";
import type { Task } from "@openTiger/core";

export interface CommitOptions {
  repoPath: string;
  branchName: string;
  task: Task;
  changedFiles: string[];
}

export interface CommitResult {
  success: boolean;
  committed: boolean;
  commitMessage: string;
  error?: string;
}

const FORBIDDEN_COMMIT_PATH_PATTERNS: RegExp[] = [
  /^apps\/judge\/test-repo(?:\/|$)/,
  /^apps\/judge\/repro(?:\/|$)/,
];
const TRANSIENT_STAGE_ERROR_PATTERNS = [
  /index\.lock/i,
  /resource temporarily unavailable/i,
  /timed out/i,
  /timeout/i,
];
const TRANSIENT_PUSH_ERROR_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /connection reset/i,
  /econnreset/i,
  /remote end hung up unexpectedly/i,
  /temporarily unavailable/i,
  /service unavailable/i,
];

function findForbiddenChangedFiles(changedFiles: string[]): string[] {
  return changedFiles.filter((file) =>
    FORBIDDEN_COMMIT_PATH_PATTERNS.some((pattern) => pattern.test(file)),
  );
}

export function isNonFastForwardPush(stderr: string, stdout: string): boolean {
  const message = `${stderr}\n${stdout}`.toLowerCase();
  return (
    message.includes("fetch first") ||
    message.includes("non-fast-forward") ||
    message.includes("failed to push some refs")
  );
}

async function resolveDivergenceGuardError(repoPath: string, branchName: string): Promise<string> {
  const localHead = await getCommitSha(repoPath, "HEAD");
  const remoteHead = await getCommitSha(repoPath, `origin/${branchName}`);

  if (!localHead || !remoteHead) {
    return "branch_diverged_requires_recreate:missing_head_after_fetch";
  }

  const localContainsRemote = await isAncestorRef(repoPath, remoteHead, localHead);
  const remoteContainsLocal = await isAncestorRef(repoPath, localHead, remoteHead);

  if (localContainsRemote === null || remoteContainsLocal === null) {
    return `branch_diverged_requires_recreate:merge_base_check_failed:${localHead}:${remoteHead}`;
  }

  if (!localContainsRemote && !remoteContainsLocal) {
    return `branch_diverged_requires_recreate:both_diverged:${localHead}:${remoteHead}`;
  }

  if (remoteContainsLocal) {
    return `branch_diverged_requires_recreate:local_behind_remote:${localHead}:${remoteHead}`;
  }

  return `branch_diverged_requires_recreate:push_rejected_after_fetch:${localHead}:${remoteHead}`;
}

function isTransientStageFailure(stderr: string): boolean {
  const message = stderr.toLowerCase();
  return TRANSIENT_STAGE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function isTransientPushFailure(stderr: string, stdout: string): boolean {
  const message = `${stderr}\n${stdout}`.toLowerCase();
  return TRANSIENT_PUSH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Generate commit message
function generateCommitMessage(task: Task, changedFiles: string[]): string {
  const lines: string[] = [`[openTiger] ${task.title}`, "", `Task ID: ${task.id}`, "", "Changes:"];

  // Add changed files (max 10)
  const filesToShow = changedFiles.slice(0, 10);
  for (const file of filesToShow) {
    lines.push(`- ${file}`);
  }

  if (changedFiles.length > 10) {
    lines.push(`- ... and ${changedFiles.length - 10} more files`);
  }

  return lines.join("\n");
}

// Commit and push changes
export async function commitAndPush(options: CommitOptions): Promise<CommitResult> {
  const { repoPath, branchName, task, changedFiles } = options;
  const repoMode = getRepoMode();
  const forbiddenFiles = findForbiddenChangedFiles(changedFiles);

  const currentBranch = await getCurrentBranch(repoPath);
  if (currentBranch !== branchName) {
    return {
      success: false,
      committed: false,
      commitMessage: "",
      error: `Branch drift detected before commit: current=${currentBranch ?? "unknown"}, expected=${branchName}`,
    };
  }

  if (forbiddenFiles.length > 0) {
    return {
      success: false,
      committed: false,
      commitMessage: "",
      error: `Refusing to commit forbidden paths: ${forbiddenFiles.join(", ")}`,
    };
  }

  console.log("Staging changes...");

  // Stage changes
  let stageResult = await stageChanges(repoPath, changedFiles);
  if (!stageResult.success && isTransientStageFailure(stageResult.stderr)) {
    console.warn(`[Commit] Stage failed transiently; retrying once: ${stageResult.stderr}`);
    await sleep(1200);
    stageResult = await stageChanges(repoPath, changedFiles);
  }
  if (!stageResult.success) {
    return {
      success: false,
      committed: false,
      commitMessage: "",
      error: `Failed to stage changes: ${stageResult.stderr}`,
    };
  }

  // Generate commit message
  const commitMessage = generateCommitMessage(task, changedFiles);
  let committed = true;

  console.log("Committing...");

  // Commit
  const commitResult = await commit(repoPath, commitMessage);
  if (!commitResult.success) {
    const combinedRaw = `${commitResult.stdout}\n${commitResult.stderr}`.trim();
    const combined = combinedRaw.toLowerCase();
    const noChangesPatterns = [
      "nothing to commit",
      "nothing added to commit",
      "no changes added to commit",
      "working tree clean",
    ];
    const isNoChanges = noChangesPatterns.some((pattern) => combined.includes(pattern));

    // Continue as-is if diff is already committed
    if (!isNoChanges) {
      return {
        success: false,
        committed: false,
        commitMessage,
        error: `Failed to commit: ${combinedRaw || "git commit returned non-zero exit code"}`,
      };
    }
    console.log("No new changes to commit, skipping commit step");
    committed = false;
  }

  console.log("Pushing to remote...");

  if (repoMode === "github") {
    let pushResult: Awaited<ReturnType<typeof push>> | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      pushResult = await push(repoPath, branchName);
      if (pushResult.success) {
        break;
      }
      if (isNonFastForwardPush(pushResult.stderr, pushResult.stdout)) {
        console.warn(
          `Push rejected for ${branchName} due to non-fast-forward. Running divergence guard.`,
        );
        const fetchResult = await fetchRemoteBranch(repoPath, branchName);
        if (!fetchResult.success) {
          return {
            success: false,
            committed,
            commitMessage,
            error: `branch_diverged_requires_recreate:fetch_remote_failed:${fetchResult.stderr || fetchResult.stdout || "unknown"}`,
          };
        }

        const retryAfterFetch = await push(repoPath, branchName);
        if (retryAfterFetch.success) {
          pushResult = retryAfterFetch;
          break;
        }

        pushResult = retryAfterFetch;
        return {
          success: false,
          committed,
          commitMessage,
          error: await resolveDivergenceGuardError(repoPath, branchName),
        };
      }
      if (!isTransientPushFailure(pushResult.stderr, pushResult.stdout) || attempt >= 3) {
        break;
      }
      const delayMs = 1200 * attempt;
      console.warn(
        `[Commit] Push failed transiently (attempt ${attempt}/3); retrying in ${delayMs}ms: ${pushResult.stderr}`,
      );
      await sleep(delayMs);
    }
    if (!pushResult?.success) {
      return {
        success: false,
        committed,
        commitMessage,
        error: `Failed to push: ${pushResult?.stderr ?? "unknown push error"}`,
      };
    }
  } else {
    console.log("Local mode: skipping push");
  }

  console.log("Changes committed successfully");

  return {
    success: true,
    committed,
    commitMessage,
  };
}
