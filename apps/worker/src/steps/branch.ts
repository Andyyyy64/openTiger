import { createBranch, getCurrentBranch } from "@sebastian-code/vcs";

export interface BranchOptions {
  repoPath: string;
  agentId: string;
  taskId: string;
  baseBranch?: string;
}

export interface BranchResult {
  success: boolean;
  branchName: string;
  error?: string;
}

// ブランチ名を生成
export function generateBranchName(agentId: string, taskId: string): string {
  // UUIDの最初の8文字を使用
  const shortTaskId = taskId.slice(0, 8);
  return `agent/${agentId}/${shortTaskId}`;
}

// 作業ブランチを作成
export async function createWorkBranch(
  options: BranchOptions
): Promise<BranchResult> {
  const { repoPath, agentId, taskId, baseBranch = "main" } = options;

  const branchName = generateBranchName(agentId, taskId);

  console.log(`Creating branch: ${branchName}`);

  const result = await createBranch(repoPath, branchName, baseBranch);

  if (!result.success) {
    return {
      success: false,
      branchName,
      error: `Failed to create branch: ${result.stderr}`,
    };
  }

  // 作成されたブランチを確認
  const currentBranch = await getCurrentBranch(repoPath);
  if (currentBranch !== branchName) {
    return {
      success: false,
      branchName,
      error: `Branch mismatch: expected ${branchName}, got ${currentBranch}`,
    };
  }

  console.log(`Branch created and checked out: ${branchName}`);

  return {
    success: true,
    branchName,
  };
}
