import { access, appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
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

const GENERATED_HINT_EXTENSIONS = new Set([
  ".dump",
  ".log",
  ".tmp",
  ".trace",
  ".trc",
  ".lst",
  ".out",
  ".tsbuildinfo",
]);
const GENERATED_HINT_SEGMENTS = new Set([
  "coverage",
  "report",
  "reports",
  "artifact",
  "artifacts",
  "tmp",
  "out",
  "build",
  "dist",
]);
const AUTO_GENERATED_PATH_HINT_FILE = ".opentiger/generated-paths.auto.txt";

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
  const autoTextPatterns = await loadGeneratedPathsFromTextFile(
    join(repoPath, AUTO_GENERATED_PATH_HINT_FILE),
  );
  const jsonPatterns = await loadGeneratedPathsFromJsonFile(
    join(repoPath, ".opentiger/generated-paths.json"),
  );
  return dedupePatterns([
    ...GENERATED_PATHS,
    ...envPatterns,
    ...textPatterns,
    ...autoTextPatterns,
    ...jsonPatterns,
  ]);
}

export function isGeneratedPathWithPatterns(path: string, patterns: string[]): boolean {
  if (isOpenTigerTempPath(path)) {
    return true;
  }
  return matchesPattern(path, patterns);
}

function isSafeGeneratedHintPath(path: string): boolean {
  const normalized = normalizePathForMatch(path);
  if (!normalized || normalized.startsWith("/")) {
    return false;
  }
  if (normalized.includes("..")) {
    return false;
  }
  if (/[*?[\]{}]/.test(normalized)) {
    return false;
  }
  return true;
}

export function isLikelyGeneratedArtifactPath(path: string): boolean {
  const normalized = normalizePathForMatch(path);
  if (!isSafeGeneratedHintPath(normalized)) {
    return false;
  }
  if (isGeneratedPath(normalized)) {
    return true;
  }
  const lower = normalized.toLowerCase();
  const extension = extname(lower);
  if (extension && GENERATED_HINT_EXTENSIONS.has(extension)) {
    return true;
  }
  return lower
    .split("/")
    .some((segment) => segment.length > 0 && GENERATED_HINT_SEGMENTS.has(segment));
}

export async function persistGeneratedPathHints(
  repoPath: string,
  rawPaths: string[],
): Promise<string[]> {
  const normalized = Array.from(
    new Set(
      rawPaths
        .map((path) => normalizePathForMatch(path))
        .filter((path) => isLikelyGeneratedArtifactPath(path)),
    ),
  );
  if (normalized.length === 0) {
    return [];
  }

  const hintsPath = join(repoPath, AUTO_GENERATED_PATH_HINT_FILE);
  const existing = await loadGeneratedPathsFromTextFile(hintsPath);
  const existingSet = new Set(existing.map((entry) => normalizePathForMatch(entry)));
  const toAppend = normalized.filter((path) => !existingSet.has(path));
  if (toAppend.length === 0) {
    return [];
  }

  await mkdir(dirname(hintsPath), { recursive: true });
  await appendFile(hintsPath, `${toAppend.join("\n")}\n`, "utf-8");
  return toAppend;
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
