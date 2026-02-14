import { describe, expect, it } from "vitest";
import {
  FAILURE_CATEGORY_RETRY_LIMIT,
  resolveFailureCategoryRetryLimit,
} from "../src/failure-retry-policy";

describe("failure-retry-policy", () => {
  it("uses category guardrails when global retry is unlimited", () => {
    expect(resolveFailureCategoryRetryLimit("model", -1)).toBe(FAILURE_CATEGORY_RETRY_LIMIT.model);
    expect(resolveFailureCategoryRetryLimit("permission", -1)).toBe(
      FAILURE_CATEGORY_RETRY_LIMIT.permission,
    );
  });

  it("caps by global retry limit when provided", () => {
    expect(resolveFailureCategoryRetryLimit("flaky", 2)).toBe(2);
    expect(resolveFailureCategoryRetryLimit("permission", 2)).toBe(0);
  });
});
