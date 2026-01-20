import { describe, it, expect } from "vitest";
import {
  RunSchema,
  RunStatus,
  StartRunInput,
  CompleteRunInput,
} from "../../src/domain/run.js";

describe("RunStatus", () => {
  it("すべての有効なステータスを受け入れる", () => {
    const statuses = ["running", "success", "failed", "cancelled"];
    for (const status of statuses) {
      expect(RunStatus.safeParse(status).success).toBe(true);
    }
  });

  it("無効なステータスを拒否する", () => {
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

  it("有効な実行記録を検証できる", () => {
    const result = RunSchema.safeParse(validRun);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe("worker-1");
      expect(result.data.status).toBe("running");
    }
  });

  it("完了した実行記録を検証できる", () => {
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

  it("失敗した実行記録にエラーメッセージを含められる", () => {
    const failedRun = {
      ...validRun,
      status: "failed" as const,
      finishedAt: new Date(),
      errorMessage: "タイムアウト: 60分を超過",
    };

    const result = RunSchema.safeParse(failedRun);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorMessage).toBe("タイムアウト: 60分を超過");
    }
  });

  it("負のトークン数を拒否する", () => {
    const invalidRun = { ...validRun, costTokens: -100 };
    const result = RunSchema.safeParse(invalidRun);
    expect(result.success).toBe(false);
  });

  it("無効なUUIDを拒否する", () => {
    const invalidRun = { ...validRun, taskId: "not-a-uuid" };
    const result = RunSchema.safeParse(invalidRun);
    expect(result.success).toBe(false);
  });
});

describe("StartRunInput", () => {
  it("有効な開始入力を検証できる", () => {
    const input = {
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      agentId: "worker-1",
    };
    const result = StartRunInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("taskIdが必須", () => {
    const input = { agentId: "worker-1" };
    const result = StartRunInput.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("agentIdが必須", () => {
    const input = { taskId: "550e8400-e29b-41d4-a716-446655440000" };
    const result = StartRunInput.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("CompleteRunInput", () => {
  it("成功完了を検証できる", () => {
    const input = {
      status: "success" as const,
      costTokens: 10000,
    };
    const result = CompleteRunInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("失敗完了にエラーメッセージを含められる", () => {
    const input = {
      status: "failed" as const,
      errorMessage: "コンパイルエラー",
    };
    const result = CompleteRunInput.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorMessage).toBe("コンパイルエラー");
    }
  });

  it("キャンセル完了を検証できる", () => {
    const input = { status: "cancelled" as const };
    const result = CompleteRunInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("runningステータスは完了入力として無効", () => {
    const input = { status: "running" };
    const result = CompleteRunInput.safeParse(input);
    expect(result.success).toBe(false);
  });
});
