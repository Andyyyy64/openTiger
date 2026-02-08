import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";

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

export async function readRequirementFile(path: string): Promise<string> {
  return readFile(path, "utf-8");
}
