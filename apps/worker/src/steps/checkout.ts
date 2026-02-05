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
  resetHard,
  cleanUntracked,
  removeWorktree,
} from "@sebastian-code/vcs";
import {
  getRepoMode,
  getLocalRepoPath,
  getLocalWorktreeRoot,
  type RepoMode,
} from "@sebastian-code/core";

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
}

export interface CheckoutResult {
  success: boolean;
  repoPath: string;
  baseRepoPath?: string;
  worktreePath?: string;
  branchName?: string;
  error?: string;
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
  } = options;

  // タスクごとの作業ディレクトリ
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
        // 初期状態のローカルディレクトリでも作業できるようにGitを初期化する
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
        await rm(worktreePath, { recursive: true, force: true });
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

      // ローカルリポジトリの.envをworktreeに引き継ぐ
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

    // 既存のディレクトリがある場合はクリーンアップ
    if (existsSync(repoPath)) {
      console.log(`Cleaning existing directory: ${repoPath}`);
      await rm(repoPath, { recursive: true, force: true });
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
