import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
    const rawTimeoutMs = Number.parseInt(globalThis.process.env.OPENTIGER_GIT_TIMEOUT_MS ?? "900000", 10);
    const timeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 900000;
    const child = spawn("git", args, {
      cwd,
      env: {
        ...globalThis.process.env,
        GIT_TERMINAL_PROMPT: "0", // インタラクティブな入力を無効化
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      const timeoutMessage = timedOut
        ? `\n[git] Command timed out after ${Math.round(timeoutMs / 1000)}s: git ${args.join(" ")}`
        : "";
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: `${stderr}${timeoutMessage}`.trim(),
        exitCode: code ?? -1,
      });
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
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

export async function initRepo(cwd: string, baseBranch?: string): Promise<GitResult> {
  const initResult = await execGit(["init"], cwd);
  if (!initResult.success) {
    return initResult;
  }
  if (baseBranch) {
    const checkoutResult = await execGit(["checkout", "-b", baseBranch], cwd);
    if (!checkoutResult.success) {
      return checkoutResult;
    }
  }
  return initResult;
}

export async function ensureInitialCommit(
  cwd: string,
  message = "chore: initialize repository",
): Promise<GitResult> {
  const headResult = await execGit(["rev-parse", "--verify", "HEAD"], cwd);
  if (headResult.success) {
    return headResult;
  }
  const addResult = await execGit(["add", "-A"], cwd);
  if (!addResult.success) {
    return addResult;
  }
  return execGit(
    [
      "-c",
      "user.name=openTiger",
      "-c",
      "user.email=worker@openTiger.ai",
      "commit",
      "-m",
      message,
      "--allow-empty",
    ],
    cwd,
  );
}

export async function ensureBranchExists(cwd: string, branchName: string): Promise<GitResult> {
  const verifyResult = await execGit(["rev-parse", "--verify", branchName], cwd);
  if (verifyResult.success) {
    return verifyResult;
  }
  return execGit(["branch", branchName], cwd);
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
  token?: string,
): Promise<GitResult> {
  // PR競合解消でmerge-base計算が必要になるため shallow clone は使わない
  const args = ["clone"];

  let authenticatedUrl = repoUrl;
  if (token && repoUrl.startsWith("https://github.com/")) {
    authenticatedUrl = repoUrl.replace(
      "https://github.com/",
      `https://x-access-token:${token}@github.com/`,
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

export async function fetchRefspecs(cwd: string, refspecs: string[]): Promise<GitResult> {
  if (refspecs.length === 0) {
    return {
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
  }
  return execGit(["fetch", "origin", ...refspecs], cwd);
}

// ブランチを作成してチェックアウト
export async function createBranch(
  cwd: string,
  branchName: string,
  baseRef = "main",
): Promise<GitResult> {
  // 指定したベース参照（branch/ref）からブランチ作成を優先
  const fromRefResult = await execGit(["checkout", "-B", branchName, baseRef], cwd);
  if (fromRefResult.success) {
    return fromRefResult;
  }
  if (baseRef.startsWith("origin/") || baseRef.startsWith("refs/")) {
    return fromRefResult;
  }

  // 互換性のため main/branch 起点の従来フローにフォールバック
  const checkoutResult = await execGit(["checkout", baseRef], cwd);
  if (checkoutResult.success) {
    await execGit(["pull", "origin", baseRef], cwd);
  } else {
    console.warn(`Base ref ${baseRef} not found, creating ${branchName} from current HEAD`);
  }
  return execGit(["checkout", "-B", branchName], cwd);
}

// 現在のブランチ名を取得
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  // 通常のリポジトリ用
  const result = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (result.success) {
    return result.stdout;
  }

  // 空のリポジトリ（コミットがない状態）用
  const symbolicResult = await execGit(["symbolic-ref", "--short", "HEAD"], cwd);
  return symbolicResult.success ? symbolicResult.stdout : null;
}

export async function checkoutBranch(cwd: string, branchName: string): Promise<GitResult> {
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
  options: { ffOnly?: boolean; noEdit?: boolean } = {},
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

export async function rebaseBranch(cwd: string, upstream: string): Promise<GitResult> {
  return execGit(["rebase", upstream], cwd);
}

export async function abortRebase(cwd: string): Promise<GitResult> {
  return execGit(["rebase", "--abort"], cwd);
}

// 変更をステージング
export async function stageChanges(cwd: string, paths: string[] = ["."]): Promise<GitResult> {
  return execGit(["add", ...paths], cwd);
}

// コミット
export async function commit(cwd: string, message: string): Promise<GitResult> {
  return execGit(["commit", "-m", message], cwd);
}

export async function commitAllowEmpty(cwd: string, message: string): Promise<GitResult> {
  return execGit(
    [
      "-c",
      "user.name=openTiger",
      "-c",
      "user.email=worker@openTiger.ai",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ],
    cwd,
  );
}

export async function createOrphanBranch(cwd: string, branchName: string): Promise<GitResult> {
  return execGit(["checkout", "--orphan", branchName], cwd);
}

export async function removeAllFiles(cwd: string): Promise<GitResult> {
  return execGit(["rm", "-rf", "."], cwd);
}

// プッシュ
export async function push(cwd: string, branch: string, force = false): Promise<GitResult> {
  const args = ["push", "origin", branch];
  if (force) {
    args.push("--force");
  }
  return execGit(args, cwd);
}

// 差分を取得
export async function getDiff(cwd: string, staged = false): Promise<GitResult> {
  const args = ["diff"];
  if (staged) {
    args.push("--staged");
  }
  return execGit(args, cwd);
}

export async function getDiffBetweenRefs(
  cwd: string,
  baseRef: string,
  headRef: string,
): Promise<GitResult> {
  return execGit(["diff", `${baseRef}...${headRef}`], cwd);
}

// 初回コミットの差分を取得
export async function getDiffFromRoot(cwd: string): Promise<GitResult> {
  return execGit(["show", "--root", "--pretty=", "--no-color", "HEAD"], cwd);
}

export async function getChangedFilesBetweenRefs(
  cwd: string,
  baseRef: string,
  headRef: string,
): Promise<string[]> {
  const result = await execGit(["diff", "--name-only", `${baseRef}...${headRef}`], cwd);
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
  headRef: string,
): Promise<DiffStats> {
  const result = await execGit(["diff", "--numstat", `${baseRef}...${headRef}`], cwd);
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

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  const result = await execGit(["rev-parse", "--verify", ref], cwd);
  return result.success;
}

export async function getChangedFilesFromRoot(cwd: string): Promise<string[]> {
  // 初回コミットの場合は作業ツリーではなくコミットの内容を参照する
  const result = await execGit(["show", "--name-only", "--pretty=", "--root", "HEAD"], cwd);
  if (!result.success) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function getDiffStatsFromRoot(cwd: string): Promise<DiffStats> {
  // 初回コミットの場合は作業ツリーではなくコミットの内容を参照する
  const result = await execGit(["show", "--numstat", "--pretty=", "--root", "HEAD"], cwd);
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
  // statusのフォーマット依存を避け、diff + untracked を個別に集約する
  const [unstaged, staged, untracked] = await Promise.all([
    execGit(["diff", "--name-only"], cwd),
    execGit(["diff", "--name-only", "--cached"], cwd),
    execGit(["ls-files", "--others", "--exclude-standard"], cwd),
  ]);

  const allLines = [
    ...(unstaged.success ? unstaged.stdout.split("\n") : []),
    ...(staged.success ? staged.stdout.split("\n") : []),
    ...(untracked.success ? untracked.stdout.split("\n") : []),
  ];

  const files = allLines
    .map((line) => line.trim())
    .filter((path) => path.length > 0 && !path.endsWith("/"));

  return Array.from(new Set(files));
}

// 変更行数を取得
export async function getChangeStats(
  cwd: string,
): Promise<{ additions: number; deletions: number }> {
  const parseNumstat = (output: string): { additions: number; deletions: number } => {
    let additions = 0;
    let deletions = 0;
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [addRaw, delRaw] = trimmed.split("\t");
      const add = Number(addRaw);
      const del = Number(delRaw);
      additions += Number.isFinite(add) ? add : 0;
      deletions += Number.isFinite(del) ? del : 0;
    }
    return { additions, deletions };
  };

  const [unstaged, staged, untracked] = await Promise.all([
    execGit(["diff", "--numstat"], cwd),
    execGit(["diff", "--numstat", "--cached"], cwd),
    execGit(["ls-files", "--others", "--exclude-standard"], cwd),
  ]);

  const unstagedStats = unstaged.success
    ? parseNumstat(unstaged.stdout)
    : { additions: 0, deletions: 0 };
  const stagedStats = staged.success ? parseNumstat(staged.stdout) : { additions: 0, deletions: 0 };
  let additions = unstagedStats.additions + stagedStats.additions;
  let deletions = unstagedStats.deletions + stagedStats.deletions;

  // 未追跡ファイルはnumstatに現れないため、追加行として概算する
  if (untracked.success && untracked.stdout) {
    const files = untracked.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const file of files) {
      try {
        const content = await readFile(join(cwd, file), "utf-8");
        const lineCount = content.length === 0 ? 0 : content.split("\n").length;
        additions += lineCount;
      } catch {
        // unreadable file is ignored for stats approximation
      }
    }
  }

  return { additions, deletions };
}

// 指定ファイルだけの変更行数を取得
export async function getChangeStatsForFiles(
  cwd: string,
  files: string[],
): Promise<{ additions: number; deletions: number }> {
  const targetFiles = Array.from(
    new Set(
      files
        .map((file) => file.trim())
        .filter((file) => file.length > 0 && !file.endsWith("/")),
    ),
  );

  if (targetFiles.length === 0) {
    return { additions: 0, deletions: 0 };
  }

  const parseNumstat = (output: string): { additions: number; deletions: number } => {
    let additions = 0;
    let deletions = 0;
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [addRaw, delRaw] = trimmed.split("\t");
      const add = Number(addRaw);
      const del = Number(delRaw);
      additions += Number.isFinite(add) ? add : 0;
      deletions += Number.isFinite(del) ? del : 0;
    }
    return { additions, deletions };
  };

  const [unstaged, staged, untracked] = await Promise.all([
    execGit(["diff", "--numstat", "--", ...targetFiles], cwd),
    execGit(["diff", "--numstat", "--cached", "--", ...targetFiles], cwd),
    execGit(["ls-files", "--others", "--exclude-standard"], cwd),
  ]);

  const unstagedStats = unstaged.success
    ? parseNumstat(unstaged.stdout)
    : { additions: 0, deletions: 0 };
  const stagedStats = staged.success ? parseNumstat(staged.stdout) : { additions: 0, deletions: 0 };
  let additions = unstagedStats.additions + stagedStats.additions;
  let deletions = unstagedStats.deletions + stagedStats.deletions;

  const untrackedSet = new Set(
    (untracked.success ? untracked.stdout : "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );

  for (const file of targetFiles) {
    if (!untrackedSet.has(file)) {
      continue;
    }
    try {
      const content = await readFile(join(cwd, file), "utf-8");
      const lineCount = content.length === 0 ? 0 : content.split("\n").length;
      additions += lineCount;
    } catch {
      // unreadable file is ignored for stats approximation
    }
  }

  return { additions, deletions };
}

// ブランチを削除
export async function deleteBranch(
  cwd: string,
  branchName: string,
  force = false,
): Promise<GitResult> {
  const args = ["branch", force ? "-D" : "-d", branchName];
  return execGit(args, cwd);
}

// リモートブランチを削除
export async function deleteRemoteBranch(cwd: string, branchName: string): Promise<GitResult> {
  return execGit(["push", "origin", "--delete", branchName], cwd);
}

// リモートブランチが存在するかチェック
export async function remoteBranchExists(cwd: string, branchName: string): Promise<boolean> {
  const result = await execGit(["ls-remote", "--heads", "origin", branchName], cwd);
  return result.success && result.stdout.includes(`refs/heads/${branchName}`);
}

// 変更を破棄してクリーンな状態に
export async function resetHard(cwd: string, ref = "HEAD"): Promise<GitResult> {
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
export async function commitChanges(cwd: string, message: string): Promise<GitResult> {
  return execGit(["commit", "-m", message], cwd);
}

// 変更をstashに退避する
export async function stashChanges(cwd: string, message: string): Promise<GitResult> {
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
export async function applyStash(cwd: string, stashRef: string): Promise<GitResult> {
  return execGit(["stash", "apply", stashRef], cwd);
}

// stashを削除する
export async function dropStash(cwd: string, stashRef: string): Promise<GitResult> {
  return execGit(["stash", "drop", stashRef], cwd);
}
