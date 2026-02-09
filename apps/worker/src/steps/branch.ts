import { checkoutBranch, createBranch, getCurrentBranch } from "@openTiger/vcs";

export interface BranchOptions {
  repoPath: string;
  agentId: string;
  taskId: string;
  baseRef?: string;
}

export interface BranchResult {
  success: boolean;
  branchName: string;
  error?: string;
}

// ブランチ名を生成
export function generateBranchName(agentId: string, taskId: string): string {
  // Use first 8 characters of UUID
  const shortTaskId = taskId.slice(0, 8);
  return `agent/${agentId}/${shortTaskId}`;
}

// 作業ブランチを作成
export async function createWorkBranch(options: BranchOptions): Promise<BranchResult> {
  const { repoPath, agentId, taskId, baseRef = "main" } = options;

  const branchName = generateBranchName(agentId, taskId);

  console.log(`Creating branch: ${branchName}`);

  const result = await createBranch(repoPath, branchName, baseRef);

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

export interface CheckoutBranchOptions {
  repoPath: string;
  branchName: string;
  baseRef?: string;
}

// 既存ブランチがあれば切り替え、なければリモート参照から復元する
export async function checkoutExistingBranch(
  options: CheckoutBranchOptions,
): Promise<BranchResult> {
  const { repoPath, branchName, baseRef } = options;

  const checkoutResult = await checkoutBranch(repoPath, branchName);
  if (!checkoutResult.success) {
    if (!baseRef) {
      return {
        success: false,
        branchName,
        error: `Failed to checkout branch: ${checkoutResult.stderr}`,
      };
    }
    const createResult = await createBranch(repoPath, branchName, baseRef);
    if (!createResult.success) {
      return {
        success: false,
        branchName,
        error: `Failed to create branch: ${createResult.stderr}`,
      };
    }
  }

  const currentBranch = await getCurrentBranch(repoPath);
  if (currentBranch !== branchName) {
    return {
      success: false,
      branchName,
      error: `Branch mismatch: expected ${branchName}, got ${currentBranch}`,
    };
  }

  console.log(`Branch checked out: ${branchName}`);

  return {
    success: true,
    branchName,
  };
}
