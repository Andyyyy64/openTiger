import { describe, it, expect } from "vitest";
import {
  TaskSchema,
  CreateTaskInput,
  UpdateTaskInput,
  RiskLevel,
  TaskRole,
  TaskStatus,
  TaskContext,
} from "../../src/domain/task";

describe("TaskSchema", () => {
  const validTask = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    title: "ユーザー認証機能を実装",
    goal: "pnpm test --filter=@openTiger/auth が全て通過",
    context: {
      files: ["src/auth/login.ts", "src/auth/session.ts"],
      specs: "OAuth2.0を使用した認証",
      notes: "既存のDBスキーマを使用",
    },
    allowedPaths: ["src/auth/**", "tests/auth/**"],
    commands: ["pnpm test --filter=@openTiger/auth", "pnpm typecheck"],
    priority: 10,
    riskLevel: "medium" as const,
    role: "worker" as const,
    status: "queued" as const,
    dependencies: ["550e8400-e29b-41d4-a716-446655440001"],
    timeboxMinutes: 90,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("有効なタスクを検証できる", () => {
    const result = TaskSchema.safeParse(validTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("ユーザー認証機能を実装");
      expect(result.data.priority).toBe(10);
      expect(result.data.riskLevel).toBe("medium");
    }
  });

  it("必須フィールドが欠けている場合は失敗する", () => {
    const invalidTask = { ...validTask };
    // @ts-expect-error intentionally testing invalid input
    delete invalidTask.title;

    const result = TaskSchema.safeParse(invalidTask);
    expect(result.success).toBe(false);
  });

  it("無効なUUIDを拒否する", () => {
    const invalidTask = { ...validTask, id: "invalid-uuid" };
    const result = TaskSchema.safeParse(invalidTask);
    expect(result.success).toBe(false);
  });

  it("空のタイトルを拒否する", () => {
    const invalidTask = { ...validTask, title: "" };
    const result = TaskSchema.safeParse(invalidTask);
    expect(result.success).toBe(false);
  });

  it("デフォルト値が正しく適用される", () => {
    const minimalTask = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "テストタスク",
      goal: "テストが通過する",
      allowedPaths: ["src/**"],
      commands: ["pnpm test"],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = TaskSchema.safeParse(minimalTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe(0);
      expect(result.data.riskLevel).toBe("low");
      expect(result.data.role).toBe("worker");
      expect(result.data.status).toBe("queued");
      expect(result.data.dependencies).toEqual([]);
      expect(result.data.timeboxMinutes).toBe(60);
    }
  });
});

describe("RiskLevel", () => {
  it("有効なリスクレベルを受け入れる", () => {
    expect(RiskLevel.safeParse("low").success).toBe(true);
    expect(RiskLevel.safeParse("medium").success).toBe(true);
    expect(RiskLevel.safeParse("high").success).toBe(true);
  });

  it("無効なリスクレベルを拒否する", () => {
    expect(RiskLevel.safeParse("critical").success).toBe(false);
    expect(RiskLevel.safeParse("").success).toBe(false);
  });
});

describe("TaskRole", () => {
  it("すべての有効なロールを受け入れる", () => {
    const roles = ["worker", "tester", "docser"];
    for (const role of roles) {
      expect(TaskRole.safeParse(role).success).toBe(true);
    }
  });

  it("無効なロールを拒否する", () => {
    expect(TaskRole.safeParse("planner").success).toBe(false);
    expect(TaskRole.safeParse("judge").success).toBe(false);
  });
});

describe("TaskStatus", () => {
  it("すべての有効なステータスを受け入れる", () => {
    const statuses = ["queued", "running", "done", "failed", "blocked", "cancelled"];
    for (const status of statuses) {
      expect(TaskStatus.safeParse(status).success).toBe(true);
    }
  });

  it("無効なステータスを拒否する", () => {
    expect(TaskStatus.safeParse("pending").success).toBe(false);
    expect(TaskStatus.safeParse("completed").success).toBe(false);
  });
});

describe("TaskContext", () => {
  it("完全なコンテキストを検証できる", () => {
    const context = {
      files: ["src/index.ts", "src/utils.ts"],
      specs: "RESTful APIの実装",
      notes: "認証が必要",
    };
    const result = TaskContext.safeParse(context);
    expect(result.success).toBe(true);
  });

  it("部分的なコンテキストも有効", () => {
    expect(TaskContext.safeParse({}).success).toBe(true);
    expect(TaskContext.safeParse({ files: ["a.ts"] }).success).toBe(true);
    expect(TaskContext.safeParse({ specs: "仕様" }).success).toBe(true);
  });
});

describe("CreateTaskInput", () => {
  it("必須フィールドのみで作成できる", () => {
    const input = {
      title: "新しいタスク",
      goal: "テストが通過",
      allowedPaths: ["src/**"],
      commands: ["pnpm test"],
    };
    const result = CreateTaskInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("id, status, createdAt, updatedAt は含めない", () => {
    const input = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "新しいタスク",
      goal: "テストが通過",
      allowedPaths: ["src/**"],
      commands: ["pnpm test"],
      status: "done",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // CreateTaskInput はこれらのフィールドを除外している
    const result = CreateTaskInput.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      // strip されていないことを確認（Zodのデフォルト動作）
      expect("id" in result.data).toBe(false);
      expect("status" in result.data).toBe(false);
    }
  });
});

describe("UpdateTaskInput", () => {
  it("部分的な更新を許可する", () => {
    const update = { title: "更新されたタイトル" };
    const result = UpdateTaskInput.safeParse(update);
    expect(result.success).toBe(true);
  });

  it("ステータスの更新を許可する", () => {
    const update = { status: "done" as const };
    const result = UpdateTaskInput.safeParse(update);
    expect(result.success).toBe(true);
  });

  it("空のオブジェクトも有効", () => {
    const result = UpdateTaskInput.safeParse({});
    expect(result.success).toBe(true);
  });
});
