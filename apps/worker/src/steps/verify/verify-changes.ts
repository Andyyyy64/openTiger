import { access, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  getChangedFiles,
  getChangeStats,
  getChangeStatsForFiles,
  getChangedFilesBetweenRefs,
  getDiffBetweenRefs,
  getDiffStatsBetweenRefs,
  refExists,
  getChangedFilesFromRoot,
  getDiffFromRoot,
  getDiffStatsFromRoot,
  getWorkingTreeDiff,
} from "@openTiger/vcs";
import { FAILURE_CODE } from "@openTiger/core";
import { runOpenCode } from "@openTiger/llm";
import {
  expandVerificationCommand,
  matchDeniedCommand,
  normalizeVerificationCommand,
} from "./command-normalizer";
import { runCommand } from "./command-runner";
import { buildOpenCodeEnv } from "../../env";
import {
  detectLockfilePaths,
  includesInstallCommand,
  isGeneratedPathWithPatterns,
  isGeneratedTypeScriptOutput,
  mergeAllowedPaths,
  normalizePathForMatch,
  resolveGeneratedPathPatterns,
  touchesPackageManifest,
} from "./paths";
import { checkPolicyViolations } from "./policy";
import { resolveAutoVerificationCommands } from "./repo-scripts";
import { ENV_EXAMPLE_PATHS } from "./constants";
import { parseCommand } from "./command-parser";
import type {
  CommandResult,
  VerifyFailureCode,
  VerifyOptions,
  VerifyResult,
  VerificationCommandSource,
} from "./types";

async function cleanupOpenCodeTempDirs(repoPath: string): Promise<void> {
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

function isDocumentationFile(path: string): boolean {
  return (
    path.endsWith(".md") ||
    path.endsWith(".mdx") ||
    path === "README.md" ||
    path.startsWith("docs/") ||
    path.startsWith("ops/runbooks/")
  );
}

type VerificationCommand = {
  command: string;
  source: VerificationExecutionSource;
  cwd: string;
};

type VerificationExecutionSource = Extract<VerificationCommandSource, "explicit" | "auto">;

type InlineRecoveryCandidate = {
  command: string;
  cwd: string;
};

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

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

const GENERATED_ARTIFACT_SEGMENTS = new Set([
  "artifact",
  "artifacts",
  "build",
  "debug",
  "dist",
  "out",
  "release",
  "target",
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

type VerificationCommandInput = {
  command: string;
  source: VerificationExecutionSource;
};

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

async function resolveSingleChangedPackageDir(
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

function resolvePackageManagerFromCommand(command: string): PackageManager | null {
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

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseArtifactPresenceCheckPath(command: string): string | null {
  const trimmed = command.trim();
  const match = trimmed.match(/^test\s+-(?:f|s)\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }
  const target = normalizePathForMatch(stripWrappingQuotes(match[1]));
  return target.length > 0 ? target : null;
}

function isLikelyGeneratedArtifactPath(path: string): boolean {
  const normalized = normalizePathForMatch(path).toLowerCase();
  if (!normalized || normalized.includes("..") || normalized.includes("*")) {
    return false;
  }
  return normalized
    .split("/")
    .some((segment) => segment.length > 0 && GENERATED_ARTIFACT_SEGMENTS.has(segment));
}

function splitCommandTokens(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function isCleanLikeCommand(command: string): boolean {
  const tokens = splitCommandTokens(command);
  const first = tokens[0]?.toLowerCase();
  if (!first) {
    return false;
  }
  if (first === "make") {
    return tokens.slice(1).some((token) => /clean/i.test(token));
  }
  if (first === "npm" || first === "pnpm" || first === "yarn" || first === "bun") {
    return /\b(run\s+)?(clean|distclean|clobber)\b/i.test(tokens.slice(1).join(" "));
  }
  return false;
}

function isVerificationSequenceIssue(params: {
  verificationCommands: VerificationCommand[];
  index: number;
  command: string;
  output: string;
}): boolean {
  const current = params.verificationCommands[params.index];
  if (!current) {
    return false;
  }
  const artifactPath = parseArtifactPresenceCheckPath(params.command);
  if (!artifactPath || !isLikelyGeneratedArtifactPath(artifactPath)) {
    return false;
  }
  if (summarizeCommandError(params.output) !== "stderr unavailable") {
    return false;
  }
  const previous = params.index > 0 ? params.verificationCommands[params.index - 1] : undefined;
  if (!previous) {
    return false;
  }
  return isCleanLikeCommand(previous.command);
}

export function resolveVerificationCommandFailureCode(params: {
  verificationCommands: VerificationCommand[];
  index: number;
  command: string;
  output: string;
}): VerifyFailureCode {
  const {
    missingScriptLikeFailure,
    noTestFilesLikeFailure,
    missingMakeTargetLikeFailure,
    unsupportedFormatFailure,
  } = isSkippableSetupFailure(params.command, params.output);
  if (missingMakeTargetLikeFailure) {
    return FAILURE_CODE.VERIFICATION_COMMAND_MISSING_MAKE_TARGET;
  }
  if (noTestFilesLikeFailure) {
    return FAILURE_CODE.VERIFICATION_COMMAND_NO_TEST_FILES;
  }
  if (missingScriptLikeFailure) {
    return FAILURE_CODE.VERIFICATION_COMMAND_MISSING_SCRIPT;
  }
  if (unsupportedFormatFailure) {
    return FAILURE_CODE.VERIFICATION_COMMAND_UNSUPPORTED_FORMAT;
  }
  if (isMissingDependencyOrCommandNotFoundFailure(params.output)) {
    return FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE;
  }
  if (isRuntimeCompatibilityFailure(params.output)) {
    return FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE;
  }
  if (isSetupOrBootstrapVerificationFailure(params.output)) {
    return FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE;
  }
  if (isVerificationSequenceIssue(params)) {
    return FAILURE_CODE.VERIFICATION_COMMAND_SEQUENCE_ISSUE;
  }
  return FAILURE_CODE.VERIFICATION_COMMAND_FAILED;
}

function summarizeCommandError(stderr: string, maxChars = 300): string {
  const normalized = stderr.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "stderr unavailable";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

function formatVerificationFailureError(params: {
  command?: string;
  source?: VerificationCommandSource;
  stderr?: string;
}): string {
  if (!params.command) {
    return "Verification commands failed";
  }
  const sourceLabel = params.source ? ` [${params.source}]` : "";
  const stderrSummary = summarizeCommandError(params.stderr ?? "");
  return `Verification failed at ${params.command}${sourceLabel}: ${stderrSummary}`;
}

function resolveCommandOutput(stderr: string, stdout: string): string {
  return stderr.trim().length > 0 ? stderr : stdout;
}

function isMissingMakeTargetFailure(output: string): boolean {
  return output.toLowerCase().includes("no rule to make target");
}

function isMissingScriptFailure(output: string): boolean {
  // Heuristic fallback for script lookup failures across npm/pnpm/yarn output variants.
  const normalized = output.toLowerCase();
  return (
    normalized.includes("err_pnpm_no_script") ||
    normalized.includes("missing script") ||
    (normalized.includes("command") &&
      normalized.includes("not found") &&
      normalized.includes("script"))
  );
}

function isNoTestFilesFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("no test files found") ||
    normalized.includes("no tests found") ||
    normalized.includes("no files found matching")
  );
}

function isMissingPackageManifestFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("could not read package.json") ||
    (normalized.includes("enoent") && normalized.includes("package.json"))
  );
}

function isUnsupportedCommandFormatFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("unsupported command format") ||
    (normalized.includes("shell operators") && normalized.includes("not allowed")) ||
    normalized.includes("unsupported shell builtin in verification command")
  );
}

function extractMissingModuleSpecifier(output: string): string | null {
  const packageMatch = output.match(/cannot find package ['"]([^'"]+)['"]/i);
  if (packageMatch?.[1]) {
    return packageMatch[1];
  }
  const moduleMatch = output.match(/cannot find module ['"]([^'"]+)['"]/i);
  if (moduleMatch?.[1]) {
    return moduleMatch[1];
  }
  const modulePathMatch = output.match(/module path ['"]([^'"]+)['"] to exist/i);
  if (modulePathMatch?.[1]) {
    return modulePathMatch[1];
  }
  return null;
}

function isLikelyLocalModuleSpecifier(specifier: string): boolean {
  const normalized = specifier.trim();
  return (
    normalized.startsWith(".") ||
    normalized.startsWith("/") ||
    normalized.startsWith("..") ||
    /^[A-Za-z]:[\\/]/.test(normalized)
  );
}

function isSetupOrBootstrapVerificationFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  if (normalized.includes("cannot find package")) {
    return true;
  }
  if (
    normalized.includes("module path") &&
    normalized.includes("to exist, but none could be found")
  ) {
    return true;
  }
  const missingSpecifier = extractMissingModuleSpecifier(output);
  if (!missingSpecifier) {
    return false;
  }
  if (isLikelyLocalModuleSpecifier(missingSpecifier)) {
    return false;
  }
  if (normalized.includes("failed to load config from") && normalized.includes("node_modules")) {
    return true;
  }
  return normalized.includes("imported from") && normalized.includes("node_modules");
}

function isMissingDependencyOrCommandNotFoundFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("missing dependency") ||
    normalized.includes("cannot find dependency") ||
    normalized.includes("command not found") ||
    normalized.includes("spawn enoent") ||
    (normalized.includes("sh:") && normalized.includes("not found"))
  );
}

function isRuntimeCompatibilityFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  if (normalized.includes("unsupported engine") && normalized.includes('"node"')) {
    return true;
  }
  if (normalized.includes("requires node") || normalized.includes("expected node version")) {
    return true;
  }
  if (
    normalized.includes("err_require_esm") &&
    (normalized.includes("node_modules") || normalized.includes("/.pnpm/"))
  ) {
    return true;
  }
  if (normalized.includes("not supported") && normalized.includes("node")) {
    return true;
  }
  return false;
}

function isBootstrapLikeFailureOutput(output: string): boolean {
  return (
    isMissingDependencyOrCommandNotFoundFailure(output) ||
    isRuntimeCompatibilityFailure(output) ||
    isSetupOrBootstrapVerificationFailure(output)
  );
}

function usesShellCommandSubstitution(command: string): boolean {
  return /\$\(/.test(command);
}

function isSkippableSetupFailure(
  command: string,
  output: string,
): {
  missingScriptLikeFailure: boolean;
  noTestFilesLikeFailure: boolean;
  missingMakeTargetLikeFailure: boolean;
  unsupportedFormatFailure: boolean;
  isSkippableOutput: boolean;
} {
  const missingMakeTargetLikeFailure = isMissingMakeTargetFailure(output);
  const noTestFilesLikeFailure = isNoTestFilesFailure(output);
  const missingScriptLikeFailure =
    isMissingScriptFailure(output) ||
    isMissingPackageManifestFailure(output) ||
    missingMakeTargetLikeFailure;
  const unsupportedFormatFailure =
    isUnsupportedCommandFormatFailure(output) || usesShellCommandSubstitution(command);
  return {
    missingScriptLikeFailure,
    noTestFilesLikeFailure,
    missingMakeTargetLikeFailure,
    unsupportedFormatFailure,
    isSkippableOutput:
      missingScriptLikeFailure || noTestFilesLikeFailure || unsupportedFormatFailure,
  };
}

export function shouldAttemptInlineCommandRecovery(params: {
  source: VerificationCommandSource;
  command: string;
  output: string;
  hasRemainingCommands: boolean;
}): boolean {
  if (params.source !== "explicit" && params.source !== "auto") {
    return false;
  }
  const enabled =
    (process.env.WORKER_VERIFY_INLINE_COMMAND_RECOVERY ?? "true").toLowerCase() !== "false";
  if (!enabled) {
    return false;
  }
  const bootstrapLikeFailure = isBootstrapLikeFailureOutput(params.output);
  if (params.hasRemainingCommands && !bootstrapLikeFailure) {
    return false;
  }
  if (bootstrapLikeFailure) {
    return true;
  }
  const { isSkippableOutput } = isSkippableSetupFailure(params.command, params.output);
  return isSkippableOutput;
}

type InlineRecoveryAttemptResult = {
  command: string;
  source: VerificationExecutionSource;
  success: boolean;
  outcome: "passed" | "failed" | "skipped";
  stdout: string;
  stderr: string;
  durationMs: number;
};

type InlineRecoveryOutcome = {
  recovered: boolean;
  attempted: boolean;
  attemptResults: InlineRecoveryAttemptResult[];
  summary: string;
};

async function attemptInlineCommandRecovery(params: {
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

export function shouldSkipExplicitCommandFailure(params: {
  source: VerificationCommandSource;
  command: string;
  output: string;
  hasRemainingCommands: boolean;
  hasPriorEffectiveCommand: boolean;
  isDocOnlyChange: boolean;
  isNoOpChange: boolean;
}): boolean {
  if (params.source !== "explicit") {
    return false;
  }
  const skipEnabled =
    (process.env.WORKER_VERIFY_SKIP_MISSING_EXPLICIT_SCRIPT ?? "true").toLowerCase() !== "false";
  if (!skipEnabled) {
    return false;
  }
  const { unsupportedFormatFailure, isSkippableOutput } = isSkippableSetupFailure(
    params.command,
    params.output,
  );
  if (!isSkippableOutput) {
    return false;
  }
  if (params.hasRemainingCommands) {
    return true;
  }
  if (unsupportedFormatFailure && params.hasPriorEffectiveCommand) {
    return true;
  }
  return params.isDocOnlyChange || params.isNoOpChange;
}

export function shouldSkipAutoCommandFailure(params: {
  source: VerificationCommandSource;
  command: string;
  output: string;
  hasRemainingCommands: boolean;
  hasPriorEffectiveCommand: boolean;
  hasPriorExplicitCommandPass: boolean;
  isDocOnlyChange: boolean;
  isNoOpChange: boolean;
}): boolean {
  if (params.source !== "auto") {
    return false;
  }
  const skipEnabled =
    (process.env.WORKER_VERIFY_SKIP_INVALID_AUTO_COMMAND ?? "true").toLowerCase() !== "false";
  if (!skipEnabled) {
    return false;
  }
  const { isSkippableOutput } = isSkippableSetupFailure(params.command, params.output);
  if (!isSkippableOutput) {
    const allowNonBlockingAfterExplicitPass =
      (process.env.WORKER_VERIFY_AUTO_NON_BLOCKING_AFTER_EXPLICIT_PASS ?? "true").toLowerCase() !==
      "false";
    if (
      allowNonBlockingAfterExplicitPass &&
      (params.hasPriorExplicitCommandPass || params.hasPriorEffectiveCommand) &&
      !params.hasRemainingCommands
    ) {
      return true;
    }
    return false;
  }
  if (params.hasRemainingCommands) {
    return true;
  }
  if (params.hasPriorEffectiveCommand) {
    return true;
  }
  return params.isDocOnlyChange || params.isNoOpChange;
}

// Verify changes
export async function verifyChanges(options: VerifyOptions): Promise<VerifyResult> {
  const {
    repoPath,
    commands,
    allowedPaths,
    policy,
    baseBranch,
    headBranch,
    allowLockfileOutsidePaths = false,
    allowEnvExampleOutsidePaths = false,
    allowNoChanges = false,
  } = options;

  console.log("Verifying changes...");
  await cleanupOpenCodeTempDirs(repoPath);

  // Get changed files
  let changedFiles = (await getChangedFiles(repoPath)).map((file: string) =>
    normalizePathForMatch(file),
  );
  changedFiles = Array.from(new Set(changedFiles.filter((file: string) => file.length > 0)));
  let stats: { additions: number; deletions: number } = { additions: 0, deletions: 0 };
  let usesCommittedDiff = false;
  let committedDiffRef: { base: string; head: string } | null = null;
  let usesRootDiff = false;

  // If no committed diff, compare base vs head
  if (changedFiles.length === 0 && baseBranch && headBranch) {
    const committedFiles = await getChangedFilesBetweenRefs(repoPath, baseBranch, headBranch);
    if (committedFiles.length > 0) {
      changedFiles = committedFiles
        .map((file: string) => normalizePathForMatch(file))
        .filter((file: string) => file.length > 0);
      const diffStats = await getDiffStatsBetweenRefs(repoPath, baseBranch, headBranch);
      stats = {
        additions: diffStats.additions,
        deletions: diffStats.deletions,
      };
      usesCommittedDiff = true;
      committedDiffRef = { base: baseBranch, head: headBranch };
    } else {
      const baseExists = await refExists(repoPath, baseBranch);
      if (!baseExists) {
        // First commit without base: evaluate as root diff
        const rootFiles = await getChangedFilesFromRoot(repoPath);
        if (rootFiles.length > 0) {
          changedFiles = rootFiles
            .map((file: string) => normalizePathForMatch(file))
            .filter((file: string) => file.length > 0);
          const rootStats = await getDiffStatsFromRoot(repoPath);
          stats = {
            additions: rootStats.additions,
            deletions: rootStats.deletions,
          };
          usesCommittedDiff = true;
          usesRootDiff = true;
        }
      }
    }
  }
  const shouldAllowLockfiles =
    includesInstallCommand(commands) ||
    touchesPackageManifest(changedFiles) ||
    allowLockfileOutsidePaths;
  const lockfilePaths = shouldAllowLockfiles ? await detectLockfilePaths(repoPath) : [];
  const effectiveAllowedPaths =
    lockfilePaths.length > 0 ? mergeAllowedPaths(allowedPaths, lockfilePaths) : allowedPaths;
  const finalAllowedPaths = allowEnvExampleOutsidePaths
    ? mergeAllowedPaths(effectiveAllowedPaths, ENV_EXAMPLE_PATHS)
    : effectiveAllowedPaths;
  const generatedPathPatterns = await resolveGeneratedPathPatterns(repoPath);
  // Exclude artifacts to build policy-check target
  const relevantFiles = [];
  let filteredGeneratedCount = 0;
  for (const file of changedFiles) {
    if (isGeneratedPathWithPatterns(file, generatedPathPatterns)) {
      filteredGeneratedCount += 1;
      continue;
    }
    if (await isGeneratedTypeScriptOutput(file, repoPath)) {
      continue;
    }
    relevantFiles.push(file);
  }
  console.log(`Changed files: ${changedFiles.length}`);
  if (filteredGeneratedCount > 0) {
    console.log(`Filtered generated files: ${filteredGeneratedCount}`);
  }
  console.log(`Relevant files: ${relevantFiles.length}`);
  const isDocOnlyChange =
    relevantFiles.length > 0 && relevantFiles.every((file) => isDocumentationFile(file));

  if (changedFiles.length === 0 && !allowNoChanges) {
    return {
      success: false,
      commandResults: [],
      policyViolations: [],
      changedFiles: [],
      stats: { additions: 0, deletions: 0 },
      failureCode: FAILURE_CODE.NO_ACTIONABLE_CHANGES,
      error: "No changes were made",
    };
  }

  if (relevantFiles.length === 0 && !allowNoChanges) {
    return {
      success: false,
      commandResults: [],
      policyViolations: [],
      changedFiles: [],
      stats: { additions: 0, deletions: 0 },
      failureCode: FAILURE_CODE.NO_ACTIONABLE_CHANGES,
      error: "No relevant changes were made",
    };
  }

  // Get change stats
  if (!usesCommittedDiff) {
    if (filteredGeneratedCount > 0) {
      // Use only actual changes for stats even when artifacts are numerous
      stats = await getChangeStatsForFiles(repoPath, relevantFiles);
    } else {
      stats = await getChangeStats(repoPath);
    }
  }
  console.log(`Changes: +${stats.additions} -${stats.deletions}`);

  // Check policy violations
  const policyViolations = checkPolicyViolations(relevantFiles, stats, finalAllowedPaths, policy);

  if (policyViolations.length > 0) {
    console.error("Policy violations found:");
    for (const violation of policyViolations) {
      console.error(`  - ${violation}`);
    }

    return {
      success: false,
      commandResults: [],
      policyViolations,
      changedFiles: relevantFiles,
      stats,
      failureCode: FAILURE_CODE.POLICY_VIOLATION,
      error: `Policy violations: ${policyViolations.join(", ")}`,
    };
  }

  const buildLightCheckResult = (message: string, success = true): CommandResult => {
    return {
      command: "llm:light-check",
      source: "light-check",
      success,
      outcome: success ? "passed" : "failed",
      stdout: message,
      stderr: "",
      durationMs: 0,
    };
  };

  const isLightCheckStrict =
    (process.env.WORKER_LIGHT_CHECK_MODE ?? "llm").toLowerCase() === "strict";

  // Fall back to LLM light check when no verification commands
  const runLightCheck = async (): Promise<CommandResult> => {
    const mode = (process.env.WORKER_LIGHT_CHECK_MODE ?? "llm").toLowerCase();
    if (mode === "off" || mode === "skip") {
      return buildLightCheckResult("Light check is disabled.");
    }

    // Align diff with the source of changes
    const diffResult = committedDiffRef
      ? await getDiffBetweenRefs(repoPath, committedDiffRef.base, committedDiffRef.head)
      : usesRootDiff
        ? await getDiffFromRoot(repoPath)
        : await getWorkingTreeDiff(repoPath);
    const maxChars = Number.parseInt(process.env.WORKER_LIGHT_CHECK_MAX_CHARS ?? "12000", 10);
    const clippedDiff = diffResult.success ? diffResult.stdout.slice(0, Math.max(0, maxChars)) : "";
    const prompt = `
You are responsible for a lightweight code-change sanity check.
Review the changes below and only flag potentially serious issues.
Do not call tools. Use only the information provided here.
Return JSON only.

## Changed Files
${changedFiles.map((file: string) => `- ${file}`).join("\n")}

## Diff Stats
- additions: ${stats.additions}
- deletions: ${stats.deletions}

## Diff Excerpt
${clippedDiff || "(diff unavailable)"}

## Output Format
\`\`\`json
{
  "verdict": "pass" | "warn",
  "summary": "Short summary",
  "concerns": ["List concerns, or [] if none"]
}
\`\`\`
`.trim();
    try {
      const env = await buildOpenCodeEnv(repoPath);
      const model =
        process.env.WORKER_LIGHT_CHECK_MODEL ??
        process.env.WORKER_MODEL ??
        process.env.OPENCODE_MODEL ??
        "google/gemini-3-flash-preview";
      const timeoutSeconds = Number.parseInt(
        process.env.WORKER_LIGHT_CHECK_TIMEOUT_SECONDS ?? "120",
        10,
      );
      const result = await runOpenCode({
        workdir: repoPath,
        task: prompt,
        model,
        timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : 120,
        env,
        inheritEnv: false,
      });
      const raw = result.stdout ?? "";
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/\{[\s\S]*\}/);
      const payload = jsonMatch?.[1] ?? jsonMatch?.[0];
      if (!payload) {
        return buildLightCheckResult("Failed to parse light-check response.", !isLightCheckStrict);
      }
      const parsed = JSON.parse(payload) as {
        verdict?: "pass" | "warn";
        summary?: string;
        concerns?: string[];
      };
      const verdict = parsed.verdict ?? "warn";
      const summary = parsed.summary ?? "Light-check summary was not provided.";
      const concerns = Array.isArray(parsed.concerns) ? parsed.concerns.join(" / ") : "";
      const message = concerns ? `${summary}\nConcerns: ${concerns}` : summary;
      if (verdict === "warn" && isLightCheckStrict) {
        return buildLightCheckResult(message, false);
      }
      return buildLightCheckResult(message);
    } catch (error) {
      return buildLightCheckResult(
        `Light check failed, but processing will continue: ${String(error)}`,
        !isLightCheckStrict,
      );
    }
  };

  // Run verification commands
  const commandResults: CommandResult[] = [];
  let allPassed = true;
  let ranEffectiveCommand = false;
  let ranExplicitEffectiveCommand = false;
  let failureCode: VerifyFailureCode | undefined;
  let failedCommand: string | undefined;
  let failedCommandSource: VerificationCommandSource | undefined;
  let failedCommandStderr: string | undefined;
  const rawAutoCommands = await resolveAutoVerificationCommands({
    repoPath,
    changedFiles: relevantFiles,
    explicitCommands: commands,
    deniedCommands: policy.deniedCommands ?? [],
  });
  const autoCommands = await filterUnsupportedAutoCommands(repoPath, rawAutoCommands);
  const singleChangedPackageDir = await resolveSingleChangedPackageDir(repoPath, relevantFiles);
  const singleChangedPackageLabel = singleChangedPackageDir
    ? normalizePathForMatch(relative(repoPath, singleChangedPackageDir)) || "."
    : undefined;
  if (singleChangedPackageLabel) {
    console.log(`[Verify] Auto command package scope candidate: ${singleChangedPackageLabel}`);
  }
  if (autoCommands.length > 0) {
    console.log(`[Verify] Auto verification commands added: ${autoCommands.join(", ")}`);
  }
  const baseVerificationCommands: VerificationCommandInput[] = [
    ...commands.map((command) => ({ command, source: "explicit" as const })),
    ...autoCommands.map((command) => ({ command, source: "auto" as const })),
  ];
  const verificationCommands = expandVerificationCommandsWithCwd(
    baseVerificationCommands,
    repoPath,
  );

  if (verificationCommands.length === 0) {
    const lightCheckResult = await runLightCheck();
    commandResults.push(lightCheckResult);
    allPassed = lightCheckResult.success;
    if (!allPassed) {
      failureCode = FAILURE_CODE.VERIFICATION_COMMAND_FAILED;
      failedCommand = lightCheckResult.command;
      failedCommandSource = lightCheckResult.source ?? "light-check";
      failedCommandStderr = lightCheckResult.stderr;
    }
    return {
      success: allPassed,
      commandResults,
      policyViolations: [],
      changedFiles: relevantFiles,
      stats,
      failureCode,
      failedCommand,
      failedCommandSource,
      failedCommandStderr,
      error: allPassed
        ? undefined
        : formatVerificationFailureError({
            command: failedCommand,
            source: failedCommandSource,
            stderr: failedCommandStderr,
          }),
    };
  }

  for (let index = 0; index < verificationCommands.length; index += 1) {
    const verificationCommand = verificationCommands[index];
    if (!verificationCommand) {
      continue;
    }
    const { command, source, cwd } = verificationCommand;
    const deniedMatch = matchDeniedCommand(command, policy.deniedCommands ?? []);
    if (deniedMatch) {
      const message = `Denied command detected: ${command} (matched: ${deniedMatch})`;
      console.error(`  ✗ ${message}`);
      commandResults.push({
        command,
        source,
        success: false,
        outcome: "failed",
        stdout: "",
        stderr: message,
        durationMs: 0,
      });
      failedCommand = command;
      failedCommandSource = source;
      failedCommandStderr = message;
      failureCode = FAILURE_CODE.POLICY_VIOLATION;
      allPassed = false;
      break;
    }

    const normalizedCommand = normalizeVerificationCommand(command);
    if (normalizedCommand !== command) {
      console.log(`Normalized verification command: ${command} -> ${normalizedCommand}`);
    }

    const cwdLabel = normalizePathForMatch(relative(repoPath, cwd)) || ".";
    console.log(
      cwdLabel === "."
        ? `Running: ${normalizedCommand}`
        : `Running: ${normalizedCommand} (cwd: ${cwdLabel})`,
    );
    const result = await runCommand(normalizedCommand, cwd);
    commandResults.push({
      ...result,
      source,
    });

    if (result.success && result.outcome === "passed") {
      ranEffectiveCommand = true;
      if (source === "explicit") {
        ranExplicitEffectiveCommand = true;
      }
      console.log(`  ✓ Passed (${Math.round(result.durationMs / 1000)}s)`);
    } else {
      let output = resolveCommandOutput(result.stderr, result.stdout);
      if (source === "auto" && singleChangedPackageDir && singleChangedPackageLabel) {
        console.warn(
          `[Verify] Retrying failed auto command within package scope (${singleChangedPackageLabel}): ${normalizedCommand}`,
        );
        const scopedResult = await runCommand(normalizedCommand, singleChangedPackageDir);
        if (scopedResult.success && scopedResult.outcome === "passed") {
          ranEffectiveCommand = true;
          console.log(
            `  ✓ Passed in package scope (${Math.round(scopedResult.durationMs / 1000)}s)`,
          );
          commandResults[commandResults.length - 1] = {
            ...scopedResult,
            source,
          };
          continue;
        }
        const scopedOutput = resolveCommandOutput(scopedResult.stderr, scopedResult.stdout);
        output = `${output}\n[package-scope:${singleChangedPackageLabel}] ${scopedOutput}`.trim();
      }

      const hasRemainingCommands = index < verificationCommands.length - 1;
      const isNoOpChange = changedFiles.length === 0 || relevantFiles.length === 0;
      if (
        shouldSkipExplicitCommandFailure({
          source,
          command: normalizedCommand,
          output,
          hasRemainingCommands,
          hasPriorEffectiveCommand: ranEffectiveCommand,
          isDocOnlyChange,
          isNoOpChange,
        })
      ) {
        console.warn(
          `[Verify] Skipping explicit command failure and continuing: ${normalizedCommand}`,
        );
        commandResults[commandResults.length - 1] = {
          ...result,
          source,
          success: true,
          outcome: "skipped",
          stderr: output,
        };
        continue;
      }
      if (
        shouldSkipAutoCommandFailure({
          source,
          command: normalizedCommand,
          output,
          hasRemainingCommands,
          hasPriorEffectiveCommand: ranEffectiveCommand,
          hasPriorExplicitCommandPass: ranExplicitEffectiveCommand,
          isDocOnlyChange,
          isNoOpChange,
        })
      ) {
        console.warn(`[Verify] Skipping auto command failure and continuing: ${normalizedCommand}`);
        commandResults[commandResults.length - 1] = {
          ...result,
          source,
          success: true,
          outcome: "skipped",
          stderr: output,
        };
        continue;
      }

      if (
        shouldAttemptInlineCommandRecovery({
          source,
          command: normalizedCommand,
          output,
          hasRemainingCommands,
        })
      ) {
        const inlineRecovery = await attemptInlineCommandRecovery({
          repoPath,
          source,
          failedCommand: normalizedCommand,
          output,
          failedCommandCwd: cwd,
          singleChangedPackageDir,
          deniedCommands: policy.deniedCommands ?? [],
        });
        if (inlineRecovery.attempted) {
          commandResults.push(...inlineRecovery.attemptResults);
          output = `${output}\n[inline-recovery] ${inlineRecovery.summary}`.trim();
        }
        if (inlineRecovery.recovered) {
          console.warn(`[Verify] ${inlineRecovery.summary}`);
          commandResults[commandResults.length - (inlineRecovery.attemptResults.length + 1)] = {
            ...result,
            source,
            success: true,
            outcome: "skipped",
            stderr: output,
          };
          ranEffectiveCommand = true;
          if (source === "explicit") {
            ranExplicitEffectiveCommand = true;
          }
          continue;
        }
      }

      if (result.outcome === "skipped") {
        console.error(`  ✗ Skipped (treated as failure)`);
      } else {
        console.error(`  ✗ Failed`);
      }
      ranEffectiveCommand = true;
      console.error(`  stderr: ${output.slice(0, 500)}`);
      failedCommand = normalizedCommand;
      failedCommandSource = source;
      failedCommandStderr = output;
      failureCode = resolveVerificationCommandFailureCode({
        verificationCommands,
        index,
        command: normalizedCommand,
        output,
      });
      allPassed = false;
      break; // Stop on first failure
    }
  }

  if (allPassed && !ranEffectiveCommand) {
    const allowLightCheckForCodeChanges =
      (process.env.WORKER_ALLOW_LIGHT_CHECK_FOR_CODE_CHANGES ?? "false").toLowerCase() === "true";

    if (allowLightCheckForCodeChanges || isDocOnlyChange) {
      const lightCheck = await runLightCheck();
      commandResults.push(lightCheck);
      allPassed = lightCheck.success;
      if (!lightCheck.success) {
        failureCode = FAILURE_CODE.VERIFICATION_COMMAND_FAILED;
        failedCommand = lightCheck.command;
        failedCommandSource = lightCheck.source ?? "light-check";
        failedCommandStderr = lightCheck.stderr;
      }
    } else {
      const message = "No executable verification commands were run for non-documentation changes.";
      commandResults.push({
        command: "verify:guard",
        source: "guard",
        success: false,
        outcome: "failed",
        stdout: "",
        stderr: message,
        durationMs: 0,
      });
      failedCommand = "verify:guard";
      failedCommandSource = "guard";
      failedCommandStderr = message;
      failureCode = FAILURE_CODE.VERIFICATION_COMMAND_FAILED;
      allPassed = false;
    }
  }

  return {
    success: allPassed,
    commandResults,
    policyViolations: [],
    changedFiles: relevantFiles,
    stats,
    failureCode,
    failedCommand,
    failedCommandSource,
    failedCommandStderr,
    error: allPassed
      ? undefined
      : formatVerificationFailureError({
          command: failedCommand,
          source: failedCommandSource,
          stderr: failedCommandStderr,
        }),
  };
}
