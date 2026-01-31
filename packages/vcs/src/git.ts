import { spawn } from "node:child_process";

// Git操作の結果
export interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  changedFiles: number;
  files: Array<{
    filename: string;
    additions: number;
    deletions: number;
    status: string;
  }>;
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

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await execGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.success && result.stdout === "true";
}

export async function addWorktree(options: {
  baseRepoPath: string;
  worktreePath: string;
  baseBranch?: string;
  branchName?: string;
}): Promise<GitResult> {
  const { baseRepoPath, worktreePath, baseBranch = "main", branchName } = options;
  const args = ["worktree", "add"];
  if (branchName) {
    args.push("-B", branchName);
  }
  args.push(worktreePath, baseBranch);
  return execGit(args, baseRepoPath);
}

export async function removeWorktree(options: {
  baseRepoPath: string;
  worktreePath: string;
}): Promise<GitResult> {
  const { baseRepoPath, worktreePath } = options;
  return execGit(["worktree", "remove", "--force", worktreePath], baseRepoPath);
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

export async function checkoutBranch(
  cwd: string,
  branchName: string
): Promise<GitResult> {
  return execGit(["checkout", branchName], cwd);
}

export async function isMergeInProgress(cwd: string): Promise<boolean> {
  const result = await execGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd);
  return result.success;
}

export async function abortMerge(cwd: string): Promise<GitResult> {
  return execGit(["merge", "--abort"], cwd);
}

export async function mergeBranch(
  cwd: string,
  branchName: string,
  options: { ffOnly?: boolean; noEdit?: boolean } = {}
): Promise<GitResult> {
  const args = ["merge"];
  if (options.ffOnly !== false) {
    args.push("--ff-only");
  } else if (options.noEdit !== false) {
    args.push("--no-edit");
  }
  args.push(branchName);
  return execGit(args, cwd);
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

export async function getDiffBetweenRefs(
  cwd: string,
  baseRef: string,
  headRef: string
): Promise<GitResult> {
  return execGit(["diff", `${baseRef}...${headRef}`], cwd);
}

export async function getChangedFilesBetweenRefs(
  cwd: string,
  baseRef: string,
  headRef: string
): Promise<string[]> {
  const result = await execGit(
    ["diff", "--name-only", `${baseRef}...${headRef}`],
    cwd
  );
  if (!result.success) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function getDiffStatsBetweenRefs(
  cwd: string,
  baseRef: string,
  headRef: string
): Promise<DiffStats> {
  const result = await execGit(
    ["diff", "--numstat", `${baseRef}...${headRef}`],
    cwd
  );
  if (!result.success) {
    return {
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      files: [],
    };
  }

  let additions = 0;
  let deletions = 0;
  const files: DiffStats["files"] = [];

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [addRaw, delRaw, filename] = trimmed.split("\t");
    if (!filename) continue;
    const fileAdditions = Number.isNaN(Number(addRaw)) ? 0 : Number(addRaw);
    const fileDeletions = Number.isNaN(Number(delRaw)) ? 0 : Number(delRaw);
    additions += fileAdditions;
    deletions += fileDeletions;
    files.push({
      filename,
      additions: fileAdditions,
      deletions: fileDeletions,
      status: "modified",
    });
  }

  return {
    additions,
    deletions,
    changedFiles: files.length,
    files,
  };
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

// 作業ツリーのdiffを取得
export async function getWorkingTreeDiff(cwd: string): Promise<GitResult> {
  return execGit(["diff", "HEAD", "--no-color"], cwd);
}

// 未追跡ファイル一覧を取得
export async function getUntrackedFiles(cwd: string): Promise<string[]> {
  const result = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
  if (!result.success) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// 変更をまとめてステージする
export async function stageAll(cwd: string): Promise<GitResult> {
  return execGit(["add", "-A"], cwd);
}

// 変更をコミットする
export async function commitChanges(
  cwd: string,
  message: string
): Promise<GitResult> {
  return execGit(["commit", "-m", message], cwd);
}

// 変更をstashに退避する
export async function stashChanges(
  cwd: string,
  message: string
): Promise<GitResult> {
  return execGit(["stash", "push", "-u", "-m", message], cwd);
}

// 最新のstash参照を取得（stash@{n} 形式）
export async function getLatestStashRef(cwd: string): Promise<string | undefined> {
  const result = await execGit(["stash", "list", "-1", "--pretty=format:%gd"], cwd);
  if (!result.success || !result.stdout) {
    return undefined;
  }
  return result.stdout.trim();
}

// stashを適用する
export async function applyStash(
  cwd: string,
  stashRef: string
): Promise<GitResult> {
  return execGit(["stash", "apply", stashRef], cwd);
}

// stashを削除する
export async function dropStash(
  cwd: string,
  stashRef: string
): Promise<GitResult> {
  return execGit(["stash", "drop", stashRef], cwd);
}
