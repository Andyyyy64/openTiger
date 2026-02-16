import { describe, expect, it } from "vitest";
import { pathsOverlap } from "../src/dependency-resolver";

describe("pathsOverlap", () => {
  it("detects overlap for nested directory relationship", () => {
    expect(pathsOverlap("apps/judge/**", "apps/judge/src/judge-loops.ts")).toBe(true);
  });

  it("treats wildcard root as overlapping with everything", () => {
    expect(pathsOverlap("**", "apps/worker/src/main.ts")).toBe(true);
  });

  it("returns false for unrelated directories", () => {
    expect(pathsOverlap("apps/judge/**", "apps/worker/**")).toBe(false);
  });

  it("normalizes Windows-style path separators", () => {
    expect(pathsOverlap("apps\\judge\\**", "apps/judge/src/judge-retry.ts")).toBe(true);
  });
});
