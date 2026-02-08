import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  addWorktree,
  isGitRepo,
  initRepo,
  ensureInitialCommit,
  ensureBranchExists,
  cloneRepo,
  fetchLatest,
  fetchRefspecs,
  resetHard,
  cleanUntracked,
  removeWorktree,
} from "@openTiger/vcs";
import {
  getRepoMode,
  getLocalRepoPath,
  getLocalWorktreeRoot,
  type RepoMode,
} from "@openTiger/core";

export interface CheckoutOptions {
  repoUrl: string;
  workspacePath: string;
  taskId: string;
  baseBranch?: string;
  githubToken?: string;
  repoMode?: RepoMode;
  localRepoPath?: string;
  localWorktreeRoot?: string;
  branchName?: string;
  extraFetchRefs?: string[];
}

export interface CheckoutResult {
  success: boolean;
  repoPath: string;
  baseRepoPath?: string;
  worktreePath?: string;
  branchName?: string;
  error?: string;
}

async function removeDirWithRetry(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

// リポジトリをチェックアウト
export async function checkoutRepository(
  options: CheckoutOptions
): Promise<CheckoutResult> {
  const {
    repoUrl,
    workspacePath,
    taskId,
    baseBranch = "main",
    githubToken,
    repoMode = getRepoMode(),
    localRepoPath = getLocalRepoPath(),
    localWorktreeRoot = getLocalWorktreeRoot(),
    branchName,
    extraFetchRefs = [],
  } = options;

  // Working directory per task
  const repoPath = join(workspacePath, taskId);

  try {
    if (repoMode === "local") {
      if (!localRepoPath) {
        return {
          success: false,
          repoPath,
          error: "LOCAL_REPO_PATH is required for local mode",
        };
      }
      const repoIsGit = await isGitRepo(localRepoPath);
      if (!repoIsGit) {
        // Initialize Git so work can be done even in initial local directory state
        const initResult = await initRepo(localRepoPath, baseBranch);
        if (!initResult.success) {
          return {
            success: false,
            repoPath,
            error: `Git init failed: ${initResult.stderr}`,
          };
        }
      }
      // worktreeを作るために最低1コミットを用意しておく
      const commitResult = await ensureInitialCommit(localRepoPath);
      if (!commitResult.success) {
        return {
          success: false,
          repoPath,
          error: `Initial commit failed: ${commitResult.stderr}`,
        };
      }
      const branchResult = await ensureBranchExists(localRepoPath, baseBranch);
      if (!branchResult.success) {
        return {
          success: false,
          repoPath,
          error: `Base branch setup failed: ${branchResult.stderr}`,
        };
      }

      const worktreePath = join(localWorktreeRoot, taskId);
      if (existsSync(worktreePath)) {
        await removeWorktree({
          baseRepoPath: localRepoPath,
          worktreePath,
        });
        await removeDirWithRetry(worktreePath);
      }

      await mkdir(join(localWorktreeRoot), { recursive: true });

      const addResult = await addWorktree({
        baseRepoPath: localRepoPath,
        worktreePath,
        baseBranch,
        branchName,
      });

      if (!addResult.success) {
        return {
          success: false,
          repoPath: worktreePath,
          error: `Worktree add failed: ${addResult.stderr}`,
        };
      }

      // Inherit local repository's .env to worktree
      const sourceEnvPath = join(localRepoPath, ".env");
      const targetEnvPath = join(worktreePath, ".env");
      if (existsSync(sourceEnvPath)) {
        await copyFile(sourceEnvPath, targetEnvPath);
      }

      return {
        success: true,
        repoPath: worktreePath,
        baseRepoPath: localRepoPath,
        worktreePath,
        branchName,
      };
    }

    // Clean up if existing directory exists
    if (existsSync(repoPath)) {
      console.log(`Cleaning existing directory: ${repoPath}`);
      await removeDirWithRetry(repoPath);
    }

    // 作業ディレクトリを作成
    await mkdir(workspacePath, { recursive: true });

    console.log(`Cloning repository to: ${repoPath}`);
    if (githubToken) {
      console.log("Using GitHub token for authentication");
    } else {
      console.warn("No GitHub token provided for clone");
    }
    const cloneResult = await cloneRepo(
      repoUrl,
      repoPath,
      baseBranch,
      githubToken
    );

    if (!cloneResult.success) {
      return {
        success: false,
        repoPath,
        error: `Clone failed: ${cloneResult.stderr}`,
      };
    }

    console.log("Repository cloned successfully");

    if (extraFetchRefs.length > 0) {
      console.log(`[Checkout] Fetching additional refs: ${extraFetchRefs.join(", ")}`);
      const fetchRefsResult = await fetchRefspecs(repoPath, extraFetchRefs);
      if (!fetchRefsResult.success) {
        return {
          success: false,
          repoPath,
          error: `Failed to fetch required refs: ${fetchRefsResult.stderr}`,
        };
      }
    }

    return {
      success: true,
      repoPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      repoPath,
      error: message,
    };
  }
}

// 既存のリポジトリをリフレッシュ
export async function refreshRepository(repoPath: string): Promise<boolean> {
  // 変更を破棄
  const resetResult = await resetHard(repoPath);
  if (!resetResult.success) {
    console.error("Reset failed:", resetResult.stderr);
    return false;
  }

  // 未追跡ファイルを削除
  const cleanResult = await cleanUntracked(repoPath);
  if (!cleanResult.success) {
    console.error("Clean failed:", cleanResult.stderr);
    return false;
  }

  // 最新を取得
  const fetchResult = await fetchLatest(repoPath);
  if (!fetchResult.success) {
    console.error("Fetch failed:", fetchResult.stderr);
    return false;
  }

  return true;
}
