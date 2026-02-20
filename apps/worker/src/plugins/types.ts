import type { Task } from "@openTiger/core";
import type { WorkerResult } from "../worker-runner-types";

export interface WorkerTaskKindRunParams {
  task: Task;
  runId: string;
  agentId: string;
  workspacePath: string;
  model?: string;
  instructionsPath?: string;
}

export interface WorkerTaskKindPlugin {
  id: string;
  kind: string;
  resolveInstructionsPath?: (task: Task, fallbackPath?: string) => string | undefined;
  run: (params: WorkerTaskKindRunParams) => Promise<WorkerResult>;
}
