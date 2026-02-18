import { access, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { expandVerificationCommand } from "./command-normalizer";
import { parseCommand } from "./command-parser";
import { normalizePathForMatch } from "./paths";
import type { VerificationCommandSource } from "./types";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export type VerificationExecutionSource = Extract<VerificationCommandSource, "explicit" | "auto">;

export type VerificationCommandInput = {
  command: string;
  source: VerificationExecutionSource;
};

export type VerificationCommand = {
  command: string;
  source: VerificationExecutionSource;
  cwd: string;
};

const WORKSPACE_ROOT_META_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "pnpm-workspace.yaml",
  "turbo.json",
  "lerna.json",
  "nx.json",
]);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isInsideRepo(repoPath: string, candidatePath: string): boolean {
  const normalizedRoot = resolve(repoPath);
  const normalizedCandidate = resolve(candidatePath);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`) ||
    normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  );
}

function resolveChainedCommandCwd(
  command: string,
  currentCwd: string,
  repoPath: string,
): string | null {
  const parsed = parseCommand(command);
  if (!parsed || parsed.executable !== "cd") {
    return null;
  }
  if (parsed.args.length > 1) {
    return null;
  }
  const target = parsed.args[0] ?? ".";
  const nextCwd = resolve(currentCwd, target);
  if (!isInsideRepo(repoPath, nextCwd)) {
    return null;
  }
  return nextCwd;
}

export async function cleanupOpenCodeTempDirs(repoPath: string): Promise<void> {
  try {
    const entries = await readdir(repoPath, { withFileTypes: true });
    const targets = entries.filter((entry) => entry.name.startsWith(".openTiger-opencode-"));
    await Promise.all(
      targets.map((entry) =>
        rm(join(repoPath, entry.name), { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  } catch {
    // ignore cleanup failures and continue verification
  }
}

export function isDocumentationFile(path: string): boolean {
  return (
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path === "README.md" ||
    path.startsWith("docs/") ||
    path.startsWith("ops/runbooks/")
  );
}

export function expandVerificationCommandsWithCwd(
  baseCommands: VerificationCommandInput[],
  repoPath: string,
): VerificationCommand[] {
  const expandedCommands: VerificationCommand[] = [];
  const sourceCwd: Record<VerificationExecutionSource, string> = {
    explicit: repoPath,
    auto: repoPath,
  };
  for (const baseCommand of baseCommands) {
    const expanded = expandVerificationCommand(baseCommand.command);
    if (expanded.length > 1) {
      console.log(
        `[Verify] Expanded chained command: ${baseCommand.command} -> ${expanded.join(" | ")}`,
      );
    }
    let commandCwd = sourceCwd[baseCommand.source];
    for (const command of expanded) {
      const chainedCwd = resolveChainedCommandCwd(command, commandCwd, repoPath);
      if (chainedCwd) {
        const cwdLabel = normalizePathForMatch(relative(repoPath, chainedCwd)) || ".";
        console.log(`[Verify] Applied chained directory change: ${command} -> ${cwdLabel}`);
        commandCwd = chainedCwd;
        sourceCwd[baseCommand.source] = commandCwd;
        continue;
      }
      expandedCommands.push({
        command,
        source: baseCommand.source,
        cwd: commandCwd,
      });
    }
  }
  return expandedCommands;
}

function isWorkspaceRootMetaFile(file: string): boolean {
  return WORKSPACE_ROOT_META_FILES.has(normalizePathForMatch(file));
}

async function findNearestPackageDir(
  repoPath: string,
  changedFile: string,
): Promise<string | null> {
  const normalizedFile = normalizePathForMatch(changedFile);
  let current = resolve(repoPath, normalizedFile);
  if (!isInsideRepo(repoPath, current)) {
    return null;
  }
  current = dirname(current);

  while (isInsideRepo(repoPath, current)) {
    if (await pathExists(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

export async function resolveSingleChangedPackageDir(
  repoPath: string,
  files: string[],
): Promise<string | null> {
  const packageDirs = new Set<string>();

  for (const file of files) {
    if (isWorkspaceRootMetaFile(file)) {
      continue;
    }
    const packageDir = await findNearestPackageDir(repoPath, file);
    if (!packageDir) {
      continue;
    }
    packageDirs.add(packageDir);
    if (packageDirs.size > 1) {
      return null;
    }
  }

  const [singleDir] = Array.from(packageDirs);
  if (!singleDir || resolve(singleDir) === resolve(repoPath)) {
    return null;
  }

  return singleDir;
}

function trimGlobPatternPrefix(pattern: string): string {
  const normalized = normalizePathForMatch(pattern).trim();
  if (!normalized) {
    return "";
  }
  const wildcardIndex = normalized.search(/[*?[{]/);
  if (wildcardIndex < 0) {
    return normalized.replace(/\/+$/, "");
  }
  return normalized.slice(0, wildcardIndex).replace(/\/+$/, "");
}

async function findNearestPackageDirFromPathPrefix(
  repoPath: string,
  pathPrefix: string,
): Promise<string | null> {
  if (!pathPrefix) {
    return null;
  }
  let current = resolve(repoPath, pathPrefix);
  if (!isInsideRepo(repoPath, current)) {
    return null;
  }
  while (isInsideRepo(repoPath, current)) {
    if (await pathExists(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export async function resolveSingleAllowedPackageDir(
  repoPath: string,
  allowedPaths: string[],
): Promise<string | null> {
  const packageDirs = new Set<string>();

  for (const allowedPath of allowedPaths) {
    const prefix = trimGlobPatternPrefix(allowedPath);
    if (!prefix || prefix === ".") {
      continue;
    }
    const packageDir = await findNearestPackageDirFromPathPrefix(repoPath, prefix);
    if (!packageDir) {
      continue;
    }
    if (resolve(packageDir) === resolve(repoPath)) {
      continue;
    }
    packageDirs.add(packageDir);
    if (packageDirs.size > 1) {
      return null;
    }
  }

  const [singleDir] = Array.from(packageDirs);
  return singleDir ?? null;
}

function removeWorkspaceRecursiveFlags(
  executable: string,
  args: string[],
): { hasRecursiveScope: boolean; args: string[] } {
  const filtered: string[] = [];
  let hasRecursiveScope = false;

  for (const arg of args) {
    const normalized = arg.trim().toLowerCase();
    if (
      (executable === "pnpm" && (normalized === "-r" || normalized === "--recursive")) ||
      (executable === "npm" && (normalized === "-ws" || normalized === "--workspaces"))
    ) {
      hasRecursiveScope = true;
      continue;
    }
    filtered.push(arg);
  }

  return { hasRecursiveScope, args: filtered };
}

export function resolvePackageScopedRetryCommand(command: string): string | null {
  const parsed = parseCommand(command);
  if (!parsed) {
    return null;
  }
  const executable = parsed.executable.trim().toLowerCase();
  if (executable !== "pnpm" && executable !== "npm") {
    return null;
  }
  const { hasRecursiveScope, args } = removeWorkspaceRecursiveFlags(executable, parsed.args);
  if (!hasRecursiveScope) {
    return null;
  }
  if (args.some((arg) => arg === "--filter" || arg.toLowerCase().startsWith("--filter="))) {
    return null;
  }
  const nextCommand = [parsed.executable, ...args].join(" ").trim();
  return nextCommand.length > 0 ? nextCommand : null;
}

export function resolvePackageManagerFromCommand(command: string): PackageManager | null {
  const parsed = parseCommand(command);
  if (!parsed) {
    return null;
  }
  const executable = parsed.executable.trim().toLowerCase();
  if (
    executable === "pnpm" ||
    executable === "npm" ||
    executable === "yarn" ||
    executable === "bun"
  ) {
    return executable;
  }
  return null;
}
