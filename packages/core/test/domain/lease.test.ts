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
    expiresAt: new Date(Date.now() + 3600000), // 1 hour later
    createdAt: new Date(),
  };

  it("validates valid lease", () => {
    const result = LeaseSchema.safeParse(validLease);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe("worker-1");
    }
  });

  it("rejects invalid UUID", () => {
    const invalidLease = { ...validLease, taskId: "not-uuid" };
    const result = LeaseSchema.safeParse(invalidLease);
    expect(result.success).toBe(false);
  });

  it("requires expiresAt as Date", () => {
    const invalidLease = { ...validLease, expiresAt: "2025-01-20T00:00:00Z" };
    // Zod does not coerce string to Date, so this fails
    const result = LeaseSchema.safeParse(invalidLease);
    expect(result.success).toBe(false);
  });
});

describe("AcquireLeaseInput", () => {
  it("validates valid acquire input", () => {
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

  it("applies default duration", () => {
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

  it("rejects duration <= 0", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      agentId: "worker-1",
      durationMinutes: 0,
    };
    const result = AcquireLeaseInput.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects negative duration", () => {
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

  it("returns true for lease within validity", () => {
    const now = new Date("2025-01-20T12:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T13:00:00Z"), // 1 hour later
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(isLeaseValid(lease)).toBe(true);
  });

  it("returns false for expired lease", () => {
    const now = new Date("2025-01-20T14:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T13:00:00Z"), // 1 hour ago
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(isLeaseValid(lease)).toBe(false);
  });

  it("returns false exactly at expiry", () => {
    const now = new Date("2025-01-20T13:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T13:00:00Z"), // same time
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

  it("returns remaining time in ms", () => {
    const now = new Date("2025-01-20T12:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T12:30:00Z"), // 30 min later
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(getLeaseRemainingMs(lease)).toBe(30 * 60 * 1000); // 30 min
  });

  it("returns 0 when expired", () => {
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

  it("never returns negative", () => {
    const now = new Date("2025-01-20T15:00:00Z");
    vi.setSystemTime(now);

    const lease = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      agentId: "worker-1",
      expiresAt: new Date("2025-01-20T12:00:00Z"), // 3 hours ago
      createdAt: new Date("2025-01-20T11:00:00Z"),
    };

    expect(getLeaseRemainingMs(lease)).toBe(0);
    expect(getLeaseRemainingMs(lease)).toBeGreaterThanOrEqual(0);
  });
});
