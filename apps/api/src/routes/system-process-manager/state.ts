import type { ProcessInfo, ProcessRuntime } from "./types";

// Shared process state across routes
export const managedProcesses = new Map<string, ProcessRuntime>();
export const processStartPromises = new Map<string, Promise<ProcessInfo>>();
export const processStartLocks = new Set<string>();
