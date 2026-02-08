import type { ChildProcess } from "node:child_process";
import type { ProcessInfo, ProcessRuntime, RestartStatus } from "./types";

// ルート間で共有するプロセス管理の状態
export const restartState: { process: ChildProcess | null; status: RestartStatus } = {
  process: null,
  status: { status: "idle" },
};

export const managedProcesses = new Map<string, ProcessRuntime>();
export const processStartPromises = new Map<string, Promise<ProcessInfo>>();
export const processStartLocks = new Set<string>();
