import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { parseCommand } from "./command-parser";
import { GENERATED_EXTENSIONS, GENERATED_PATHS } from "./constants";

export function normalizePathForMatch(path: string): string {
  const trimmed = path.replaceAll("\0", "").trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function isOpenTigerTempPath(path: string): boolean {
  const normalizedPath = normalizePathForMatch(path);
  return (
    normalizedPath.startsWith(".openTiger-opencode-") ||
    normalizedPath.includes("/.openTiger-opencode-")
  );
}

// Check if path matches pattern
export function matchesPattern(path: string, patterns: string[]): boolean {
  const normalizedPath = normalizePathForMatch(path);
  // Include dotfiles like Playwright .last-run.json
  return patterns.some((pattern) => {
    const normalizedPattern = normalizePathForMatch(pattern);
    return (
      minimatch(normalizedPath, normalizedPattern, { dot: true }) ||
      minimatch(path, pattern, { dot: true })
    );
  });
}

export function isGeneratedPath(path: string): boolean {
  if (isOpenTigerTempPath(path)) {
    return true;
  }
  return matchesPattern(path, GENERATED_PATHS);
}

function parseExtraGeneratedPathsFromEnv(): string[] {
  return (process.env.WORKER_EXTRA_GENERATED_PATHS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function dedupePatterns(patterns: string[]): string[] {
  const unique = new Set<string>();
  for (const pattern of patterns) {
    const normalized = pattern.trim();
    if (normalized.length === 0) {
      continue;
    }
    unique.add(normalized);
  }
  return Array.from(unique);
}

async function loadGeneratedPathsFromTextFile(path: string): Promise<string[]> {
  try {
    const content = await readFile(path, "utf-8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

type GeneratedPathsJson = {
  paths?: unknown;
  patterns?: unknown;
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim());
}

async function loadGeneratedPathsFromJsonFile(path: string): Promise<string[]> {
  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content) as GeneratedPathsJson;
    return [...toStringArray(parsed.paths), ...toStringArray(parsed.patterns)].filter(
      (entry) => entry.length > 0,
    );
  } catch {
    return [];
  }
}

export async function resolveGeneratedPathPatterns(repoPath: string): Promise<string[]> {
  const envPatterns = parseExtraGeneratedPathsFromEnv();
  const textPatterns = await loadGeneratedPathsFromTextFile(
    join(repoPath, ".opentiger/generated-paths.txt"),
  );
  const jsonPatterns = await loadGeneratedPathsFromJsonFile(
    join(repoPath, ".opentiger/generated-paths.json"),
  );
  return dedupePatterns([...GENERATED_PATHS, ...envPatterns, ...textPatterns, ...jsonPatterns]);
}

export function isGeneratedPathWithPatterns(path: string, patterns: string[]): boolean {
  if (isOpenTigerTempPath(path)) {
    return true;
  }
  return matchesPattern(path, patterns);
}

export function mergeAllowedPaths(current: string[], extra: string[]): string[] {
  const merged = new Set(current);
  for (const path of extra) {
    merged.add(path);
  }
  return Array.from(merged);
}

export function includesInstallCommand(commands: string[]): boolean {
  const rawTokens = process.env.WORKER_INSTALL_SUBCOMMAND_TOKENS ?? "install,add,i";
  const installTokens = new Set(
    rawTokens
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );

  return commands.some((command) => {
    const parsed = parseCommand(command);
    if (!parsed) {
      return false;
    }
    return parsed.args.some((arg) => installTokens.has(arg.toLowerCase()));
  });
}

export function touchesPackageManifest(files: string[]): boolean {
  const workspaceConfigPattern =
    /(^|\/)(?:[^/]*workspace[^/]*\.(?:json|ya?ml)|turbo\.json|lerna\.json)$/i;
  return files.some(
    (file) =>
      file === "package.json" ||
      file.endsWith("/package.json") ||
      workspaceConfigPattern.test(file),
  );
}

export async function detectLockfilePaths(repoPath: string): Promise<string[]> {
  try {
    const entries = await readdir(repoPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /(^|[-._])lock([-._]|$)/i.test(name))
      .map((name) => normalizePathForMatch(name));
  } catch {
    return [];
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function isGeneratedTypeScriptOutput(
  file: string,
  repoPath: string,
): Promise<boolean> {
  if (!GENERATED_EXTENSIONS.some((ext) => file.endsWith(ext))) {
    return false;
  }

  const withoutMap = file.endsWith(".d.ts.map") ? file.replace(/\.d\.ts\.map$/, "") : file;
  const base = withoutMap.endsWith(".d.ts")
    ? withoutMap.replace(/\.d\.ts$/, "")
    : withoutMap.replace(/\.js$/, "");

  const tsPath = join(repoPath, `${base}.ts`);
  const tsxPath = join(repoPath, `${base}.tsx`);

  return (await fileExists(tsPath)) || (await fileExists(tsxPath));
}
