import { describe, it, expect } from "vitest";
import { RunSchema, RunStatus, StartRunInput, CompleteRunInput } from "../../src/domain/run";

describe("RunStatus", () => {
  it("accepts all valid statuses", () => {
    const statuses = ["running", "success", "failed", "cancelled"];
    for (const status of statuses) {
      expect(RunStatus.safeParse(status).success).toBe(true);
    }
  });

  it("rejects invalid statuses", () => {
    expect(RunStatus.safeParse("pending").success).toBe(false);
    expect(RunStatus.safeParse("done").success).toBe(false);
  });
});

describe("RunSchema", () => {
  const validRun = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    taskId: "550e8400-e29b-41d4-a716-446655440001",
    agentId: "worker-1",
    status: "running" as const,
    startedAt: new Date(),
    finishedAt: null,
    costTokens: null,
    logPath: null,
    errorMessage: null,
  };

  it("validates valid run record", () => {
    const result = RunSchema.safeParse(validRun);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe("worker-1");
      expect(result.data.status).toBe("running");
    }
  });

  it("validates completed run record", () => {
    const completedRun = {
      ...validRun,
      status: "success" as const,
      finishedAt: new Date(),
      costTokens: 15000,
      logPath: "/logs/run-123.log",
    };

    const result = RunSchema.safeParse(completedRun);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.costTokens).toBe(15000);
      expect(result.data.finishedAt).toBeDefined();
    }
  });

  it("includes error message in failed run record", () => {
    const failedRun = {
      ...validRun,
      status: "failed" as const,
      finishedAt: new Date(),
      errorMessage: "Timeout: exceeded 60 minutes",
    };

    const result = RunSchema.safeParse(failedRun);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorMessage).toBe("Timeout: exceeded 60 minutes");
    }
  });

  it("rejects negative token count", () => {
    const invalidRun = { ...validRun, costTokens: -100 };
    const result = RunSchema.safeParse(invalidRun);
    expect(result.success).toBe(false);
  });

  it("rejects invalid UUID", () => {
    const invalidRun = { ...validRun, taskId: "not-a-uuid" };
    const result = RunSchema.safeParse(invalidRun);
    expect(result.success).toBe(false);
  });
});

describe("StartRunInput", () => {
  it("validates valid start input", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      agentId: "worker-1",
    };
    const result = StartRunInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("requires taskId", () => {
    const input = { agentId: "worker-1" };
    const result = StartRunInput.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("requires agentId", () => {
    const input = { taskId: "550e8400-e29b-41d4-a716-446655440000" };
    const result = StartRunInput.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("CompleteRunInput", () => {
  it("validates success completion", () => {
    const input = {
      status: "success" as const,
      costTokens: 10000,
    };
    const result = CompleteRunInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("includes error message in failed completion", () => {
    const input = {
      status: "failed" as const,
      errorMessage: "Compilation error",
    };
    const result = CompleteRunInput.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorMessage).toBe("Compilation error");
    }
  });

  it("validates cancelled completion", () => {
    const input = { status: "cancelled" as const };
    const result = CompleteRunInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects running status as completion input", () => {
    const input = { status: "running" };
    const result = CompleteRunInput.safeParse(input);
    expect(result.success).toBe(false);
  });
});
