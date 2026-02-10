import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizePathForMatch } from "./paths";

export async function loadRootScripts(repoPath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(join(repoPath, "package.json"), "utf-8");
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

export async function hasRootCheckScript(repoPath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(repoPath, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.scripts?.check === "string";
  } catch {
    return false;
  }
}

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

type PackageManifest = {
  dir: string;
  name?: string;
  scripts: Record<string, string>;
};

type ResolveAutoVerificationCommandsOptions = {
  repoPath: string;
  changedFiles: string[];
  explicitCommands: string[];
};

const AUTO_VERIFICATION_SCRIPTS = ["check", "typecheck", "build", "lint"] as const;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function shouldIncludeAutoScript(script: string): boolean {
  if (script !== "test") {
    return true;
  }
  return (process.env.WORKER_AUTO_VERIFY_INCLUDE_TEST ?? "false").toLowerCase() === "true";
}

function getAutoVerificationScripts(): string[] {
  const configuredOrder = process.env.WORKER_AUTO_VERIFY_SCRIPT_ORDER;
  if (!configuredOrder) {
    return Array.from(AUTO_VERIFICATION_SCRIPTS);
  }
  const allowed = new Set([...AUTO_VERIFICATION_SCRIPTS, "test"]);
  const scripts = configuredOrder
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => allowed.has(value))
    .filter((value) => shouldIncludeAutoScript(value));
  if (scripts.length > 0) {
    return scripts;
  }
  return Array.from(AUTO_VERIFICATION_SCRIPTS);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(repoPath: string): Promise<PackageManager> {
  if (await pathExists(join(repoPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(join(repoPath, "yarn.lock"))) {
    return "yarn";
  }
  if (await pathExists(join(repoPath, "bun.lockb"))) {
    return "bun";
  }
  return "npm";
}

async function loadPackageManifest(packageJsonPath: string): Promise<PackageManifest | null> {
  try {
    const content = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(content) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    return {
      dir: dirname(packageJsonPath),
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      scripts: parsed.scripts ?? {},
    };
  } catch {
    return null;
  }
}

function isInsideRepo(repoRoot: string, candidatePath: string): boolean {
  const normalizedRoot = resolve(repoRoot);
  const normalizedCandidate = resolve(candidatePath);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`) ||
    normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  );
}

async function findNearestPackageManifest(
  repoPath: string,
  changedFile: string,
): Promise<PackageManifest | null> {
  const normalizedFile = normalizePathForMatch(changedFile);
  let current = resolve(repoPath, normalizedFile);
  if (!isInsideRepo(repoPath, current)) {
    return null;
  }
  // changedFile は通常ファイルパスなので1段上から探索する
  current = dirname(current);

  while (isInsideRepo(repoPath, current)) {
    const manifest = await loadPackageManifest(join(current, "package.json"));
    if (manifest) {
      return manifest;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

function buildRootScriptCommand(manager: PackageManager, script: string): string {
  if (manager === "yarn") {
    return `yarn ${script}`;
  }
  if (manager === "pnpm") {
    return `pnpm run ${script}`;
  }
  if (manager === "bun") {
    return `bun run ${script}`;
  }
  return `npm run ${script}`;
}

function buildFilteredScriptCommand(
  manager: PackageManager,
  packageName: string,
  script: string,
): string | null {
  if (manager === "pnpm") {
    return `pnpm --filter ${packageName} run ${script}`;
  }
  return null;
}

function hasCompileLikeScript(commands: string[]): boolean {
  return commands.some((command) => {
    const trimmed = command.trim().toLowerCase();
    return (
      /\b(run\s+)?(check|build|typecheck)\b/.test(trimmed) ||
      /\btsc\b/.test(trimmed) ||
      /\bnext\s+build\b/.test(trimmed) ||
      /\bvite\s+build\b/.test(trimmed)
    );
  });
}

export async function resolveAutoVerificationCommands(
  options: ResolveAutoVerificationCommandsOptions,
): Promise<string[]> {
  const mode = (process.env.WORKER_AUTO_VERIFY_MODE ?? "safety").toLowerCase();
  if (mode === "off" || mode === "disabled") {
    return [];
  }

  const maxCommands = parsePositiveInt(process.env.WORKER_AUTO_VERIFY_MAX_COMMANDS, 4);
  if (maxCommands === 0) {
    return [];
  }

  if (mode === "fallback" && options.explicitCommands.length > 0) {
    return [];
  }
  if (mode === "safety" && hasCompileLikeScript(options.explicitCommands)) {
    return [];
  }

  const manager = await detectPackageManager(options.repoPath);
  const scriptOrder = getAutoVerificationScripts();
  const existing = new Set(options.explicitCommands.map((command) => command.trim()));
  const autoCommands: string[] = [];

  const pushAuto = (command: string | null): void => {
    if (!command) {
      return;
    }
    const trimmed = command.trim();
    if (!trimmed || existing.has(trimmed) || autoCommands.includes(trimmed)) {
      return;
    }
    autoCommands.push(trimmed);
  };

  const rootScripts = await loadRootScripts(options.repoPath);
  if (typeof rootScripts.check === "string" && scriptOrder.includes("check")) {
    pushAuto(buildRootScriptCommand(manager, "check"));
  } else {
    for (const script of scriptOrder) {
      if (script === "check") {
        continue;
      }
      if (typeof rootScripts[script] === "string") {
        pushAuto(buildRootScriptCommand(manager, script));
      }
    }
  }

  const packageManifestMap = new Map<string, PackageManifest>();
  for (const changedFile of options.changedFiles) {
    const manifest = await findNearestPackageManifest(options.repoPath, changedFile);
    if (!manifest) {
      continue;
    }
    packageManifestMap.set(manifest.dir, manifest);
  }

  for (const manifest of packageManifestMap.values()) {
    if (manifest.dir === resolve(options.repoPath)) {
      continue;
    }
    if (!manifest.name) {
      continue;
    }

    for (const script of scriptOrder) {
      if (script === "check") {
        continue;
      }
      if (typeof manifest.scripts[script] !== "string") {
        continue;
      }
      pushAuto(buildFilteredScriptCommand(manager, manifest.name, script));
    }
  }

  return autoCommands.slice(0, maxCommands);
}
