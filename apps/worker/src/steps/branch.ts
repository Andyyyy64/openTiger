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

const TRANSIENT_BRANCH_ERROR_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /connection reset/i,
  /econnreset/i,
  /temporarily unavailable/i,
];

function isTransientBranchError(message: string): boolean {
  return TRANSIENT_BRANCH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Generate branch name
export function generateBranchName(agentId: string, taskId: string): string {
  // Use first 8 characters of UUID
  const shortTaskId = taskId.slice(0, 8);
  return `agent/${agentId}/${shortTaskId}`;
}

// Create working branch
export async function createWorkBranch(options: BranchOptions): Promise<BranchResult> {
  const { repoPath, agentId, taskId, baseRef = "main" } = options;

  const branchName = generateBranchName(agentId, taskId);

  console.log(`Creating branch: ${branchName}`);

  let result = await createBranch(repoPath, branchName, baseRef);
  if (!result.success && isTransientBranchError(result.stderr)) {
    await sleep(1200);
    result = await createBranch(repoPath, branchName, baseRef);
  }

  if (!result.success) {
    return {
      success: false,
      branchName,
      error: `Failed to create branch: ${result.stderr}`,
    };
  }

  // Verify branch was created
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

// Switch to existing branch or restore from remote ref
export async function checkoutExistingBranch(
  options: CheckoutBranchOptions,
): Promise<BranchResult> {
  const { repoPath, branchName, baseRef } = options;

  let checkoutResult = await checkoutBranch(repoPath, branchName);
  if (!checkoutResult.success && isTransientBranchError(checkoutResult.stderr)) {
    await sleep(1000);
    checkoutResult = await checkoutBranch(repoPath, branchName);
  }
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
