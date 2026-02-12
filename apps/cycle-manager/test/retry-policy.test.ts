import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_RETRY_ENV = process.env.FAILED_TASK_MAX_RETRY_COUNT;

afterEach(() => {
  if (ORIGINAL_RETRY_ENV === undefined) {
    delete process.env.FAILED_TASK_MAX_RETRY_COUNT;
  } else {
    process.env.FAILED_TASK_MAX_RETRY_COUNT = ORIGINAL_RETRY_ENV;
  }
  vi.resetModules();
});

describe("retry policy", () => {
  it("keeps category retry limits when global limit is disabled", async () => {
    process.env.FAILED_TASK_MAX_RETRY_COUNT = "-1";
    const module = await import("../src/cleaners/cleanup-retry/retry-policy");

    expect(module.resolveCategoryRetryLimit("model")).toBe(2);
    expect(module.resolveCategoryRetryLimit("flaky")).toBe(6);
    expect(module.resolveCategoryRetryLimit("permission")).toBe(0);
  });

  it("caps category limits by global retry limit when provided", async () => {
    process.env.FAILED_TASK_MAX_RETRY_COUNT = "1";
    const module = await import("../src/cleaners/cleanup-retry/retry-policy");

    expect(module.resolveCategoryRetryLimit("model")).toBe(1);
    expect(module.resolveCategoryRetryLimit("flaky")).toBe(1);
    expect(module.resolveCategoryRetryLimit("permission")).toBe(0);
  });
});
