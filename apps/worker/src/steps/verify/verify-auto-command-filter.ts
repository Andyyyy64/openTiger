import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "./command-parser";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseMakeTargets(content: string): Set<string> {
  const targets = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("\t") || line.trimStart().startsWith("#")) {
      continue;
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) {
      continue;
    }
    const left = line.slice(0, colonIndex).trim();
    if (!left || left.includes("=")) {
      continue;
    }
    for (const candidate of left.split(/\s+/)) {
      const target = candidate.trim();
      if (!target || target.startsWith(".")) {
        continue;
      }
      if (target.includes("%")) {
        continue;
      }
      targets.add(target);
    }
  }
  return targets;
}

async function resolveRootMakeTargets(repoPath: string): Promise<Set<string> | null> {
  const candidates = ["Makefile", "makefile", "GNUmakefile"];
  for (const file of candidates) {
    const makefilePath = join(repoPath, file);
    if (!(await pathExists(makefilePath))) {
      continue;
    }
    try {
      const content = await readFile(makefilePath, "utf-8");
      const targets = parseMakeTargets(content);
      return targets.size > 0 ? targets : null;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveRequestedMakeTarget(command: string): string | null {
  const parsed = parseCommand(command);
  if (!parsed || parsed.executable !== "make") {
    return null;
  }
  const args = parsed.args;
  if (args.length === 0) {
    return "";
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "-f" || arg === "--file" || arg === "-C") {
      return null;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(arg)) {
      continue;
    }
    return arg;
  }
  return "";
}

export async function filterUnsupportedAutoCommands(
  repoPath: string,
  autoCommands: string[],
): Promise<string[]> {
  if (autoCommands.length === 0) {
    return [];
  }
  const makeTargets = await resolveRootMakeTargets(repoPath);
  if (!makeTargets) {
    return autoCommands;
  }
  const filtered: string[] = [];
  for (const command of autoCommands) {
    const requestedTarget = resolveRequestedMakeTarget(command);
    if (requestedTarget === null || requestedTarget === "" || makeTargets.has(requestedTarget)) {
      filtered.push(command);
      continue;
    }
    console.warn(
      `[Verify] Skipping unsupported auto make target '${requestedTarget}' from command: ${command}`,
    );
  }
  return filtered;
}
