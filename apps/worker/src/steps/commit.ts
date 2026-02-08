import { stageChanges, commit, push } from "@openTiger/vcs";
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
  commitMessage: string;
  error?: string;
}

function isNonFastForwardPush(stderr: string, stdout: string): boolean {
  const message = `${stderr}\n${stdout}`.toLowerCase();
  return message.includes("fetch first")
    || message.includes("non-fast-forward")
    || message.includes("failed to push some refs");
}

// コミットメッセージを生成
function generateCommitMessage(task: Task, changedFiles: string[]): string {
  const lines: string[] = [
    `[openTiger] ${task.title}`,
    "",
    `Task ID: ${task.id}`,
    "",
    "Changes:",
  ];

  // 変更ファイルを追加（最大10ファイル）
  const filesToShow = changedFiles.slice(0, 10);
  for (const file of filesToShow) {
    lines.push(`- ${file}`);
  }

  if (changedFiles.length > 10) {
    lines.push(`- ... and ${changedFiles.length - 10} more files`);
  }

  return lines.join("\n");
}

// 変更をコミットしてプッシュ
export async function commitAndPush(
  options: CommitOptions
): Promise<CommitResult> {
  const { repoPath, branchName, task, changedFiles } = options;
  const repoMode = getRepoMode();

  console.log("Staging changes...");

  // 変更をステージング
  const stageResult = await stageChanges(repoPath, changedFiles);
  if (!stageResult.success) {
    return {
      success: false,
      commitMessage: "",
      error: `Failed to stage changes: ${stageResult.stderr}`,
    };
  }

  // コミットメッセージを生成
  const commitMessage = generateCommitMessage(task, changedFiles);

  console.log("Committing...");

  // コミット
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

    // 既にコミット済みの差分がある場合はそのまま進める
    if (!isNoChanges) {
      return {
        success: false,
        commitMessage,
        error: `Failed to commit: ${combinedRaw || "git commit returned non-zero exit code"}`,
      };
    }
    console.log("No new changes to commit, skipping commit step");
  }

  console.log("Pushing to remote...");

  if (repoMode === "git") {
    // プッシュ
    let pushResult = await push(repoPath, branchName);
    if (!pushResult.success) {
      if (branchName.startsWith("agent/")
        && isNonFastForwardPush(pushResult.stderr, pushResult.stdout)) {
        console.warn(
          `Push rejected for ${branchName} due to non-fast-forward. Retrying with force push...`
        );
        const forcePushResult = await push(repoPath, branchName, true);
        if (forcePushResult.success) {
          pushResult = forcePushResult;
        } else {
          return {
            success: false,
            commitMessage,
            error: `Failed to push after force retry: ${forcePushResult.stderr}`,
          };
        }
      } else {
        return {
          success: false,
          commitMessage,
          error: `Failed to push: ${pushResult.stderr}`,
        };
      }
    }
    if (!pushResult.success) {
      return {
        success: false,
        commitMessage,
        error: `Failed to push: ${pushResult.stderr}`,
      };
    }
  } else {
    console.log("Local mode: skipping push");
  }

  console.log("Changes committed successfully");

  return {
    success: true,
    commitMessage,
  };
}
