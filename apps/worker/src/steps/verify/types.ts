import type { Policy } from "@openTiger/core";

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

export interface CommandResult {
  command: string;
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
  error?: string;
}
