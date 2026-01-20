import { describe, it, expect } from "vitest";
import { PolicySchema, DEFAULT_POLICY } from "../../src/domain/policy.js";

describe("PolicySchema", () => {
  it("完全なポリシーを検証できる", () => {
    const policy = {
      allowedPaths: ["src/**", "tests/**"],
      deniedPaths: ["node_modules/**", ".env"],
      maxLinesChanged: 1000,
      maxFilesChanged: 50,
      deniedCommands: ["rm -rf /", "sudo", "chmod 777", "curl"],
      autoMerge: {
        enabled: true,
        maxRiskLevel: "medium" as const,
        requiredChecks: ["lint", "test", "build"],
      },
      tokenLimits: {
        perTask: 200000,
        perDay: 2000000,
      },
    };

    const result = PolicySchema.safeParse(policy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxLinesChanged).toBe(1000);
      expect(result.data.autoMerge.enabled).toBe(true);
      expect(result.data.autoMerge.requiredChecks).toContain("test");
    }
  });

  it("デフォルト値が正しく適用される", () => {
    const result = PolicySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedPaths).toEqual(["**/*"]);
      expect(result.data.deniedPaths).toEqual([]);
      expect(result.data.maxLinesChanged).toBe(500);
      expect(result.data.maxFilesChanged).toBe(20);
      expect(result.data.autoMerge.enabled).toBe(false);
      expect(result.data.autoMerge.maxRiskLevel).toBe("low");
      expect(result.data.tokenLimits.perTask).toBe(100000);
      expect(result.data.tokenLimits.perDay).toBe(1000000);
    }
  });

  it("部分的なポリシーにデフォルトがマージされる", () => {
    const partialPolicy = {
      allowedPaths: ["src/api/**"],
      maxLinesChanged: 200,
    };

    const result = PolicySchema.safeParse(partialPolicy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedPaths).toEqual(["src/api/**"]);
      expect(result.data.maxLinesChanged).toBe(200);
      // デフォルトが適用される
      expect(result.data.maxFilesChanged).toBe(20);
      expect(result.data.autoMerge.enabled).toBe(false);
    }
  });

  it("autoMergeのmaxRiskLevelはlowかmediumのみ", () => {
    const validLow = {
      autoMerge: { enabled: true, maxRiskLevel: "low" as const },
    };
    const validMedium = {
      autoMerge: { enabled: true, maxRiskLevel: "medium" as const },
    };
    const invalidHigh = {
      autoMerge: { enabled: true, maxRiskLevel: "high" },
    };

    expect(PolicySchema.safeParse(validLow).success).toBe(true);
    expect(PolicySchema.safeParse(validMedium).success).toBe(true);
    expect(PolicySchema.safeParse(invalidHigh).success).toBe(false);
  });

  it("負の数を拒否する", () => {
    const invalidPolicy = {
      maxLinesChanged: -100,
    };

    const result = PolicySchema.safeParse(invalidPolicy);
    expect(result.success).toBe(false);
  });

  it("ゼロを拒否する", () => {
    const invalidPolicy = {
      maxFilesChanged: 0,
    };

    const result = PolicySchema.safeParse(invalidPolicy);
    expect(result.success).toBe(false);
  });
});

describe("DEFAULT_POLICY", () => {
  it("デフォルトポリシーが正しく定義されている", () => {
    expect(DEFAULT_POLICY.allowedPaths).toEqual(["**/*"]);
    expect(DEFAULT_POLICY.deniedPaths).toEqual([]);
    expect(DEFAULT_POLICY.maxLinesChanged).toBe(500);
    expect(DEFAULT_POLICY.maxFilesChanged).toBe(20);
  });

  it("デフォルトの禁止コマンドが設定されている", () => {
    expect(DEFAULT_POLICY.deniedCommands).toContain("rm -rf /");
    expect(DEFAULT_POLICY.deniedCommands).toContain("sudo");
    expect(DEFAULT_POLICY.deniedCommands).toContain("chmod 777");
  });

  it("デフォルトでは自動マージが無効", () => {
    expect(DEFAULT_POLICY.autoMerge.enabled).toBe(false);
    expect(DEFAULT_POLICY.autoMerge.maxRiskLevel).toBe("low");
    expect(DEFAULT_POLICY.autoMerge.requiredChecks).toEqual([]);
  });

  it("デフォルトのトークン制限が設定されている", () => {
    expect(DEFAULT_POLICY.tokenLimits.perTask).toBe(100000);
    expect(DEFAULT_POLICY.tokenLimits.perDay).toBe(1000000);
  });
});
