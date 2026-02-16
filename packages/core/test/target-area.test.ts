import { describe, expect, it } from "vitest";
import { resolveDeterministicTargetArea } from "../src/target-area";

describe("resolveDeterministicTargetArea", () => {
  it("keeps explicit targetArea when provided", () => {
    const targetArea = resolveDeterministicTargetArea({
      targetArea: "docser:global",
      touches: ["docs/guide.md"],
      allowedPaths: ["docs/**"],
    });

    expect(targetArea).toBe("docser:global");
  });

  it("resolves path targetArea from touches first", () => {
    const targetArea = resolveDeterministicTargetArea({
      touches: ["apps/judge/src/judge-loops.ts", "apps/judge/src/judge-retry.ts"],
      allowedPaths: ["apps/**"],
    });

    expect(targetArea).toBe("path:apps/judge");
  });

  it("falls back to allowedPaths when touches are missing", () => {
    const targetArea = resolveDeterministicTargetArea({
      allowedPaths: ["packages/core/**"],
    });

    expect(targetArea).toBe("path:packages/core");
  });

  it("resolves research area from context job id", () => {
    const targetArea = resolveDeterministicTargetArea({
      id: "task-1",
      kind: "research",
      context: {
        research: {
          jobId: "job-123",
        },
      },
    });

    expect(targetArea).toBe("research:job-123");
  });

  it("returns null for wildcard-only input", () => {
    const targetArea = resolveDeterministicTargetArea({
      touches: ["**"],
      allowedPaths: ["*"],
    });

    expect(targetArea).toBeNull();
  });
});
