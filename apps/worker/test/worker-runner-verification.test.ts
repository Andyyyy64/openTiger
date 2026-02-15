import { describe, expect, it } from "vitest";
import { selectGeneratedArtifactRecoveryCandidates } from "../src/worker-runner-verification";

describe("selectGeneratedArtifactRecoveryCandidates", () => {
  it("keeps known generated artifact violations as discard candidates", () => {
    const result = selectGeneratedArtifactRecoveryCandidates({
      violatingPaths: ["packages/db/tsconfig.tsbuildinfo"],
      untrackedFiles: [],
    });

    expect(result.discardPaths).toEqual(["packages/db/tsconfig.tsbuildinfo"]);
    expect(result.generatedPaths).toEqual(["packages/db/tsconfig.tsbuildinfo"]);
    expect(result.untrackedOutsidePaths).toEqual([]);
  });

  it("keeps unknown untracked outside-allowed violations as discard candidates", () => {
    const result = selectGeneratedArtifactRecoveryCandidates({
      violatingPaths: ["packages/db/custom.cache"],
      untrackedFiles: ["packages/db/custom.cache"],
    });

    expect(result.discardPaths).toEqual(["packages/db/custom.cache"]);
    expect(result.generatedPaths).toEqual([]);
    expect(result.untrackedOutsidePaths).toEqual(["packages/db/custom.cache"]);
  });

  it("does not discard tracked non-generated files", () => {
    const result = selectGeneratedArtifactRecoveryCandidates({
      violatingPaths: ["apps/api/src/routes/requests.ts"],
      untrackedFiles: [],
    });

    expect(result.discardPaths).toEqual([]);
    expect(result.generatedPaths).toEqual([]);
    expect(result.untrackedOutsidePaths).toEqual([]);
  });
});
