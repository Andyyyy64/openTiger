import type { ChildProcess } from "node:child_process";

export type ProcessStatus = "idle" | "running" | "completed" | "failed" | "stopped";
export type ProcessKind = "service" | "worker" | "planner" | "database" | "command";

export type ProcessInfo = {
  name: string;
  label: string;
  description: string;
  group: string;
  kind: ProcessKind;
  supportsStop: boolean;
  status: ProcessStatus;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  logPath?: string;
  message?: string;
  lastCommand?: string;
};

export type ProcessRuntime = {
  status: ProcessStatus;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath?: string;
  message?: string;
  lastCommand?: string;
  process?: ChildProcess | null;
  stopRequested?: boolean;
  lastPayload?: StartPayload;
  restartAttempts?: number;
  restartWindowStartedAt?: number;
  restartScheduled?: boolean;
  restartTimer?: ReturnType<typeof setTimeout>;
};

export type StartPayload = {
  requirementPath?: string;
  content?: string;
  researchJobId?: string;
};

export type StartCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type ProcessDefinition = {
  name: string;
  label: string;
  description: string;
  group: string;
  kind: ProcessKind;
  supportsStop: boolean;
  autoRestart?: boolean;
  buildStart: (payload: StartPayload) => Promise<StartCommand>;
};
