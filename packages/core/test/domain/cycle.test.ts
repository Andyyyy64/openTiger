import { describe, it, expect } from "vitest";
import {
  CycleSchema,
  CycleStatusSchema,
  CycleTriggerTypeSchema,
  CycleStatsSchema,
  StateSnapshotSchema,
  CycleConfigSchema,
  CycleEndEventSchema,
  AnomalyAlertSchema,
  NewCycleSchema,
} from "../../src/domain/cycle";

describe("CycleStatusSchema", () => {
  it("すべての有効なステータスを受け入れる", () => {
    const statuses = ["running", "completed", "aborted"];
    for (const status of statuses) {
      expect(CycleStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("無効なステータスを拒否する", () => {
    expect(CycleStatusSchema.safeParse("pending").success).toBe(false);
    expect(CycleStatusSchema.safeParse("paused").success).toBe(false);
  });
});

describe("CycleTriggerTypeSchema", () => {
  it("すべてのトリガータイプを受け入れる", () => {
    const types = ["time", "task_count", "failure_rate", "manual"];
    for (const type of types) {
      expect(CycleTriggerTypeSchema.safeParse(type).success).toBe(true);
    }
  });
});

describe("CycleStatsSchema", () => {
  it("完全な統計を検証できる", () => {
    const stats = {
      tasksCompleted: 50,
      tasksFailed: 5,
      tasksCancelled: 2,
      runsTotal: 60,
      totalTokens: 500000,
      prsCreated: 48,
      prsMerged: 45,
      prsRejected: 3,
      averageTaskDurationMs: 180000,
      peakConcurrentWorkers: 10,
    };

    const result = CycleStatsSchema.safeParse(stats);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasksCompleted).toBe(50);
      expect(result.data.prsMerged).toBe(45);
    }
  });

  it("デフォルト値が適用される", () => {
    const result = CycleStatsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasksCompleted).toBe(0);
      expect(result.data.tasksFailed).toBe(0);
      expect(result.data.totalTokens).toBe(0);
      expect(result.data.prsCreated).toBe(0);
      expect(result.data.peakConcurrentWorkers).toBe(0);
    }
  });
});

describe("StateSnapshotSchema", () => {
  it("有効なスナップショットを検証できる", () => {
    const snapshot = {
      pendingTaskCount: 100,
      runningTaskCount: 5,
      activeAgentCount: 5,
      queuedJobCount: 95,
      timestamp: new Date(),
    };

    const result = StateSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
  });

  it("文字列の日付を変換できる", () => {
    const snapshot = {
      pendingTaskCount: 100,
      runningTaskCount: 5,
      activeAgentCount: 5,
      queuedJobCount: 95,
      timestamp: "2025-01-20T12:00:00Z",
    };

    const result = StateSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timestamp).toBeInstanceOf(Date);
    }
  });
});

describe("CycleConfigSchema", () => {
  it("時間ベースの設定を検証できる", () => {
    const config = {
      maxDurationMs: 4 * 60 * 60 * 1000, // 4時間
    };

    const result = CycleConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxDurationMs).toBe(14400000);
    }
  });

  it("タスク数ベースの設定を検証できる", () => {
    const config = {
      maxTasksPerCycle: 100,
    };

    const result = CycleConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("失敗率ベースの設定を検証できる", () => {
    const config = {
      maxFailureRate: 0.2, // 20%
      minTasksForFailureCheck: 20,
    };

    const result = CycleConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxFailureRate).toBe(0.2);
    }
  });

  it("失敗率は0-1の範囲に制限される", () => {
    const invalidOver = { maxFailureRate: 1.5 };
    const invalidUnder = { maxFailureRate: -0.1 };

    expect(CycleConfigSchema.safeParse(invalidOver).success).toBe(false);
    expect(CycleConfigSchema.safeParse(invalidUnder).success).toBe(false);
  });

  it("デフォルト値が適用される", () => {
    const result = CycleConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cleanupOnEnd).toBe(true);
      expect(result.data.preserveTaskState).toBe(true);
      expect(result.data.statsIntervalMs).toBe(60000);
      expect(result.data.healthCheckIntervalMs).toBe(30000);
      expect(result.data.minTasksForFailureCheck).toBe(10);
    }
  });
});

describe("CycleSchema", () => {
  const validCycle = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    number: 5,
    status: "running" as const,
    startedAt: new Date(),
  };

  it("実行中のサイクルを検証できる", () => {
    const result = CycleSchema.safeParse(validCycle);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.number).toBe(5);
      expect(result.data.status).toBe("running");
    }
  });

  it("完了したサイクルを検証できる", () => {
    const completedCycle = {
      ...validCycle,
      status: "completed" as const,
      endedAt: new Date(),
      triggerType: "time" as const,
      endReason: "Maximum duration reached (4 hours)",
      stats: {
        tasksCompleted: 100,
        tasksFailed: 10,
        totalTokens: 1000000,
        prsCreated: 95,
        prsMerged: 90,
      },
    };

    const result = CycleSchema.safeParse(completedCycle);
    expect(result.success).toBe(true);
  });

  it("サイクル番号は正の整数が必須", () => {
    const invalidCycle = { ...validCycle, number: 0 };
    const result = CycleSchema.safeParse(invalidCycle);
    expect(result.success).toBe(false);
  });
});

describe("NewCycleSchema", () => {
  it("新しいサイクルを作成できる", () => {
    const newCycle = {
      number: 1,
    };

    const result = NewCycleSchema.safeParse(newCycle);
    expect(result.success).toBe(true);
  });

  it("状態スナップショット付きで作成できる", () => {
    const newCycle = {
      number: 2,
      stateSnapshot: {
        pendingTaskCount: 50,
        runningTaskCount: 0,
        activeAgentCount: 0,
        queuedJobCount: 50,
        timestamp: new Date(),
      },
    };

    const result = NewCycleSchema.safeParse(newCycle);
    expect(result.success).toBe(true);
  });
});

describe("CycleEndEventSchema", () => {
  it("サイクル終了イベントを検証できる", () => {
    const event = {
      cycleId: "550e8400-e29b-41d4-a716-446655440000",
      triggerType: "failure_rate" as const,
      reason: "Failure rate exceeded 20% (current: 25%)",
      stats: {
        tasksCompleted: 30,
        tasksFailed: 10,
        totalTokens: 400000,
      },
    };

    const result = CycleEndEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });
});

describe("AnomalyAlertSchema", () => {
  it("高失敗率アラートを検証できる", () => {
    const alert = {
      type: "high_failure_rate" as const,
      severity: "warning" as const,
      message: "Failure rate is 25%, threshold is 20%",
      details: { currentRate: 0.25, threshold: 0.2 },
      timestamp: new Date(),
    };

    const result = AnomalyAlertSchema.safeParse(alert);
    expect(result.success).toBe(true);
  });

  it("コストスパイクアラートを検証できる", () => {
    const alert = {
      type: "cost_spike" as const,
      severity: "critical" as const,
      message: "Token usage spike detected: 500% increase in last hour",
      timestamp: new Date(),
    };

    const result = AnomalyAlertSchema.safeParse(alert);
    expect(result.success).toBe(true);
  });

  it("すべてのアラートタイプを受け入れる", () => {
    const types = [
      "high_failure_rate",
      "cost_spike",
      "stuck_task",
      "no_progress",
      "memory_leak",
      "agent_timeout",
    ];

    for (const type of types) {
      const alert = {
        type,
        severity: "warning",
        message: "Test alert",
        timestamp: new Date(),
      };
      expect(AnomalyAlertSchema.safeParse(alert).success).toBe(true);
    }
  });

  it("無効な重大度を拒否する", () => {
    const alert = {
      type: "cost_spike" as const,
      severity: "info", // invalid
      message: "Test",
      timestamp: new Date(),
    };

    const result = AnomalyAlertSchema.safeParse(alert);
    expect(result.success).toBe(false);
  });
});
