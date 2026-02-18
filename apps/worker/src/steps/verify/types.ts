import type { Policy, VerificationFailureCode } from "@openTiger/core";

export type LlmInlineRecoveryHandler = (params: {
  failedCommand: string;
  source: VerificationCommandSource;
  stderr: string;
  previousExecuteFailureHint?: string;
  attempt: number;
  maxAttempts: number;
}) => Promise<{
  success: boolean;
  executeStderr?: string;
  executeError?: string;
}>;

export interface VerifyOptions {
  repoPath: string;
  commands: string[];
  allowedPaths: string[];
  policy: Policy;
  baseBranch?: string;
  headBranch?: string;
  allowLockfileOutsidePaths?: boolean;
  allowEnvExampleOutsidePaths?: boolean;
  allowNoChanges?: boolean;
  llmInlineRecoveryHandler?: LlmInlineRecoveryHandler;
}

export type VerificationCommandSource =
  | "explicit"
  | "auto"
  | "light-check"
  | "guard"
  | "visual-probe";

export type VerifyFailureCode = VerificationFailureCode;

export interface CommandResult {
  command: string;
  source?: VerificationCommandSource;
  success: boolean;
  outcome: "passed" | "failed" | "skipped";
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode?: number | null;
}

export interface VisualProbeMetrics {
  width: number;
  height: number;
  pixelCount: number;
  centerPixel: [number, number, number, number];
  clearRatio: number;
  nearBlackRatio: number;
  luminanceStdDev: number;
}

export interface VisualProbeResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  command: string;
  message: string;
  durationMs: number;
  exitCode: number | null;
  metrics?: VisualProbeMetrics;
  artifactPaths: string[];
}

export interface VerifyResult {
  success: boolean;
  commandResults: CommandResult[];
  visualProbeResults?: VisualProbeResult[];
  policyViolations: string[];
  changedFiles: string[];
  stats: { additions: number; deletions: number };
  failureCode?: VerifyFailureCode;
  failedCommand?: string;
  failedCommandSource?: VerificationCommandSource;
  failedCommandStderr?: string;
  error?: string;
}
