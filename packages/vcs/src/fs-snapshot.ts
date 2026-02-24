import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface FileSnapshot {
  root: string;
  entries: Map<string, FileEntry>;
  takenAt: number;
}

export interface SnapshotDiff {
  changedFiles: string[];
  addedFiles: string[];
  removedFiles: string[];
  stats: { additions: number; deletions: number };
}

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".openTiger-workspace",
  ".claude",
];

interface IgnoreRule {
  /** Exact directory/file name match (e.g. "node_modules") */
  type: "exact";
  pattern: string;
}

interface IgnoreGlobRule {
  /** Glob extension match (e.g. "*.log" → ".log") */
  type: "ext";
  ext: string;
}

interface IgnorePathRule {
  /** Path prefix match (e.g. "build/output" matches "build/output/foo.js") */
  type: "path";
  prefix: string;
}

type ParsedIgnoreRule = IgnoreRule | IgnoreGlobRule | IgnorePathRule;

function parseGitignorePatterns(content: string): ParsedIgnoreRule[] {
  const rules: ParsedIgnoreRule[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    const cleaned = line.endsWith("/") ? line.slice(0, -1) : line;
    if (!cleaned) continue;

    if (cleaned.startsWith("*.") && !cleaned.includes("/")) {
      // Extension glob: "*.log" → match files ending with ".log"
      rules.push({ type: "ext", ext: cleaned.slice(1) });
    } else if (cleaned.includes("/")) {
      // Path-based pattern: "build/output" → prefix match
      rules.push({ type: "path", prefix: cleaned });
    } else {
      // Exact name match against any path component
      rules.push({ type: "exact", pattern: cleaned });
    }
  }
  return rules;
}

function shouldIgnore(
  relativePath: string,
  exactSet: Set<string>,
  rules: ParsedIgnoreRule[],
): boolean {
  const parts = relativePath.split("/");
  for (const part of parts) {
    if (exactSet.has(part)) return true;
  }
  for (const rule of rules) {
    switch (rule.type) {
      case "exact":
        for (const part of parts) {
          if (part === rule.pattern) return true;
        }
        break;
      case "ext":
        if (relativePath.endsWith(rule.ext)) return true;
        break;
      case "path":
        if (relativePath.startsWith(rule.prefix + "/") || relativePath === rule.prefix) return true;
        break;
    }
  }
  return false;
}

export async function takeSnapshot(
  root: string,
  options?: { ignore?: string[] },
): Promise<FileSnapshot> {
  const exactIgnores = new Set([...DEFAULT_IGNORE, ...(options?.ignore ?? [])]);
  const gitignoreRules: ParsedIgnoreRule[] = [];

  // Read .gitignore if exists
  try {
    const gitignoreContent = await readFile(join(root, ".gitignore"), "utf-8");
    const parsed = parseGitignorePatterns(gitignoreContent);
    for (const rule of parsed) {
      if (rule.type === "exact") {
        exactIgnores.add(rule.pattern);
      } else {
        gitignoreRules.push(rule);
      }
    }
  } catch {
    // No .gitignore, continue
  }

  const entries = new Map<string, FileEntry>();

  const dirEntries = await readdir(root, { recursive: true, withFileTypes: true });

  for (const entry of dirEntries) {
    if (!entry.isFile()) continue;

    const parentPath = entry.parentPath;
    const fullPath = join(parentPath, entry.name);
    const relativePath = relative(root, fullPath);

    if (shouldIgnore(relativePath, exactIgnores, gitignoreRules)) continue;

    try {
      const fileStat = await stat(fullPath);
      entries.set(relativePath, {
        path: relativePath,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      });
    } catch {
      // File may have been deleted between readdir and stat
    }
  }

  return {
    root,
    entries,
    takenAt: Date.now(),
  };
}

export async function diffSnapshots(
  before: FileSnapshot,
  after: FileSnapshot,
): Promise<SnapshotDiff> {
  const changedFiles: string[] = [];
  const addedFiles: string[] = [];
  const removedFiles: string[] = [];

  // Check for added and changed files
  for (const [path, afterEntry] of after.entries) {
    const beforeEntry = before.entries.get(path);
    if (!beforeEntry) {
      addedFiles.push(path);
    } else if (
      beforeEntry.mtimeMs !== afterEntry.mtimeMs ||
      beforeEntry.size !== afterEntry.size
    ) {
      changedFiles.push(path);
    }
  }

  // Check for removed files
  for (const path of before.entries.keys()) {
    if (!after.entries.has(path)) {
      removedFiles.push(path);
    }
  }

  // Estimate line stats from size differences
  let additions = 0;
  let deletions = 0;

  for (const path of addedFiles) {
    const entry = after.entries.get(path);
    if (entry) {
      // Rough estimate: ~40 bytes per line
      additions += Math.max(1, Math.ceil(entry.size / 40));
    }
  }

  for (const path of removedFiles) {
    const entry = before.entries.get(path);
    if (entry) {
      deletions += Math.max(1, Math.ceil(entry.size / 40));
    }
  }

  for (const path of changedFiles) {
    const beforeEntry = before.entries.get(path);
    const afterEntry = after.entries.get(path);
    if (beforeEntry && afterEntry) {
      const sizeDiff = afterEntry.size - beforeEntry.size;
      if (sizeDiff > 0) {
        additions += Math.max(1, Math.ceil(sizeDiff / 40));
      } else {
        deletions += Math.max(1, Math.ceil(Math.abs(sizeDiff) / 40));
      }
      // Count at least 1 modification
      if (sizeDiff === 0) {
        additions += 1;
        deletions += 1;
      }
    }
  }

  return {
    changedFiles,
    addedFiles,
    removedFiles,
    stats: { additions, deletions },
  };
}
