import type { FailureCategory } from "./types";

// 最大リトライ回数（-1で無制限。上限超過時は再作業へ切り替えて復旧を止めない）
const MAX_RETRY_COUNT = (() => {
  const parsed = Number.parseInt(process.env.FAILED_TASK_MAX_RETRY_COUNT ?? "-1", 10);
  return Number.isFinite(parsed) ? parsed : -1;
})();

const CATEGORY_RETRY_LIMIT: Record<FailureCategory, number> = {
  env: 5,
  setup: 3,
  permission: 0,
  noop: 0,
  policy: 2,
  test: 2,
  flaky: 6,
  model: 2,
  model_loop: 1,
};

function isUnlimitedRetry(): boolean {
  return MAX_RETRY_COUNT < 0;
}

export function isRetryAllowed(retryCount: number): boolean {
  return isUnlimitedRetry() || retryCount < MAX_RETRY_COUNT;
}

export function resolveCategoryRetryLimit(category: FailureCategory): number {
  const categoryLimit = CATEGORY_RETRY_LIMIT[category];
  if (isUnlimitedRetry()) {
    // 無制限モードでも非リトライカテゴリは再作業へ切り替える判断材料として残す
    return categoryLimit <= 0 ? 0 : -1;
  }
  return Math.min(categoryLimit, MAX_RETRY_COUNT);
}

export function isCategoryRetryAllowed(retryCount: number, categoryRetryLimit: number): boolean {
  return categoryRetryLimit < 0 || retryCount < categoryRetryLimit;
}

export function formatRetryLimitDisplay(categoryRetryLimit: number): string {
  return categoryRetryLimit < 0 ? "inf" : String(categoryRetryLimit);
}
