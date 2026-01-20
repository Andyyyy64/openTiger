import { stageChanges, commit, push } from "@h1ve/vcs";
import type { Task } from "@h1ve/core";

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

// コミットメッセージを生成
function generateCommitMessage(task: Task, changedFiles: string[]): string {
  const lines: string[] = [
    `[h1ve] ${task.title}`,
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
    return {
      success: false,
      commitMessage,
      error: `Failed to commit: ${commitResult.stderr}`,
    };
  }

  console.log("Pushing to remote...");

  // プッシュ
  const pushResult = await push(repoPath, branchName);
  if (!pushResult.success) {
    return {
      success: false,
      commitMessage,
      error: `Failed to push: ${pushResult.stderr}`,
    };
  }

  console.log("Changes committed and pushed successfully");

  return {
    success: true,
    commitMessage,
  };
}
