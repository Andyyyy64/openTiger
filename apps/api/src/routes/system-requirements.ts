import { execFile } from "node:child_process";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const CANONICAL_REQUIREMENT_PATH = "docs/requirement.md";
const REQUIREMENT_SNAPSHOT_COMMIT_MESSAGE = "chore: sync requirement snapshot";

export function resolveRepoRoot(): string {
  return resolve(import.meta.dirname, "../../../..");
}

function isSubPath(baseDir: string, targetDir: string): boolean {
  const relativePath = relative(baseDir, targetDir);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function resolvePathInRepo(rawPath: string): string {
  const baseDir = resolveRepoRoot();
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
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  // Handle UI input and environment variables uniformly
  const candidate =
    input?.trim() ||
    process.env.REQUIREMENT_PATH ||
    process.env.REPLAN_REQUIREMENT_PATH ||
    fallback;
  if (!candidate) {
    throw new Error("Requirement file path is required");
  }
  const resolved = resolvePathInRepo(candidate);
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
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: repoRoot });
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

async function commitRequirementSnapshotIfChanged(relativePath: string): Promise<{
  committed: boolean;
  reason?: string;
  error?: string;
}> {
  const repoRoot = resolveRepoRoot();
  const gitRepoCheck = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!gitRepoCheck.success || gitRepoCheck.stdout !== "true") {
    return {
      committed: false,
      error: "Requirement snapshot commit requires a git repository at repo root",
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
  if (diffResult.success) {
    return { committed: false, reason: "no_changes" };
  }
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
      return { committed: false, reason: "no_changes" };
    }
    return {
      committed: false,
      error: commitResult.stderr || "Failed to commit requirement snapshot",
    };
  }

  return { committed: true };
}

export async function syncRequirementSnapshot(params: {
  inputPath?: string;
  content: string;
  commitSnapshot?: boolean;
}): Promise<{
  requirementPath: string;
  canonicalPath: string;
  committed: boolean;
  commitReason?: string;
}> {
  const requirementPath = await resolveRequirementPath(
    params.inputPath,
    CANONICAL_REQUIREMENT_PATH,
    { allowMissing: true },
  );
  await writeRequirementFile(requirementPath, params.content);

  const canonicalPath = await resolveRequirementPath(
    CANONICAL_REQUIREMENT_PATH,
    CANONICAL_REQUIREMENT_PATH,
    { allowMissing: true },
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

  const commitResult = await commitRequirementSnapshotIfChanged(CANONICAL_REQUIREMENT_PATH);
  if (commitResult.error) {
    throw new Error(commitResult.error);
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
