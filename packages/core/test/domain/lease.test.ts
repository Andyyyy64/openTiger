import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LeaseSchema,
  AcquireLeaseInput,
  isLeaseValid,
  getLeaseRemainingMs,
} from "../../src/domain/lease";

describe("LeaseSchema", () => {
  const validLease = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    taskId: "550e8400-e29b-41d4-a716-446655440001",
    agentId: "worker-1",
    expiresAt: new Date(Date.now() + 3600000), // 1時間後
    createdAt: new Date(),
  };

  it("有効なリースを検証できる", () => {
    const result = LeaseSchema.safeParse(validLease);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe("worker-1");
    }
  });

  it("無効なUUIDを拒否する", () => {
    const invalidLease = { ...validLease, taskId: "not-uuid" };
    const result = LeaseSchema.safeParse(invalidLease);
    expect(result.success).toBe(false);
  });

  it("expiresAtはDate型が必須", () => {
    const invalidLease = { ...validLease, expiresAt: "2025-01-20T00:00:00Z" };
    // Zodは文字列をDateに変換しないのでこれは失敗する
    const result = LeaseSchema.safeParse(invalidLease);
    expect(result.success).toBe(false);
  });
});

describe("AcquireLeaseInput", () => {
  it("有効な取得入力を検証できる", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      agentId: "worker-1",
      durationMinutes: 90,
    };
    const result = AcquireLeaseInput.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.durationMinutes).toBe(90);
    }
  });

  it("デフォルトの期間が適用される", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      agentId: "worker-1",
    };
    const result = AcquireLeaseInput.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.durationMinutes).toBe(60);
    }
  });

  it("0以下の期間を拒否する", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      agentId: "worker-1",
      durationMinutes: 0,
    };
    const result = AcquireLeaseInput.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("負の期間を拒否する", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      agentId: "worker-1",
      durationMinutes: -10,
    };
    const result = AcquireLeaseInput.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("isLeaseValid", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("有効期限内のリースはtrueを返す", () => {
    const now = new Date("2025-01-20T12:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T13:00:00Z"), // 1時間後
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(isLeaseValid(lease)).toBe(true);
  });

  it("有効期限切れのリースはfalseを返す", () => {
    const now = new Date("2025-01-20T14:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T13:00:00Z"), // 1時間前
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(isLeaseValid(lease)).toBe(false);
  });

  it("ちょうど有効期限の場合はfalseを返す", () => {
    const now = new Date("2025-01-20T13:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T13:00:00Z"), // 同じ時刻
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(isLeaseValid(lease)).toBe(false);
  });
});

describe("getLeaseRemainingMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("残り時間をミリ秒で返す", () => {
    const now = new Date("2025-01-20T12:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T12:30:00Z"), // 30分後
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(getLeaseRemainingMs(lease)).toBe(30 * 60 * 1000); // 30分
  });

  it("有効期限切れの場合は0を返す", () => {
    const now = new Date("2025-01-20T14:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T13:00:00Z"),
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(getLeaseRemainingMs(lease)).toBe(0);
  });

  it("負の値にはならない", () => {
    const now = new Date("2025-01-20T15:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T12:00:00Z"), // 3時間前
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(getLeaseRemainingMs(lease)).toBe(0);
    expect(getLeaseRemainingMs(lease)).toBeGreaterThanOrEqual(0);
  });
});
