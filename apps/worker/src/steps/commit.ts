import { stageChanges, commit, push, getCurrentBranch } from "@openTiger/vcs";
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

function isNonFastForwardPush(stderr: string, stdout: string): boolean {
  const message = `${stderr}\n${stdout}`.toLowerCase();
  return (
    message.includes("fetch first") ||
    message.includes("non-fast-forward") ||
    message.includes("failed to push some refs")
  );
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

  if (repoMode === "git") {
    let pushResult: Awaited<ReturnType<typeof push>> | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      pushResult = await push(repoPath, branchName);
      if (pushResult.success) {
        break;
      }
      if (
        branchName.startsWith("agent/") &&
        isNonFastForwardPush(pushResult.stderr, pushResult.stdout)
      ) {
        console.warn(
          `Push rejected for ${branchName} due to non-fast-forward. Retrying with force push...`,
        );
        const forcePushResult = await push(repoPath, branchName, true);
        if (forcePushResult.success) {
          pushResult = forcePushResult;
          break;
        }
        pushResult = forcePushResult;
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
      if (branchName.startsWith("agent/") && pushResult) {
        const nonFastForward = isNonFastForwardPush(pushResult.stderr, pushResult.stdout);
        if (nonFastForward) {
          return {
            success: false,
            committed: false,
            commitMessage,
            error: `Failed to push after force retry: ${pushResult.stderr}`,
          };
        }
      }
      return {
        success: false,
        committed: false,
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
