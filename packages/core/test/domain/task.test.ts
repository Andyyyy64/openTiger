import { describe, it, expect } from "vitest";
import {
  TaskSchema,
  CreateTaskInput,
  UpdateTaskInput,
  RiskLevel,
  TaskKind,
  TaskRole,
  TaskStatus,
  TaskContext,
} from "../../src/domain/task";

describe("TaskSchema", () => {
  const validTask = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    title: "Implement user authentication",
    goal: "pnpm test --filter=@openTiger/auth passes",
    context: {
      files: ["src/auth/login.ts", "src/auth/session.ts"],
      specs: "OAuth2.0 authentication",
      notes: "Use existing DB schema",
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

  it("validates valid task", () => {
    const result = TaskSchema.safeParse(validTask);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Implement user authentication");
      expect(result.data.priority).toBe(10);
      expect(result.data.riskLevel).toBe("medium");
    }
  });

  it("fails when required fields missing", () => {
    const invalidTask = { ...validTask };
    // @ts-expect-error intentionally testing invalid input
    delete invalidTask.title;

    const result = TaskSchema.safeParse(invalidTask);
    expect(result.success).toBe(false);
  });

  it("rejects invalid UUID", () => {
    const invalidTask = { ...validTask, id: "invalid-uuid" };
    const result = TaskSchema.safeParse(invalidTask);
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const invalidTask = { ...validTask, title: "" };
    const result = TaskSchema.safeParse(invalidTask);
    expect(result.success).toBe(false);
  });

  it("applies defaults correctly", () => {
    const minimalTask = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "Test task",
      goal: "Tests pass",
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
      expect(result.data.kind).toBe("code");
      expect(result.data.status).toBe("queued");
      expect(result.data.dependencies).toEqual([]);
      expect(result.data.timeboxMinutes).toBe(60);
    }
  });
});

describe("RiskLevel", () => {
  it("accepts valid risk levels", () => {
    expect(RiskLevel.safeParse("low").success).toBe(true);
    expect(RiskLevel.safeParse("medium").success).toBe(true);
    expect(RiskLevel.safeParse("high").success).toBe(true);
  });

  it("rejects invalid risk levels", () => {
    expect(RiskLevel.safeParse("critical").success).toBe(false);
    expect(RiskLevel.safeParse("").success).toBe(false);
  });
});

describe("TaskRole", () => {
  it("accepts all valid roles", () => {
    const roles = ["worker", "tester", "docser"];
    for (const role of roles) {
      expect(TaskRole.safeParse(role).success).toBe(true);
    }
  });

  it("rejects invalid roles", () => {
    expect(TaskRole.safeParse("planner").success).toBe(false);
    expect(TaskRole.safeParse("judge").success).toBe(false);
  });
});

describe("TaskKind", () => {
  it("accepts valid task kinds", () => {
    expect(TaskKind.safeParse("code").success).toBe(true);
    expect(TaskKind.safeParse("research").success).toBe(true);
  });

  it("rejects invalid task kinds", () => {
    expect(TaskKind.safeParse("analysis").success).toBe(false);
  });
});

describe("TaskStatus", () => {
  it("accepts all valid statuses", () => {
    const statuses = ["queued", "running", "done", "failed", "blocked", "cancelled"];
    for (const status of statuses) {
      expect(TaskStatus.safeParse(status).success).toBe(true);
    }
  });

  it("rejects invalid statuses", () => {
    expect(TaskStatus.safeParse("pending").success).toBe(false);
    expect(TaskStatus.safeParse("completed").success).toBe(false);
  });
});

describe("TaskContext", () => {
  it("validates full context", () => {
    const context = {
      files: ["src/index.ts", "src/utils.ts"],
      specs: "RESTful API implementation",
      notes: "Authentication required",
    };
    const result = TaskContext.safeParse(context);
    expect(result.success).toBe(true);
  });

  it("accepts partial context", () => {
    expect(TaskContext.safeParse({}).success).toBe(true);
    expect(TaskContext.safeParse({ files: ["a.ts"] }).success).toBe(true);
    expect(TaskContext.safeParse({ specs: "specs" }).success).toBe(true);
  });
});

describe("CreateTaskInput", () => {
  it("creates with required fields only", () => {
    const input = {
      title: "New task",
      goal: "Tests pass",
      allowedPaths: ["src/**"],
      commands: ["pnpm test"],
    };
    const result = CreateTaskInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("omits id, status, createdAt, updatedAt", () => {
    const input = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      title: "New task",
      goal: "Tests pass",
      allowedPaths: ["src/**"],
      commands: ["pnpm test"],
      status: "done",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // CreateTaskInput excludes these fields
    const result = CreateTaskInput.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      // Zod does not strip by default
      expect("id" in result.data).toBe(false);
      expect("status" in result.data).toBe(false);
    }
  });
});

describe("UpdateTaskInput", () => {
  it("allows partial update", () => {
    const update = { title: "Updated title" };
    const result = UpdateTaskInput.safeParse(update);
    expect(result.success).toBe(true);
  });

  it("allows status update", () => {
    const update = { status: "done" as const };
    const result = UpdateTaskInput.safeParse(update);
    expect(result.success).toBe(true);
  });

  it("accepts empty object", () => {
    const result = UpdateTaskInput.safeParse({});
    expect(result.success).toBe(true);
  });
});
