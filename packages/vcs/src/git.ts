import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveGitHubToken } from "./client";

// Result of git operation
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

// Execute git command
async function execGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const rawTimeoutMs = Number.parseInt(
      globalThis.process.env.OPENTIGER_GIT_TIMEOUT_MS ?? "900000",
      10,
    );
    const timeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 900000;
    const child = spawn("git", args, {
      cwd,
      env: {
        ...globalThis.process.env,
        GIT_TERMINAL_PROMPT: "0", // Disable interactive prompts
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

// Clone repository
export async function cloneRepo(
  repoUrl: string,
  destPath: string,
  branch?: string,
  token?: string,
  authMode?: string,
): Promise<GitResult> {
  // Avoid shallow clone; merge-base needed for PR conflict resolution
  const args = ["clone"];

  let authenticatedUrl = repoUrl;
  if (repoUrl.startsWith("https://github.com/")) {
    const resolvedToken = resolveGitHubToken({
      token,
      authMode,
    });
    authenticatedUrl = repoUrl.replace(
      "https://github.com/",
      `https://x-access-token:${resolvedToken}@github.com/`,
    );
  }

  // Do not specify branch here to prioritize clone first; fallback on error
  const cloneArgs = [...args, authenticatedUrl, destPath];
  const result = await execGit(cloneArgs, ".");

  // If clone with branch fails, retry without branch
  if (!result.success && branch) {
    console.warn(`Failed to clone branch ${branch}, retrying without branch specification...`);
    return execGit([...args, authenticatedUrl, destPath], ".");
  }

  return result;
}

// Fetch latest
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

export async function fetchRemoteBranch(cwd: string, branchName: string): Promise<GitResult> {
  return fetchRefspecs(cwd, [`refs/heads/${branchName}:refs/remotes/origin/${branchName}`]);
}

// Create branch and checkout
export async function createBranch(
  cwd: string,
  branchName: string,
  baseRef = "main",
): Promise<GitResult> {
  // Prefer creating branch from given base ref
  const fromRefResult = await execGit(["checkout", "-B", branchName, baseRef], cwd);
  if (fromRefResult.success) {
    return fromRefResult;
  }
  if (baseRef.startsWith("origin/") || baseRef.startsWith("refs/")) {
    const fetchBaseResult = await execGit(["fetch", "origin"], cwd);
    if (!fetchBaseResult.success) {
      return fromRefResult;
    }
    const retryFromRefResult = await execGit(["checkout", "-B", branchName, baseRef], cwd);
    if (retryFromRefResult.success) {
      return retryFromRefResult;
    }
    return fromRefResult;
  }

  // Fallback to legacy main/branch flow for compatibility
  const checkoutResult = await execGit(["checkout", baseRef], cwd);
  if (checkoutResult.success) {
    await execGit(["pull", "origin", baseRef], cwd);
  } else {
    console.warn(`Base ref ${baseRef} not found, creating ${branchName} from current HEAD`);
  }
  return execGit(["checkout", "-B", branchName], cwd);
}

// Get current branch name
export async function getCurrentBranch(cwd: string): Promise<string | null> {
  // Normal repository
  const result = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (result.success) {
    return result.stdout;
  }

  // Empty repo (no commits)
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

function extractIgnoredPathsFromAddError(stderr: string): string[] {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const markerIndex = lines.findIndex((line) =>
    line.toLowerCase().includes("ignored by one of your .gitignore files"),
  );
  if (markerIndex < 0) {
    return [];
  }
  const ignoredPaths: string[] = [];
  for (let index = markerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const lower = line.toLowerCase();
    if (lower.startsWith("hint:") || lower.startsWith("fatal:")) {
      break;
    }
    ignoredPaths.push(line);
  }
  return Array.from(new Set(ignoredPaths));
}

function extractMissingPathspecsFromAddError(stderr: string): string[] {
  const missingPaths: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = line.match(/pathspec ['"](.+?)['"] did not match any files/i);
    if (match?.[1]) {
      missingPaths.push(match[1].trim());
    }
  }
  return Array.from(new Set(missingPaths.filter((path) => path.length > 0)));
}

async function resolveTrackedMissingPaths(cwd: string, paths: string[]): Promise<string[]> {
  const trackedPaths: string[] = [];
  for (const path of paths) {
    const trackedResult = await execGit(["ls-files", "--error-unmatch", "--", path], cwd);
    if (trackedResult.success) {
      trackedPaths.push(path);
    }
  }
  return trackedPaths;
}

// Stage changes
export async function stageChanges(cwd: string, paths: string[] = ["."]): Promise<GitResult> {
  const normalizedPaths = Array.from(
    new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0)),
  );
  const stagePaths = normalizedPaths.length > 0 ? normalizedPaths : ["."];
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  const skippedIgnoredPaths = new Set<string>();
  const skippedMissingPaths = new Set<string>();
  let pendingPaths = stagePaths;
  let useAddAll = false;
  let lastExitCode = 1;

  const attemptLimit = Math.max(2, stagePaths.length + 2);

  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    const result = await execGit(
      useAddAll ? ["add", "-A", "--", ...pendingPaths] : ["add", "--", ...pendingPaths],
      cwd,
    );
    if (result.stdout.length > 0) {
      stdoutParts.push(result.stdout);
    }
    if (result.stderr.length > 0) {
      stderrParts.push(result.stderr);
    }
    lastExitCode = result.exitCode;

    if (result.success) {
      const warnings: string[] = [];
      if (skippedIgnoredPaths.size > 0) {
        warnings.push(
          `[git] Skipped ignored paths during staging: ${Array.from(skippedIgnoredPaths).join(", ")}`,
        );
      }
      if (skippedMissingPaths.size > 0) {
        warnings.push(
          `[git] Skipped missing untracked paths during staging: ${Array.from(skippedMissingPaths).join(", ")}`,
        );
      }
      return {
        success: true,
        stdout: stdoutParts.join("\n").trim(),
        stderr: [...warnings, ...stderrParts]
          .filter((line) => line.length > 0)
          .join("\n")
          .trim(),
        exitCode: 0,
      };
    }

    const ignoredPaths = extractIgnoredPathsFromAddError(result.stderr);
    const missingPaths = extractMissingPathspecsFromAddError(result.stderr);
    if (ignoredPaths.length === 0 && missingPaths.length === 0) {
      return {
        success: false,
        stdout: stdoutParts.join("\n").trim(),
        stderr: stderrParts.join("\n").trim(),
        exitCode: lastExitCode,
      };
    }

    if (pendingPaths.includes(".") && ignoredPaths.length > 0) {
      return {
        success: false,
        stdout: stdoutParts.join("\n").trim(),
        stderr: stderrParts.join("\n").trim(),
        exitCode: lastExitCode,
      };
    }

    const ignoredSet = new Set(ignoredPaths);
    const missingSet = new Set(missingPaths);
    const safePaths = pendingPaths.filter((path) => !ignoredSet.has(path) && !missingSet.has(path));
    const trackedMissingPaths =
      missingPaths.length > 0 ? await resolveTrackedMissingPaths(cwd, missingPaths) : [];
    const trackedMissingSet = new Set(trackedMissingPaths);
    for (const ignoredPath of ignoredPaths) {
      skippedIgnoredPaths.add(ignoredPath);
    }
    for (const missingPath of missingPaths) {
      if (!trackedMissingSet.has(missingPath)) {
        skippedMissingPaths.add(missingPath);
      }
    }

    const retryPaths = Array.from(new Set([...safePaths, ...trackedMissingPaths]));
    if (retryPaths.length === 0) {
      return {
        success: true,
        stdout: stdoutParts.join("\n").trim(),
        stderr: [
          skippedIgnoredPaths.size > 0
            ? `[git] Skipped ignored paths during staging: ${Array.from(skippedIgnoredPaths).join(", ")}`
            : "",
          skippedMissingPaths.size > 0
            ? `[git] Skipped missing untracked paths during staging: ${Array.from(skippedMissingPaths).join(", ")}`
            : "",
          ...stderrParts,
        ]
          .filter((line) => line.length > 0)
          .join("\n")
          .trim(),
        exitCode: 0,
      };
    }

    const samePathset =
      retryPaths.length === pendingPaths.length &&
      retryPaths.every((path, index) => path === pendingPaths[index]);
    // 同じ pathset でも、まだ -A を試していない段階では一度だけフォールバックを許可する。
    if (samePathset && useAddAll) {
      return {
        success: false,
        stdout: stdoutParts.join("\n").trim(),
        stderr: stderrParts.join("\n").trim(),
        exitCode: lastExitCode,
      };
    }

    pendingPaths = retryPaths;
    useAddAll = true;
  }

  return {
    success: false,
    stdout: stdoutParts.join("\n").trim(),
    stderr: [...stderrParts, "[git] stageChanges retry limit exceeded"]
      .filter((line) => line.length > 0)
      .join("\n")
      .trim(),
    exitCode: lastExitCode,
  };
}

// Commit
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

// Push
export async function push(cwd: string, branch: string, force = false): Promise<GitResult> {
  const args = ["push", "origin", branch];
  if (force) {
    args.push("--force");
  }
  return execGit(args, cwd);
}

// Get diff
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

// Get diff from root (initial commit)
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

export async function getCommitSha(cwd: string, ref: string): Promise<string | null> {
  const result = await execGit(["rev-parse", "--verify", ref], cwd);
  if (!result.success) {
    return null;
  }
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

export async function isAncestorRef(
  cwd: string,
  ancestorRef: string,
  descendantRef: string,
): Promise<boolean | null> {
  const result = await execGit(["merge-base", "--is-ancestor", ancestorRef, descendantRef], cwd);
  if (result.success) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  return null;
}

export async function getChangedFilesFromRoot(cwd: string): Promise<string[]> {
  // For initial commit, refer to commit content not work tree
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
  // For initial commit, refer to commit content not work tree
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

// Get changed files list
export async function getChangedFiles(cwd: string): Promise<string[]> {
  // Avoid status format dependency; aggregate diff + untracked separately
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

// Get change stats
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

  // Untracked files not in numstat; approximate as additions
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

// Get change stats for specified files only
export async function getChangeStatsForFiles(
  cwd: string,
  files: string[],
): Promise<{ additions: number; deletions: number }> {
  const targetFiles = Array.from(
    new Set(
      files.map((file) => file.trim()).filter((file) => file.length > 0 && !file.endsWith("/")),
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

// Delete branch
export async function deleteBranch(
  cwd: string,
  branchName: string,
  force = false,
): Promise<GitResult> {
  const args = ["branch", force ? "-D" : "-d", branchName];
  return execGit(args, cwd);
}

// Delete remote branch
export async function deleteRemoteBranch(cwd: string, branchName: string): Promise<GitResult> {
  return execGit(["push", "origin", "--delete", branchName], cwd);
}

// Check if remote branch exists
export async function remoteBranchExists(cwd: string, branchName: string): Promise<boolean> {
  const result = await execGit(["ls-remote", "--heads", "origin", branchName], cwd);
  return result.success && result.stdout.includes(`refs/heads/${branchName}`);
}

// Discard changes for clean state
export async function resetHard(cwd: string, ref = "HEAD"): Promise<GitResult> {
  return execGit(["reset", "--hard", ref], cwd);
}

// Remove untracked files
export async function cleanUntracked(cwd: string): Promise<GitResult> {
  return execGit(["clean", "-fd"], cwd);
}

// Discard changes for specific paths while preserving other worktree modifications.
// This restores tracked paths and cleans untracked files/directories only for the given targets.
export async function discardChangesForPaths(cwd: string, paths: string[]): Promise<GitResult> {
  const normalizedPaths = Array.from(
    new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0)),
  );
  if (normalizedPaths.length === 0) {
    return {
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
  }

  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  let allSucceeded = true;

  for (const path of normalizedPaths) {
    const trackedResult = await execGit(["ls-files", "--error-unmatch", "--", path], cwd);
    if (trackedResult.success) {
      const restoreResult = await execGit(["restore", "--staged", "--worktree", "--", path], cwd);
      if (!restoreResult.success) {
        allSucceeded = false;
        stderrParts.push(`[restore:${path}] ${restoreResult.stderr || "restore failed"}`);
      } else if (restoreResult.stdout) {
        stdoutParts.push(restoreResult.stdout);
      }
    }

    const cleanResult = await execGit(["clean", "-fd", "--", path], cwd);
    if (!cleanResult.success) {
      allSucceeded = false;
      stderrParts.push(`[clean:${path}] ${cleanResult.stderr || "clean failed"}`);
    } else if (cleanResult.stdout) {
      stdoutParts.push(cleanResult.stdout);
    }
  }

  return {
    success: allSucceeded,
    stdout: stdoutParts.join("\n").trim(),
    stderr: stderrParts.join("\n").trim(),
    exitCode: allSucceeded ? 0 : 1,
  };
}

// Get working tree diff
export async function getWorkingTreeDiff(cwd: string): Promise<GitResult> {
  return execGit(["diff", "HEAD", "--no-color"], cwd);
}

// Get untracked files
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

// Stage all changes
export async function stageAll(cwd: string): Promise<GitResult> {
  return execGit(["add", "-A"], cwd);
}

// Commit changes
export async function commitChanges(cwd: string, message: string): Promise<GitResult> {
  return execGit(["commit", "-m", message], cwd);
}

// Stash changes
export async function stashChanges(cwd: string, message: string): Promise<GitResult> {
  return execGit(["stash", "push", "-u", "-m", message], cwd);
}

// Get latest stash ref (stash@{n} format)
export async function getLatestStashRef(cwd: string): Promise<string | undefined> {
  const result = await execGit(["stash", "list", "-1", "--pretty=format:%gd"], cwd);
  if (!result.success || !result.stdout) {
    return undefined;
  }
  return result.stdout.trim();
}

// Apply stash
export async function applyStash(cwd: string, stashRef: string): Promise<GitResult> {
  return execGit(["stash", "apply", stashRef], cwd);
}

// Drop stash
export async function dropStash(cwd: string, stashRef: string): Promise<GitResult> {
  return execGit(["stash", "drop", stashRef], cwd);
}
