import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  cloneRepo,
  fetchLatest,
  resetHard,
  cleanUntracked,
} from "@h1ve/vcs";

export interface CheckoutOptions {
  repoUrl: string;
  workspacePath: string;
  taskId: string;
  baseBranch?: string;
  githubToken?: string;
}

export interface CheckoutResult {
  success: boolean;
  repoPath: string;
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
  } = options;

  // タスクごとの作業ディレクトリ
  const repoPath = join(workspacePath, taskId);

  try {
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
