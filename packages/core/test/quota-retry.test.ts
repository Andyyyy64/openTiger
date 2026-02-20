import { describe, expect, it } from "vitest";
import { computeQuotaBackoff, parseQuotaRetryDelayMs } from "../src/quota-retry";

describe("quota-retry", () => {
  it("parses clock-based retry hints from provider errors", () => {
    const now = new Date(2026, 1, 20, 13, 41, 35);
    const delayMs = parseQuotaRetryDelayMs(
      "You've hit your usage limit. Try again at 1:50 PM.",
      now,
    );
    expect(delayMs).toBe(505_000);
  });

  it("rolls clock-based retry hints to next day when time already passed", () => {
    const now = new Date(2026, 1, 20, 13, 41, 35);
    const delayMs = parseQuotaRetryDelayMs(
      "You've hit your usage limit. Try again at 1:10 PM.",
      now,
    );
    expect(delayMs).toBe(84_505_000);
  });

  it("respects explicit retry time without adding jitter", () => {
    const backoff = computeQuotaBackoff({
      taskId: "task-1",
      retryCount: 0,
      baseDelayMs: 30_000,
      maxDelayMs: 30 * 60 * 1000,
      factor: 2,
      jitterRatio: 0.2,
      errorMessage: "You've hit your usage limit. Try again at 2:00 PM.",
      referenceDate: new Date(2026, 1, 20, 13, 0, 0),
    });
    expect(backoff.retryHintMs).toBe(3_600_000);
    expect(backoff.cooldownMs).toBe(3_600_000);
    expect(backoff.jitterMs).toBe(0);
  });
});
