import type { ProcessInfo, ProcessRuntime } from "./types";

// ルート間で共有するプロセス管理の状態
export const managedProcesses = new Map<string, ProcessRuntime>();
export const processStartPromises = new Map<string, Promise<ProcessInfo>>();
export const processStartLocks = new Set<string>();
