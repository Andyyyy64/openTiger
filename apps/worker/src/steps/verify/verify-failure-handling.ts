import { FAILURE_CODE } from "@openTiger/core";
import { normalizePathForMatch } from "./paths";
import type { VerifyFailureCode, VerificationCommandSource } from "./types";
import type { VerificationCommand } from "./verify-command-context";
import { resolvePackageScopedRetryCommand } from "./verify-command-context";

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

export function isBootstrapLikeFailureOutput(output: string): boolean {
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

export function summarizeCommandError(stderr: string, maxChars = 300): string {
  const normalized = stderr.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "stderr unavailable";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

export function buildInlineExecuteFailureHint(
  stderr: string | undefined,
  error: string | undefined,
): string {
  const summary = summarizeCommandError(stderr || error || "", 300);
  return `Previous recovery execution itself failed: ${summary}. Adjust your approach to avoid the same execution failure.`;
}

export function formatVerificationFailureError(params: {
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

export function resolveCommandOutput(stderr: string, stdout: string): string {
  return stderr.trim().length > 0 ? stderr : stdout;
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
    const isWorkspaceRecursiveCommand = resolvePackageScopedRetryCommand(params.command) !== null;
    if (
      isWorkspaceRecursiveCommand &&
      params.hasPriorEffectiveCommand &&
      !params.hasRemainingCommands
    ) {
      return true;
    }
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
