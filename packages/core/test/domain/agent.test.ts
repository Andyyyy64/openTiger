import { describe, it, expect } from "vitest";
import { AgentSchema, AgentRole, AgentStatus, RegisterAgentInput } from "../../src/domain/agent";

describe("AgentRole", () => {
  it("accepts all valid roles", () => {
    const roles = ["planner", "worker", "judge", "tester", "docser"];
    for (const role of roles) {
      expect(AgentRole.safeParse(role).success).toBe(true);
    }
  });

  it("rejects invalid roles", () => {
    expect(AgentRole.safeParse("dispatcher").success).toBe(false);
    expect(AgentRole.safeParse("admin").success).toBe(false);
  });
});

describe("AgentStatus", () => {
  it("accepts all valid statuses", () => {
    const statuses = ["idle", "busy", "offline"];
    for (const status of statuses) {
      expect(AgentStatus.safeParse(status).success).toBe(true);
    }
  });

  it("rejects invalid statuses", () => {
    expect(AgentStatus.safeParse("active").success).toBe(false);
    expect(AgentStatus.safeParse("running").success).toBe(false);
  });
});

describe("AgentSchema", () => {
  const validAgent = {
    id: "worker-1",
    role: "worker" as const,
    status: "idle" as const,
    currentTaskId: null,
    lastHeartbeat: new Date(),
    metadata: {
      model: "claude-opus-4",
      version: "1.0.0",
    },
    createdAt: new Date(),
  };

  it("validates valid agent", () => {
    const result = AgentSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("worker-1");
      expect(result.data.role).toBe("worker");
    }
  });

  it("validates busy agent", () => {
    const busyAgent = {
      ...validAgent,
      status: "busy" as const,
      currentTaskId: "550e8400-e29b-41d4-a716-446655440000",
    };

    const result = AgentSchema.safeParse(busyAgent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("busy");
      expect(result.data.currentTaskId).toBe("550e8400-e29b-41d4-a716-446655440000");
    }
  });

  it("valid without metadata", () => {
    const agentWithoutMetadata = {
      id: "planner-1",
      role: "planner" as const,
      status: "idle" as const,
      currentTaskId: null,
      lastHeartbeat: null,
      createdAt: new Date(),
    };

    const result = AgentSchema.safeParse(agentWithoutMetadata);
    expect(result.success).toBe(true);
  });

  it("applies default status", () => {
    const agentWithoutStatus = {
      id: "judge-1",
      role: "judge" as const,
      currentTaskId: null,
      lastHeartbeat: null,
      createdAt: new Date(),
    };

    const result = AgentSchema.safeParse(agentWithoutStatus);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("idle");
    }
  });

  it("requires valid UUID for currentTaskId", () => {
    const invalidAgent = {
      ...validAgent,
      currentTaskId: "invalid-uuid",
    };

    const result = AgentSchema.safeParse(invalidAgent);
    expect(result.success).toBe(false);
  });
});

describe("RegisterAgentInput", () => {
  it("registers with required fields only", () => {
    const input = {
      id: "worker-new",
      role: "worker" as const,
    };
    const result = RegisterAgentInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("registers with metadata", () => {
    const input = {
      id: "worker-new",
      role: "worker" as const,
      metadata: {
        model: "claude-opus-4",
        version: "2.0.0",
      },
    };
    const result = RegisterAgentInput.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata?.model).toBe("claude-opus-4");
    }
  });

  it("requires role", () => {
    const input = { id: "worker-new" };
    const result = RegisterAgentInput.safeParse(input);
    expect(result.success).toBe(false);
  });
});
