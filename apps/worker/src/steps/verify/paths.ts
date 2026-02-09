import { access } from "node:fs/promises";
import { join } from "node:path";
import { minimatch } from "minimatch";
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

// パスがパターンに合致するか判定する
export function matchesPattern(path: string, patterns: string[]): boolean {
  const normalizedPath = normalizePathForMatch(path);
  // Playwrightの`.last-run.json`などドットファイルも含める
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

export function mergeAllowedPaths(current: string[], extra: string[]): string[] {
  const merged = new Set(current);
  for (const path of extra) {
    merged.add(path);
  }
  return Array.from(merged);
}

export function includesInstallCommand(commands: string[]): boolean {
  return commands.some((command) => /\bpnpm\b[^\n]*\b(install|add|i)\b/.test(command));
}

export function touchesPackageManifest(files: string[]): boolean {
  return files.some(
    (file) =>
      file === "package.json" || file.endsWith("/package.json") || file === "pnpm-workspace.yaml",
  );
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
