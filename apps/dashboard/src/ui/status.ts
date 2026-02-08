import type { TaskRetryInfo } from "../lib/api";

export function getTaskStatusColor(status: string): string {
  switch (status) {
    case "done":
      return "text-term-tiger";
    case "running":
      return "text-blue-400 animate-pulse";
    case "failed":
      return "text-red-500";
    case "blocked":
      return "text-yellow-500";
    default:
      return "text-zinc-500";
  }
}

export function getRunStatusColor(status: string): string {
  switch (status) {
    case "success":
      return "text-term-tiger";
    case "failed":
      return "text-red-500";
    case "running":
      return "text-blue-400 animate-pulse";
    default:
      return "text-zinc-500";
  }
}

export function getCiStatusColor(status: string): string {
  switch (status) {
    case "success":
      return "text-term-tiger";
    case "failure":
    case "error":
      return "text-red-500";
    case "pending":
      return "text-yellow-500";
    default:
      return "text-zinc-500";
  }
}

export function getTaskRiskColor(risk: string): string {
  switch (risk) {
    case "high":
      return "text-red-500 font-bold";
    case "medium":
      return "text-yellow-500";
    default:
      return "text-term-tiger";
  }
}

export function formatTaskRetryStatus(
  retry: TaskRetryInfo | null | undefined,
  nowMs: number,
): string {
  if (!retry) {
    return "--";
  }

  if (!retry.autoRetry) {
    switch (retry.reason) {
      case "retry_exhausted":
        return "exhausted";
      case "non_retryable_failure":
        return retry.failureCategory ? `no-retry(${retry.failureCategory})` : "no-retry";
      default:
        return "no-auto-retry";
    }
  }

  if (!retry.retryAt) {
    return "pending";
  }

  const retryAtMs = new Date(retry.retryAt).getTime();
  const seconds = Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000));
  if (retry.reason === "quota_wait") {
    return seconds > 0 ? `quota ${seconds}s` : "quota due";
  }
  if (retry.reason === "awaiting_judge") {
    return seconds > 0 ? `judge ${seconds}s` : "judge due";
  }
  if (retry.reason === "needs_rework") {
    return seconds > 0 ? `rework ${seconds}s` : "rework due";
  }
  return seconds > 0 ? `${seconds}s` : "due";
}

export function formatQuotaWaitRetryStatus(
  retry: TaskRetryInfo | null | undefined,
  nowMs: number,
): string {
  if (!retry || !retry.autoRetry) {
    return "quota pending";
  }

  if (!retry.retryAt) {
    return "quota pending";
  }

  const retryAtMs = new Date(retry.retryAt).getTime();
  const seconds = Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000));
  return seconds > 0 ? `quota ${seconds}s` : "quota due";
}

export function isWaitingRetryStatus(status: string): boolean {
  return (
    status === "pending" ||
    status === "quota pending" ||
    status === "quota due" ||
    /^\d+s$/.test(status) ||
    /^quota \d+s$/.test(status)
  );
}
