import type { Policy } from "@openTiger/core";

export interface WorkerConfig {
  agentId: string;
  role?: string;
  workspacePath: string;
  repoUrl: string;
  baseBranch?: string;
  instructionsPath?: string;
  model?: string;
  policy?: Policy;
  logPath?: string;
}

export interface WorkerResult {
  success: boolean;
  taskId: string;
  runId?: string;
  prUrl?: string;
  error?: string;
  costTokens?: number;
}
