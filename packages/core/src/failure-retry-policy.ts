import type { FailureCategory } from "./failure-classifier";

export const FAILURE_CATEGORY_RETRY_LIMIT: Record<FailureCategory, number> = {
  env: 5,
  setup: 3,
  permission: 0,
  noop: 0,
  policy: 3,
  test: 3,
  flaky: 6,
  model: 3,
  model_loop: 1,
};

export function resolveFailureCategoryRetryLimit(
  category: FailureCategory,
  globalRetryLimit: number,
): number {
  const categoryLimit = FAILURE_CATEGORY_RETRY_LIMIT[category];
  if (globalRetryLimit < 0) {
    return categoryLimit;
  }
  return Math.min(categoryLimit, globalRetryLimit);
}
