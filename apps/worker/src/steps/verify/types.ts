import type { Policy, VerificationFailureCode } from "@openTiger/core";

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
}

export type VerificationCommandSource = "explicit" | "auto" | "light-check" | "guard";

export type VerifyFailureCode = VerificationFailureCode;

export interface CommandResult {
  command: string;
  source?: VerificationCommandSource;
  success: boolean;
  outcome: "passed" | "failed" | "skipped";
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface VerifyResult {
  success: boolean;
  commandResults: CommandResult[];
  policyViolations: string[];
  changedFiles: string[];
  stats: { additions: number; deletions: number };
  failureCode?: VerifyFailureCode;
  failedCommand?: string;
  failedCommandSource?: VerificationCommandSource;
  failedCommandStderr?: string;
  error?: string;
}
