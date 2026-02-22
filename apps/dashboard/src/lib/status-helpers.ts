import type { SystemProcess } from "./api";

export const HOSTINFO_CACHE_KEY = "opentiger:hostinfo";

export function getHostinfoFromStorage(): string {
  try {
    return localStorage.getItem(HOSTINFO_CACHE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setHostinfoToStorage(output: string): void {
  try {
    if (output) {
      localStorage.setItem(HOSTINFO_CACHE_KEY, output);
    } else {
      localStorage.removeItem(HOSTINFO_CACHE_KEY);
    }
  } catch {
    // ignore
  }
}

export const STATUS_LABELS: Record<SystemProcess["status"], string> = {
  idle: "IDLE",
  running: "RUNNING",
  completed: "DONE",
  failed: "FAILED",
  stopped: "STOPPED",
};

export const STATUS_COLORS: Record<SystemProcess["status"], string> = {
  idle: "text-zinc-500",
  running: "text-term-tiger animate-pulse",
  completed: "text-zinc-300",
  failed: "text-red-500",
  stopped: "text-yellow-500",
};

export type ExecutionEnvironment = "host" | "sandbox";

export function normalizeExecutionEnvironment(value: string | undefined): ExecutionEnvironment {
  return value?.trim().toLowerCase() === "sandbox" ? "sandbox" : "host";
}

export function parseCount(
  value: string | undefined,
  fallback: number,
  label?: string,
  max?: number,
): { count: number; warning?: string } {
  const parsed = value ? parseInt(value, 10) : NaN;
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  const base = Math.max(0, normalized);
  if (typeof max !== "number") {
    return { count: base };
  }
  const clamped = Math.min(base, max);
  if (base > max) {
    return { count: clamped, warning: `${label ?? "Count"} max limit ${max}` };
  }
  return { count: clamped };
}
