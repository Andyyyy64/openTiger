import { resolveFailureCategoryRetryLimit } from "@openTiger/core";
import type { FailureCategory } from "./types";

// Max retry count (-1 = rely on category limits)
const MAX_RETRY_COUNT = (() => {
  const parsed = Number.parseInt(process.env.FAILED_TASK_MAX_RETRY_COUNT ?? "-1", 10);
  return Number.isFinite(parsed) ? parsed : -1;
})();

function isUnlimitedRetry(): boolean {
  return MAX_RETRY_COUNT < 0;
}

export function isRetryAllowed(retryCount: number): boolean {
  return isUnlimitedRetry() || retryCount < MAX_RETRY_COUNT;
}

export function resolveCategoryRetryLimit(category: FailureCategory): number {
  return resolveFailureCategoryRetryLimit(category, MAX_RETRY_COUNT);
}

export function isCategoryRetryAllowed(retryCount: number, categoryRetryLimit: number): boolean {
  return categoryRetryLimit < 0 || retryCount < categoryRetryLimit;
}

export function formatRetryLimitDisplay(categoryRetryLimit: number): string {
  return categoryRetryLimit < 0 ? "inf" : String(categoryRetryLimit);
}
