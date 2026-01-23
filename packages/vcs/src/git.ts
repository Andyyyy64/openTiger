import { spawn } from "node:child_process";

// Git操作の結果
export interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Gitコマンドを実行
async function execGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const process = spawn("git", args, {
      cwd,
      env: {
        ...globalThis.process.env,
        GIT_TERMINAL_PROMPT: "0", // インタラクティブな入力を無効化
      },
    });

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1,
      });
    });

    process.on("error", (error) => {
      resolve({
        success: false,
        stdout,
        stderr: error.message,
        exitCode: -1,
      });
    });
  });
}

// リポジトリをクローン
export async function cloneRepo(
  repoUrl: string,
  destPath: string,
  branch?: string,
  token?: string
): Promise<GitResult> {
  // 空のリポジトリやブランチ未指定の場合でも動作するように、まずは通常のクローンを試みる
  const args = ["clone", "--depth", "1"];

  let authenticatedUrl = repoUrl;
  if (token && repoUrl.startsWith("https://github.com/")) {
    authenticatedUrl = repoUrl.replace(
      "https://github.com/",
      `https://x-access-token:${token}@github.com/`
    );
  }

  // ブランチ指定がある場合でも、まずはクローンを優先するためにここでは指定しない
  // または、エラー時にフォールバックするロジックにする
  const cloneArgs = [...args, authenticatedUrl, destPath];
  const result = await execGit(cloneArgs, ".");

  // 特定のブランチを指定してクローンしようとして失敗した場合、ブランチ指定なしで再試行
  if (!result.success && branch) {
    console.warn(`Failed to clone branch ${branch}, retrying without branch specification...`);
    return execGit([...args, authenticatedUrl, destPath], ".");
  }

  return result;
}

// 最新を取得
export async function fetchLatest(cwd: string): Promise<GitResult> {
  return execGit(["fetch", "origin"], cwd);
}

// ブランチを作成してチェックアウト
export async function createBranch(
  cwd: string,
  branchName: string,
  baseBranch = "main"
): Promise<GitResult> {
  // まずベースブランチに切り替えを試みる
  const checkoutResult = await execGit(["checkout", baseBranch], cwd);
  
  if (checkoutResult.success) {
    // ベースブランチが存在する場合、最新を取得
    await execGit(["pull", "origin", baseBranch], cwd);
  } else {
    // ベースブランチが存在しない（空のリポジトリなど）場合、
    // 現在のブランチ（通常は空のHEAD）から新しいブランチを作成する
    console.warn(`Base branch ${baseBranch} not found, creating ${branchName} from current HEAD`);
  }

  // 新しいブランチを作成
  return execGit(["checkout", "-b", branchName], cwd);
}

// 現在のブランチ名を取得
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  // 通常のリポジトリ用
  const result = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (result.success) {
    return result.stdout;
  }

  // 空のリポジトリ（コミットがない状態）用
  const symbolicResult = await execGit(
    ["symbolic-ref", "--short", "HEAD"],
    cwd
  );
  return symbolicResult.success ? symbolicResult.stdout : null;
}

// 変更をステージング
export async function stageChanges(
  cwd: string,
  paths: string[] = ["."]
): Promise<GitResult> {
  return execGit(["add", ...paths], cwd);
}

// コミット
export async function commit(
  cwd: string,
  message: string
): Promise<GitResult> {
  return execGit(["commit", "-m", message], cwd);
}

// プッシュ
export async function push(
  cwd: string,
  branch: string,
  force = false
): Promise<GitResult> {
  const args = ["push", "origin", branch];
  if (force) {
    args.push("--force");
  }
  return execGit(args, cwd);
}

// 差分を取得
export async function getDiff(
  cwd: string,
  staged = false
): Promise<GitResult> {
  const args = ["diff"];
  if (staged) {
    args.push("--staged");
  }
  return execGit(args, cwd);
}

// 変更されたファイル一覧を取得
export async function getChangedFiles(cwd: string): Promise<string[]> {
  const result = await execGit(["status", "--porcelain"], cwd);
  if (!result.success) {
    return [];
  }

  return result.stdout
    .split("\n")
    .filter((line) => line.length > 2)
    .map((line) => {
      // Porcelain形式は先頭2文字がステータス、その後ろにパスが続く
      // 2文字目以降をすべて取得してトリムすることで、スペースの数に関わらずパスを抽出
      const path = line.slice(2).trim();
      // 引用符で囲まれている場合は除去
      return path.replace(/^"|"$/g, "");
    });
}

// 変更行数を取得
export async function getChangeStats(
  cwd: string
): Promise<{ additions: number; deletions: number }> {
  const result = await execGit(["diff", "--stat", "--staged"], cwd);
  if (!result.success) {
    return { additions: 0, deletions: 0 };
  }

  // 最後の行から統計を抽出
  const lines = result.stdout.split("\n");
  const lastLine = lines.at(-1) ?? "";

  const addMatch = lastLine.match(/(\d+) insertion/);
  const delMatch = lastLine.match(/(\d+) deletion/);

  return {
    additions: addMatch?.[1] ? parseInt(addMatch[1], 10) : 0,
    deletions: delMatch?.[1] ? parseInt(delMatch[1], 10) : 0,
  };
}

// ブランチを削除
export async function deleteBranch(
  cwd: string,
  branchName: string,
  force = false
): Promise<GitResult> {
  const args = ["branch", force ? "-D" : "-d", branchName];
  return execGit(args, cwd);
}

// リモートブランチを削除
export async function deleteRemoteBranch(
  cwd: string,
  branchName: string
): Promise<GitResult> {
  return execGit(["push", "origin", "--delete", branchName], cwd);
}

// リモートブランチが存在するかチェック
export async function remoteBranchExists(
  cwd: string,
  branchName: string
): Promise<boolean> {
  const result = await execGit(
    ["ls-remote", "--heads", "origin", branchName],
    cwd
  );
  return result.success && result.stdout.includes(`refs/heads/${branchName}`);
}

// 変更を破棄してクリーンな状態に
export async function resetHard(
  cwd: string,
  ref = "HEAD"
): Promise<GitResult> {
  return execGit(["reset", "--hard", ref], cwd);
}

// 未追跡ファイルを削除
export async function cleanUntracked(cwd: string): Promise<GitResult> {
  return execGit(["clean", "-fd"], cwd);
}
