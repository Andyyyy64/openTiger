import { access, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { matchDeniedCommand, normalizeVerificationCommand } from "./command-normalizer";
import { runCommand } from "./command-runner";
import { normalizePathForMatch } from "./paths";
import { isBootstrapLikeFailureOutput } from "./verify-failure-handling";
import {
  resolvePackageManagerFromCommand,
  type VerificationExecutionSource,
} from "./verify-command-context";

type InlineRecoveryCandidate = {
  command: string;
  cwd: string;
};

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export type InlineRecoveryAttemptResult = {
  command: string;
  source: VerificationExecutionSource;
  success: boolean;
  outcome: "passed" | "failed" | "skipped";
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type InlineRecoveryOutcome = {
  recovered: boolean;
  attempted: boolean;
  attemptResults: InlineRecoveryAttemptResult[];
  summary: string;
};

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

function uniquePathList(paths: Array<string | null | undefined>): string[] {
  const deduped = new Set<string>();
  for (const candidate of paths) {
    if (!candidate) {
      continue;
    }
    deduped.add(resolve(candidate));
  }
  return Array.from(deduped);
}

async function resolvePackageManagerFromRepo(repoPath: string): Promise<PackageManager | null> {
  if (await pathExists(join(repoPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(join(repoPath, "yarn.lock"))) {
    return "yarn";
  }
  if (await pathExists(join(repoPath, "package-lock.json"))) {
    return "npm";
  }
  if (await pathExists(join(repoPath, "bun.lockb"))) {
    return "bun";
  }
  return null;
}

function resolveInstallRecoveryCommands(packageManager: PackageManager): string[] {
  if (packageManager === "pnpm") {
    return ["pnpm install --frozen-lockfile", "pnpm install"];
  }
  if (packageManager === "yarn") {
    return ["yarn install --immutable", "yarn install"];
  }
  if (packageManager === "bun") {
    return ["bun install --frozen-lockfile", "bun install"];
  }
  return ["npm ci", "npm install"];
}

async function resolveBootstrapInstallCandidates(params: {
  repoPath: string;
  failedCommand: string;
  output: string;
  maxCandidates: number;
}): Promise<InlineRecoveryCandidate[]> {
  if (!isBootstrapLikeFailureOutput(params.output)) {
    return [];
  }
  if (!(await pathExists(join(params.repoPath, "package.json")))) {
    return [];
  }
  const packageManager =
    resolvePackageManagerFromCommand(params.failedCommand) ??
    (await resolvePackageManagerFromRepo(params.repoPath)) ??
    "npm";
  return resolveInstallRecoveryCommands(packageManager)
    .slice(0, params.maxCandidates)
    .map((command) => ({ command, cwd: params.repoPath }));
}

function inferInlineRecoveryScriptPriority(command: string, output: string): string[] {
  const normalized = `${command}\n${output}`.toLowerCase();
  if (
    normalized.includes("vitest") ||
    normalized.includes("jest") ||
    normalized.includes("playwright") ||
    normalized.includes("cypress") ||
    normalized.includes(" test")
  ) {
    return ["test", "check", "typecheck", "build", "lint"];
  }
  if (normalized.includes("typecheck") || normalized.includes("tsc")) {
    return ["typecheck", "check", "build", "test", "lint"];
  }
  if (
    normalized.includes("lint") ||
    normalized.includes("eslint") ||
    normalized.includes("oxlint")
  ) {
    return ["lint", "check", "typecheck", "test", "build"];
  }
  if (normalized.includes("build")) {
    return ["build", "typecheck", "check", "test", "lint"];
  }
  if (normalized.includes("check")) {
    return ["check", "typecheck", "test", "build", "lint"];
  }
  return ["check", "typecheck", "test", "build", "lint"];
}

async function readPackageScriptNames(packageDir: string): Promise<Set<string>> {
  const packageJsonPath = join(packageDir, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return new Set();
  }
  try {
    const raw = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: unknown };
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.scripts ||
      typeof parsed.scripts !== "object"
    ) {
      return new Set();
    }
    return new Set(
      Object.keys(parsed.scripts as Record<string, unknown>).filter((name) => name.length > 0),
    );
  } catch {
    return new Set();
  }
}

export async function resolveInlineRecoveryCommandCandidates(params: {
  repoPath: string;
  failedCommand: string;
  output: string;
  failedCommandCwd: string;
  singleChangedPackageDir: string | null;
  maxCandidates?: number;
}): Promise<InlineRecoveryCandidate[]> {
  const maxCandidatesRaw = params.maxCandidates ?? 3;
  const maxCandidates = Math.min(8, Math.max(1, maxCandidatesRaw));
  const bootstrapCandidates = await resolveBootstrapInstallCandidates({
    repoPath: params.repoPath,
    failedCommand: params.failedCommand,
    output: params.output,
    maxCandidates,
  });
  const priorityScripts = inferInlineRecoveryScriptPriority(params.failedCommand, params.output);
  const candidateDirs = uniquePathList([
    params.failedCommandCwd,
    params.singleChangedPackageDir,
    params.repoPath,
  ]).filter((candidate) => isInsideRepo(params.repoPath, candidate));
  const candidates: InlineRecoveryCandidate[] = [...bootstrapCandidates];
  const seen = new Set<string>(
    bootstrapCandidates.map((candidate) => `${resolve(candidate.cwd)}::${candidate.command}`),
  );
  for (const candidateDir of candidateDirs) {
    const scripts = await readPackageScriptNames(candidateDir);
    if (scripts.size === 0) {
      continue;
    }
    for (const script of priorityScripts) {
      if (!scripts.has(script)) {
        continue;
      }
      const candidateCommand = `pnpm run ${script}`;
      if (candidateCommand === normalizeVerificationCommand(params.failedCommand)) {
        continue;
      }
      const dedupeKey = `${candidateDir}::${candidateCommand}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      candidates.push({
        command: candidateCommand,
        cwd: candidateDir,
      });
      if (candidates.length >= maxCandidates) {
        return candidates;
      }
    }
  }
  return candidates;
}

export async function attemptInlineCommandRecovery(params: {
  repoPath: string;
  source: VerificationExecutionSource;
  failedCommand: string;
  output: string;
  failedCommandCwd: string;
  singleChangedPackageDir: string | null;
  deniedCommands: string[];
}): Promise<InlineRecoveryOutcome> {
  const maxCandidates = Number.parseInt(
    process.env.WORKER_VERIFY_INLINE_COMMAND_RECOVERY_CANDIDATES ?? "3",
    10,
  );
  const candidates = await resolveInlineRecoveryCommandCandidates({
    repoPath: params.repoPath,
    failedCommand: params.failedCommand,
    output: params.output,
    failedCommandCwd: params.failedCommandCwd,
    singleChangedPackageDir: params.singleChangedPackageDir,
    maxCandidates: Number.isFinite(maxCandidates) ? maxCandidates : 3,
  });
  if (candidates.length === 0) {
    return {
      recovered: false,
      attempted: false,
      attemptResults: [],
      summary: "No inline recovery candidate commands could be derived from package scripts.",
    };
  }

  const attemptResults: InlineRecoveryAttemptResult[] = [];
  const deniedAttempts: string[] = [];
  for (const candidate of candidates) {
    const deniedMatch = matchDeniedCommand(candidate.command, params.deniedCommands);
    if (deniedMatch) {
      deniedAttempts.push(`${candidate.command} (matched: ${deniedMatch})`);
      continue;
    }
    const cwdLabel = normalizePathForMatch(relative(params.repoPath, candidate.cwd)) || ".";
    console.warn(
      cwdLabel === "."
        ? `[Verify] Inline recovery candidate: ${candidate.command}`
        : `[Verify] Inline recovery candidate: ${candidate.command} (cwd: ${cwdLabel})`,
    );
    const result = await runCommand(candidate.command, candidate.cwd);
    const attemptResult: InlineRecoveryAttemptResult = {
      ...result,
      source: params.source,
    };
    attemptResults.push(attemptResult);
    if (result.success) {
      return {
        recovered: true,
        attempted: true,
        attemptResults,
        summary: `Recovered with inline command: ${candidate.command}${
          cwdLabel === "." ? "" : ` (cwd: ${cwdLabel})`
        }`,
      };
    }
  }

  const deniedSummary =
    deniedAttempts.length > 0 ? ` Denied candidates: ${deniedAttempts.join("; ")}` : "";
  return {
    recovered: false,
    attempted: attemptResults.length > 0 || deniedAttempts.length > 0,
    attemptResults,
    summary: `Inline recovery candidates failed.${deniedSummary}`.trim(),
  };
}
