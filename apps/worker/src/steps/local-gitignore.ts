import { appendFile, lstat, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseCommand } from "./verify/command-parser";

type LocalGitIgnoreResult = {
  success: boolean;
  excludePath: string | null;
  addedEntries: string[];
  error?: string;
};

function normalizeRelativeDirectoryPath(rawPath: string): string | null {
  const trimmed = rawPath.replaceAll("\\", "/").trim();
  if (!trimmed) {
    return null;
  }
  const stripped = trimmed.replace(/^["']|["']$/g, "");
  const withoutDot = stripped.replace(/^\.\//, "");
  if (!withoutDot || withoutDot === ".") {
    return null;
  }
  if (isAbsolute(withoutDot) || /^[A-Za-z]:\//.test(withoutDot)) {
    return null;
  }
  if (withoutDot.includes("..")) {
    return null;
  }
  if (/[*?[\]{}]/.test(withoutDot)) {
    return null;
  }
  const normalized = withoutDot.replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : null;
}

function collectFlagPathValues(args: string[], flags: string[]): string[] {
  const values: string[] = [];
  const flagSet = new Set(flags);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (flagSet.has(token)) {
      const next = args[index + 1];
      if (next && !next.startsWith("-")) {
        values.push(next);
      }
      continue;
    }
    for (const flag of flags) {
      if (flag.length === 2 && token.startsWith(flag) && token.length > flag.length) {
        values.push(token.slice(flag.length));
      }
      if (token.startsWith(`${flag}=`) && token.length > flag.length + 1) {
        values.push(token.slice(flag.length + 1));
      }
    }
  }
  return values;
}

function resolveCommandArtifactDirectories(command: string): string[] {
  const parsed = parseCommand(command);
  if (!parsed) {
    return [];
  }
  const executable = basename(parsed.executable).replace(/\.exe$/i, "").toLowerCase();
  if (executable === "cmake") {
    return collectFlagPathValues(parsed.args, ["-B", "--build"]);
  }
  if (executable === "ctest") {
    return collectFlagPathValues(parsed.args, ["--test-dir"]);
  }
  return [];
}

export function resolveLocalGitIgnoreEntriesFromCommands(commands: string[]): string[] {
  const entries = new Set<string>();
  for (const command of commands) {
    const directories = resolveCommandArtifactDirectories(command);
    for (const directory of directories) {
      const normalized = normalizeRelativeDirectoryPath(directory);
      if (!normalized) {
        continue;
      }
      entries.add(`${normalized}/`);
    }
  }
  return Array.from(entries);
}

export async function resolveGitInfoExcludePath(repoPath: string): Promise<string | null> {
  const dotGitPath = join(repoPath, ".git");
  let stat;
  try {
    stat = await lstat(dotGitPath);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    return join(dotGitPath, "info", "exclude");
  }
  if (!stat.isFile()) {
    return null;
  }

  const dotGitContent = await readFile(dotGitPath, "utf-8");
  const gitDirLine = dotGitContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith("gitdir:"));
  if (!gitDirLine) {
    return null;
  }
  const gitDirRaw = gitDirLine.slice("gitdir:".length).trim();
  if (!gitDirRaw) {
    return null;
  }
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(repoPath, gitDirRaw);
  return join(gitDir, "info", "exclude");
}

export async function ensureLocalGitIgnoreEntries(params: {
  repoPath: string;
  commands: string[];
}): Promise<LocalGitIgnoreResult> {
  try {
    const entries = resolveLocalGitIgnoreEntriesFromCommands(params.commands);
    if (entries.length === 0) {
      return {
        success: true,
        excludePath: null,
        addedEntries: [],
      };
    }

    const excludePath = await resolveGitInfoExcludePath(params.repoPath);
    if (!excludePath) {
      return {
        success: false,
        excludePath: null,
        addedEntries: [],
        error: "Could not resolve .git/info/exclude path",
      };
    }

    await mkdir(dirname(excludePath), { recursive: true });

    let existingContent = "";
    try {
      existingContent = await readFile(excludePath, "utf-8");
    } catch {
      existingContent = "";
    }
    const existingEntries = new Set(
      existingContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    );
    const toAppend = entries.filter((entry) => !existingEntries.has(entry));
    if (toAppend.length === 0) {
      return {
        success: true,
        excludePath,
        addedEntries: [],
      };
    }

    const prefix = existingContent.length > 0 && !existingContent.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${prefix}${toAppend.join("\n")}\n`, "utf-8");

    return {
      success: true,
      excludePath,
      addedEntries: toAppend,
    };
  } catch (error) {
    return {
      success: false,
      excludePath: null,
      addedEntries: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
