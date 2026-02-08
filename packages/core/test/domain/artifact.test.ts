import { describe, it, expect } from "vitest";
import {
  ArtifactSchema,
  ArtifactType,
  CreateArtifactInput,
} from "../../src/domain/artifact";

describe("ArtifactType", () => {
  it("すべての有効なタイプを受け入れる", () => {
    const types = ["pr", "commit", "ci_result", "branch"];
    for (const type of types) {
      expect(ArtifactType.safeParse(type).success).toBe(true);
    }
  });

  it("無効なタイプを拒否する", () => {
    expect(ArtifactType.safeParse("file").success).toBe(false);
    expect(ArtifactType.safeParse("log").success).toBe(false);
  });
});

describe("ArtifactSchema", () => {
  const validArtifact = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    runId: "550e8400-e29b-41d4-a716-446655440001",
    type: "pr" as const,
    ref: "42",
    url: "https://github.com/org/repo/pull/42",
    metadata: { draft: false, mergeable: true },
    createdAt: new Date(),
  };

  it("有効なPR成果物を検証できる", () => {
    const result = ArtifactSchema.safeParse(validArtifact);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("pr");
      expect(result.data.ref).toBe("42");
    }
  });

  it("コミット成果物を検証できる", () => {
    const commitArtifact = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      runId: "550e8400-e29b-41d4-a716-446655440001",
      type: "commit" as const,
      ref: "abc123def456",
      url: "https://github.com/org/repo/commit/abc123def456",
      metadata: null,
      createdAt: new Date(),
    };

    const result = ArtifactSchema.safeParse(commitArtifact);
    expect(result.success).toBe(true);
  });

  it("CI結果成果物を検証できる", () => {
    const ciArtifact = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      runId: "550e8400-e29b-41d4-a716-446655440001",
      type: "ci_result" as const,
      ref: "12345678",
      url: "https://github.com/org/repo/actions/runs/12345678",
      metadata: {
        status: "completed",
        conclusion: "success",
        workflow: "CI",
      },
      createdAt: new Date(),
    };

    const result = ArtifactSchema.safeParse(ciArtifact);
    expect(result.success).toBe(true);
    if (result.success) {
      const meta = result.data.metadata as Record<string, unknown>;
      expect(meta.conclusion).toBe("success");
    }
  });

  it("ブランチ成果物を検証できる", () => {
    const branchArtifact = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      runId: "550e8400-e29b-41d4-a716-446655440001",
      type: "branch" as const,
      ref: "agent/worker-1/task-123",
      url: null,
      metadata: null,
      createdAt: new Date(),
    };

    const result = ArtifactSchema.safeParse(branchArtifact);
    expect(result.success).toBe(true);
  });

  it("無効なURLを拒否する", () => {
    const invalidArtifact = {
      ...validArtifact,
      url: "not-a-valid-url",
    };

    const result = ArtifactSchema.safeParse(invalidArtifact);
    expect(result.success).toBe(false);
  });

  it("refとurlはnull許容", () => {
    const minimalArtifact = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      runId: "550e8400-e29b-41d4-a716-446655440001",
      type: "branch" as const,
      ref: null,
      url: null,
      metadata: null,
      createdAt: new Date(),
    };

    const result = ArtifactSchema.safeParse(minimalArtifact);
    expect(result.success).toBe(true);
  });
});

describe("CreateArtifactInput", () => {
  it("有効な作成入力を検証できる", () => {
    const input = {
      runId: "550e8400-e29b-41d4-a716-446655440001",
      type: "pr" as const,
      ref: "42",
      url: "https://github.com/org/repo/pull/42",
      metadata: { labels: ["agent"] },
    };

    const result = CreateArtifactInput.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("id と createdAt は含めない", () => {
    const input = {
      runId: "550e8400-e29b-41d4-a716-446655440001",
      type: "commit" as const,
      ref: "abc123",
      url: null,
      metadata: null,
    };

    const result = CreateArtifactInput.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect("id" in result.data).toBe(false);
      expect("createdAt" in result.data).toBe(false);
    }
  });
});
