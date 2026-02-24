import { execFile } from "node:child_process";
import { readFile, stat, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { resolveGitHubAuthMode, resolveGitHubToken } from "@openTiger/vcs";

const execFileAsync = promisify(execFile);
export const CANONICAL_REQUIREMENT_PATH = "docs/requirement.md";
const REQUIREMENT_SNAPSHOT_COMMIT_MESSAGE = "chore: sync requirement snapshot";

export function resolveRepoRoot(): string {
  return resolve(import.meta.dirname, "../../../..");
}

type RequirementRepoRootConfig = {
  repoMode?: string | null;
  localRepoPath?: string | null;
  replanWorkdir?: string | null;
  repoUrl?: string | null;
  githubOwner?: string | null;
  githubRepo?: string | null;
  githubAuthMode?: string | null;
  githubToken?: string | null;
};

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalPath(value: string | null | undefined): string | undefined {
  const normalized = normalizeOptionalText(value);
  return normalized ? resolve(normalized) : undefined;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseGithubRepoFromUrl(rawUrl: string): { owner?: string; repo?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {};
  }
  if (trimmed.startsWith("git@")) {
    const sshMatch = /^git@[^:]+:(.+)$/u.exec(trimmed);
    if (!sshMatch?.[1]) {
      return {};
    }
    const [owner, repo] = sshMatch[1].replace(/\.git$/u, "").split("/");
    return {
      owner: owner?.trim(),
      repo: repo?.trim(),
    };
  }
  try {
    const parsed = new URL(trimmed);
    const [owner, repo] = parsed.pathname
      .replace(/^\/+/u, "")
      .replace(/\.git$/u, "")
      .split("/");
    return {
      owner: owner?.trim(),
      repo: repo?.trim(),
    };
  } catch {
    return {};
  }
}

function resolveGitTargetRepoUrl(config: RequirementRepoRootConfig): string | undefined {
  const repoUrl = normalizeOptionalText(config.repoUrl);
  if (repoUrl) {
    return repoUrl;
  }
  const owner = normalizeOptionalText(config.githubOwner);
  const repo = normalizeOptionalText(config.githubRepo);
  if (owner && repo) {
    return `https://github.com/${owner}/${repo}`;
  }
  return undefined;
}

function buildAuthedGitHubUrl(rawUrl: string, token: string): string {
  if (!rawUrl.startsWith("https://github.com/")) {
    return rawUrl;
  }
  return rawUrl.replace("https://github.com/", `https://x-access-token:${token}@github.com/`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitRepoRootForRequirement(
  config: RequirementRepoRootConfig,
): Promise<string | null> {
  const repoUrl = resolveGitTargetRepoUrl(config);
  if (!repoUrl) {
    return null;
  }

  const parsed = parseGithubRepoFromUrl(repoUrl);
  const owner = sanitizePathSegment(parsed.owner ?? config.githubOwner?.trim() ?? "unknown-owner");
  const repo = sanitizePathSegment(parsed.repo ?? config.githubRepo?.trim() ?? "unknown-repo");
  const cacheRoot = resolve(
    process.env.OPENTIGER_REQUIREMENT_REPO_ROOT?.trim() || `${homedir()}/.opentiger/repos`,
  );
  const repoRoot = resolve(cacheRoot, owner, repo);

  const gitCheck = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (gitCheck.success && gitCheck.stdout === "true") {
    return repoRoot;
  }

  if (await pathExists(repoRoot)) {
    throw new Error(
      `Requirement repository path exists but is not a git repository: ${repoRoot}. Remove it or configure REPLAN_WORKDIR/LOCAL_REPO_PATH explicitly.`,
    );
  }

  await mkdir(dirname(repoRoot), { recursive: true });
  const cloneDirect = await runGit(cacheRoot, ["clone", repoUrl, repoRoot]);
  if (cloneDirect.success) {
    return repoRoot;
  }

  let token: string | undefined;
  try {
    token = resolveGitHubToken({
      token: config.githubToken ?? undefined,
      authMode: resolveGitHubAuthMode(config.githubAuthMode ?? undefined),
    });
  } catch {
    token = undefined;
  }

  if (token && repoUrl.startsWith("https://github.com/")) {
    await rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
    const authedUrl = buildAuthedGitHubUrl(repoUrl, token);
    const cloneAuthed = await runGit(cacheRoot, ["clone", authedUrl, repoRoot]);
    if (cloneAuthed.success) {
      return repoRoot;
    }
    throw new Error(
      cloneAuthed.stderr || cloneAuthed.stdout || "Failed to prepare requirement target repository",
    );
  }

  throw new Error(
    cloneDirect.stderr || cloneDirect.stdout || "Failed to prepare requirement target repository",
  );
}

export async function resolveRequirementRepoRoot(
  config: RequirementRepoRootConfig,
): Promise<string> {
  const systemRepoRoot = resolveRepoRoot();
  const replanWorkdir = normalizeOptionalPath(config.replanWorkdir);
  if (replanWorkdir && replanWorkdir !== systemRepoRoot) {
    return replanWorkdir;
  }
  const localRepoPath = normalizeOptionalPath(config.localRepoPath);
  if (localRepoPath && localRepoPath !== systemRepoRoot) {
    return localRepoPath;
  }
  const repoMode = (config.repoMode ?? "github").trim().toLowerCase();
  if (repoMode === "git" || repoMode === "github") {
    const managedRepoRoot = await ensureGitRepoRootForRequirement(config);
    if (managedRepoRoot && managedRepoRoot !== systemRepoRoot) {
      return managedRepoRoot;
    }
  }
  throw new Error(
    "Requirement target repository is unresolved. Configure REPLAN_WORKDIR or LOCAL_REPO_PATH to a non-openTiger repository.",
  );
}

function isSubPath(baseDir: string, targetDir: string): boolean {
  const relativePath = relative(baseDir, targetDir);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function resolvePathInRepo(rawPath: string, repoRoot: string): string {
  const baseDir = resolve(repoRoot);
  const resolved = resolve(baseDir, rawPath);
  // Prevent file operations outside the repository
  if (!isSubPath(baseDir, resolved)) {
    throw new Error("Path must be within repository");
  }
  return resolved;
}

export async function resolveRequirementPath(
  input?: string,
  fallback?: string,
  options: { allowMissing?: boolean; repoRoot?: string } = {},
): Promise<string> {
  const repoRoot = options.repoRoot?.trim();
  if (!repoRoot) {
    throw new Error(
      "Requirement target repository is unresolved. Configure REPLAN_WORKDIR or LOCAL_REPO_PATH first.",
    );
  }
  // Handle UI input and environment variables uniformly
  const candidate =
    input?.trim() ||
    process.env.REQUIREMENT_PATH ||
    process.env.REPLAN_REQUIREMENT_PATH ||
    fallback;
  if (!candidate) {
    throw new Error("Requirement file path is required");
  }
  const resolved = resolvePathInRepo(candidate, repoRoot);
  if (!options.allowMissing) {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      throw new Error("Requirement file must be a file");
    }
  }
  return resolved;
}

export async function writeRequirementFile(path: string, content: string): Promise<void> {
  // Save requirement file to pass to Planner
  await mkdir(dirname(path), { recursive: true });
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await writeFile(path, normalized, "utf-8");
}

async function runGit(
  repoRoot: string,
  args: string[],
): Promise<{
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        // API request handling must never block on interactive git prompts
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 120000,
    });
    return {
      success: true,
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      success: false,
      exitCode: typeof failure.code === "number" ? failure.code : -1,
      stdout: typeof failure.stdout === "string" ? failure.stdout.trim() : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr.trim() : (failure.message ?? ""),
    };
  }
}

async function commitRequirementSnapshotIfChanged(
  relativePath: string,
  repoRoot: string,
): Promise<{
  committed: boolean;
  reason?: string;
  error?: string;
}> {
  const gitRepoCheck = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!gitRepoCheck.success || gitRepoCheck.stdout !== "true") {
    return {
      committed: false,
      error: "Requirement snapshot commit requires a git repository at repo root",
    };
  }

  const remoteOrigin = await runGit(repoRoot, ["remote", "get-url", "origin"]);
  const hasRemoteOrigin = remoteOrigin.success && remoteOrigin.stdout.length > 0;

  const remoteHead = hasRemoteOrigin
    ? await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    : null;
  const branchFromRemoteHead = remoteHead?.success
    ? remoteHead.stdout.replace(/^origin\//u, "").trim()
    : "";
  const targetBranch = branchFromRemoteHead || process.env.BASE_BRANCH?.trim() || "main";

  let canCheckoutFromRemoteBranch = hasRemoteOrigin;
  if (hasRemoteOrigin) {
    const fetchResult = await runGit(repoRoot, ["fetch", "origin", targetBranch]);
    const fetchErrorText = `${fetchResult.stdout}\n${fetchResult.stderr}`.toLowerCase();
    const missingRemoteBranch =
      fetchErrorText.includes("couldn't find remote ref") ||
      fetchErrorText.includes("remote ref does not exist");
    if (missingRemoteBranch) {
      canCheckoutFromRemoteBranch = false;
    }
    if (!fetchResult.success && !missingRemoteBranch) {
      return {
        committed: false,
        error: fetchResult.stderr || "Failed to fetch latest requirement branch from origin",
      };
    }
  }
  const checkoutArgs =
    hasRemoteOrigin && canCheckoutFromRemoteBranch
      ? ["checkout", "-B", targetBranch, `origin/${targetBranch}`]
      : ["checkout", "-B", targetBranch];
  const checkoutResult = await runGit(repoRoot, checkoutArgs);
  if (!checkoutResult.success) {
    return {
      committed: false,
      error: checkoutResult.stderr || "Failed to checkout requirement snapshot branch",
    };
  }

  const addResult = await runGit(repoRoot, ["add", "--", relativePath]);
  if (!addResult.success) {
    return {
      committed: false,
      error: addResult.stderr || "Failed to stage requirement snapshot",
    };
  }

  const diffResult = await runGit(repoRoot, ["diff", "--cached", "--quiet", "--", relativePath]);
  let committed = false;
  let reason: string | undefined;

  if (diffResult.success) {
    reason = "no_changes";
  } else {
    if (diffResult.exitCode !== 1) {
      return {
        committed: false,
        error: diffResult.stderr || "Failed to check staged requirement diff",
      };
    }

    const commitResult = await runGit(repoRoot, [
      "-c",
      "user.name=openTiger",
      "-c",
      "user.email=system@opentiger.ai",
      "commit",
      "-m",
      REQUIREMENT_SNAPSHOT_COMMIT_MESSAGE,
      "--",
      relativePath,
    ]);
    if (!commitResult.success) {
      const combined = `${commitResult.stdout}\n${commitResult.stderr}`.toLowerCase();
      if (combined.includes("nothing to commit")) {
        reason = "no_changes";
      } else {
        return {
          committed: false,
          error: commitResult.stderr || "Failed to commit requirement snapshot",
        };
      }
    }
    committed = true;
  }

  if (hasRemoteOrigin) {
    const pushResult = await runGit(repoRoot, ["push", "origin", `HEAD:${targetBranch}`]);
    if (!pushResult.success) {
      return {
        committed,
        reason,
        error: pushResult.stderr || "Failed to push requirement snapshot to origin",
      };
    }
  }

  return { committed, reason };
}

export async function syncRequirementSnapshot(params: {
  inputPath?: string;
  content: string;
  commitSnapshot?: boolean;
  repoRoot?: string;
}): Promise<{
  requirementPath: string;
  canonicalPath: string;
  committed: boolean;
  commitReason?: string;
}> {
  const rawRepoRoot = params.repoRoot?.trim();
  if (!rawRepoRoot) {
    throw new Error(
      "Requirement target repository is unresolved. Configure REPLAN_WORKDIR or LOCAL_REPO_PATH first.",
    );
  }
  const targetRepoRoot = resolve(rawRepoRoot);
  const requirementPath = await resolveRequirementPath(
    params.inputPath,
    CANONICAL_REQUIREMENT_PATH,
    { allowMissing: true, repoRoot: targetRepoRoot },
  );
  await writeRequirementFile(requirementPath, params.content);

  const canonicalPath = await resolveRequirementPath(
    CANONICAL_REQUIREMENT_PATH,
    CANONICAL_REQUIREMENT_PATH,
    { allowMissing: true, repoRoot: targetRepoRoot },
  );
  if (canonicalPath !== requirementPath) {
    await writeRequirementFile(canonicalPath, params.content);
  }

  if (params.commitSnapshot === false) {
    return {
      requirementPath,
      canonicalPath,
      committed: false,
      commitReason: "disabled",
    };
  }

  const commitResult = await commitRequirementSnapshotIfChanged(
    CANONICAL_REQUIREMENT_PATH,
    targetRepoRoot,
  );
  // Non-git directories (e.g. direct mode repos) cannot commit — treat as
  // non-fatal since the file itself was already written successfully above.
  if (commitResult.error) {
    return {
      requirementPath,
      canonicalPath,
      committed: false,
      commitReason: commitResult.error,
    };
  }
  return {
    requirementPath,
    canonicalPath,
    committed: commitResult.committed,
    commitReason: commitResult.reason,
  };
}

export async function readRequirementFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}
