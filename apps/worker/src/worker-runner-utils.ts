import { checkoutBranch, getCurrentBranch } from "@openTiger/vcs";
import { FAILURE_CODE } from "@openTiger/core";
import type { VerifyResult } from "./steps/index";
import type { VerificationCommandSource } from "./steps/verify/types";
import { sanitizeRetryHint } from "./worker-task-helpers";

function isClaudeExecutorValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "claude_code" || normalized === "claudecode" || normalized === "claude-code"
  );
}

function isCodexExecutorValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "codex" || normalized === "codex-cli" || normalized === "codex_cli";
}

export function getRuntimeExecutorDisplayName(): string {
  if (isClaudeExecutorValue(process.env.LLM_EXECUTOR)) {
    return "Claude Code";
  }
  if (isCodexExecutorValue(process.env.LLM_EXECUTOR)) {
    return "Codex";
  }
  return "OpenCode";
}

export function isExecutionTimeout(stderr: string, exitCode: number): boolean {
  return (
    exitCode === -1 &&
    (stderr.includes("[OpenCode] Timeout exceeded") ||
      stderr.includes("[ClaudeCode] Timeout exceeded") ||
      stderr.includes("[Codex] Timeout exceeded"))
  );
}

export function parseRecoveryAttempts(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, parsed);
}

export function summarizeVerificationFailure(stderr: string | undefined, maxChars = 400): string {
  const normalized = sanitizeRetryHint(stderr ?? "");
  if (!normalized) {
    return "stderr unavailable";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}

export function shouldAttemptVerifyRecovery(
  verifyResult: VerifyResult,
  allowExplicitRecovery: boolean,
): boolean {
  if (verifyResult.success || verifyResult.policyViolations.length > 0) {
    return false;
  }
  if (verifyResult.failureCode === FAILURE_CODE.SETUP_OR_BOOTSTRAP_ISSUE) {
    return false;
  }
  const failedCommand = verifyResult.failedCommand?.trim();
  if (!failedCommand) {
    return false;
  }
  const source = verifyResult.failedCommandSource ?? "explicit";
  if (source === "auto") {
    return true;
  }
  if (!allowExplicitRecovery) {
    return false;
  }
  return source === "explicit" || source === "light-check" || source === "guard";
}

export function buildVerifyRecoveryHint(params: {
  verifyResult: VerifyResult;
  attempt: number;
  maxAttempts: number;
}): string {
  const command = params.verifyResult.failedCommand ?? "(unknown command)";
  const sourceLabel = params.verifyResult.failedCommandSource
    ? ` [${params.verifyResult.failedCommandSource}]`
    : "";
  const stderrSummary = summarizeVerificationFailure(params.verifyResult.failedCommandStderr);
  return (
    `Prioritize recovery for verification failure (${params.attempt}/${params.maxAttempts}): ` +
    `${command}${sourceLabel} failed. ` +
    `stderr: ${stderrSummary}. ` +
    "Apply the smallest possible fix to make the failed command pass."
  );
}

export function encodeVerifyReworkMarker(payload: {
  failedCommand: string;
  failedCommandSource?: VerificationCommandSource;
  stderrSummary: string;
}): string {
  const encoded = encodeURIComponent(
    JSON.stringify({
      failedCommand: payload.failedCommand,
      failedCommandSource: payload.failedCommandSource ?? "explicit",
      stderrSummary: payload.stderrSummary,
    }),
  );
  return `[verify-rework-json]${encoded}`;
}

export function appendContextNotes(existingNotes: string | undefined, lines: string[]): string {
  const base = existingNotes?.trim();
  const additions = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  if (!base) {
    return additions;
  }
  if (!additions) {
    return base;
  }
  return `${base}\n${additions}`;
}

export async function restoreExpectedBranchContext(
  repoPath: string,
  expectedBranch: string,
  executorDisplayName: string,
): Promise<void> {
  const currentBranch = await getCurrentBranch(repoPath);
  if (currentBranch === expectedBranch) {
    return;
  }
  console.warn(
    `[Worker] Branch drift detected after ${executorDisplayName} execution: current=${currentBranch ?? "unknown"}, expected=${expectedBranch}`,
  );
  let restoreBranchResult = await checkoutBranch(repoPath, expectedBranch);
  if (!restoreBranchResult.success) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    restoreBranchResult = await checkoutBranch(repoPath, expectedBranch);
  }
  if (!restoreBranchResult.success) {
    throw new Error(
      `Failed to restore expected branch ${expectedBranch}: ${restoreBranchResult.stderr}`,
    );
  }
  console.log(`[Worker] Restored branch context to ${expectedBranch}`);
}

export function isConflictAutoFixTaskTitle(title: string): boolean {
  return /^\[AutoFix-Conflict\]\s+PR\s+#\d+/i.test(title.trim());
}

export function buildGitHubPrUrl(repoUrl: string, prNumber: number): string | undefined {
  try {
    const normalizedRepoUrl = repoUrl.startsWith("git@github.com:")
      ? repoUrl.replace("git@github.com:", "https://github.com/")
      : repoUrl;
    const parsed = new URL(normalizedRepoUrl);
    if (!parsed.hostname.toLowerCase().includes("github.com")) {
      return undefined;
    }
    const parts = parsed.pathname.split("/").filter((segment) => segment.length > 0);
    const owner = parts[0];
    const repo = parts[1]?.replace(/\.git$/i, "");
    if (!owner || !repo) {
      return undefined;
    }
    return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  } catch {
    return undefined;
  }
}
