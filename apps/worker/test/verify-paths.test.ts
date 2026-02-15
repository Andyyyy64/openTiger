import { describe, expect, it } from "vitest";
import { GENERATED_PATHS } from "../src/steps/verify/constants";
import {
  isGeneratedPathWithPatterns,
  isLikelyGeneratedArtifactPath,
} from "../src/steps/verify/paths";

describe("generated artifact path detection", () => {
  it("treats tsbuildinfo files as generated artifacts", () => {
    expect(isLikelyGeneratedArtifactPath("packages/db/tsconfig.tsbuildinfo")).toBe(true);
  });

  it("matches tsbuildinfo files with default generated path patterns", () => {
    expect(isGeneratedPathWithPatterns("packages/db/tsconfig.tsbuildinfo", GENERATED_PATHS)).toBe(
      true,
    );
  });

  it("does not classify source files as generated artifacts", () => {
    expect(isLikelyGeneratedArtifactPath("apps/api/src/routes/requests.ts")).toBe(false);
  });
});
