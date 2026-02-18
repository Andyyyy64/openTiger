import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadVisualProbeDefinitions } from "../src/steps/verify/visual-probe-contract";

const originalContractPath = process.env.WORKER_VERIFY_CONTRACT_PATH;

afterEach(() => {
  if (originalContractPath === undefined) {
    delete process.env.WORKER_VERIFY_CONTRACT_PATH;
    return;
  }
  process.env.WORKER_VERIFY_CONTRACT_PATH = originalContractPath;
});

describe("loadVisualProbeDefinitions", () => {
  it("loads valid probes and filters by changed files", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "opentiger-visual-probe-contract-"));
    const contractPath = join(repoPath, ".opentiger", "verify.contract.json");
    await mkdir(join(repoPath, ".opentiger"), { recursive: true });
    await writeFile(
      contractPath,
      JSON.stringify(
        {
          visualProbes: [
            {
              id: "always",
              captureCommand: "ctest -R always",
              imagePath: "artifacts/always.png",
            },
            {
              id: "renderer-only",
              captureCommand: "ctest -R renderer",
              imagePath: "artifacts/renderer.png",
              whenChangedAny: ["apps/renderer/**"],
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const probes = await loadVisualProbeDefinitions({
      repoPath,
      changedFiles: ["apps/renderer/main.cpp"],
    });

    expect(probes.map((probe) => probe.id)).toEqual(["always", "renderer-only"]);
    expect(probes[0]?.artifactPaths).toEqual(["artifacts/always.png"]);
  });

  it("ignores invalid or unsafe probe definitions", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "opentiger-visual-probe-contract-invalid-"));
    await mkdir(join(repoPath, ".opentiger"), { recursive: true });
    await writeFile(
      join(repoPath, ".opentiger", "verify.contract.json"),
      JSON.stringify(
        {
          visualProbes: [
            {
              id: "../escape-id",
              captureCommand: "ctest -R smoke",
              imagePath: "artifacts/escape.png",
            },
            {
              id: "unsafe-path",
              captureCommand: "ctest -R smoke",
              imagePath: "../escape.png",
            },
            {
              id: "valid",
              captureCommand: "ctest -R smoke",
              imagePath: "artifacts/smoke.png",
              artifactPaths: ["artifacts/smoke.png", "artifacts/smoke.json"],
              skipExitCodes: [77, 88],
              maxClearRatio: 0.9,
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const probes = await loadVisualProbeDefinitions({
      repoPath,
      changedFiles: ["docs/README.md"],
    });

    expect(probes).toHaveLength(1);
    expect(probes[0]?.id).toBe("valid");
    expect(probes[0]?.artifactPaths).toEqual(["artifacts/smoke.png", "artifacts/smoke.json"]);
    expect(probes[0]?.skipExitCodes).toEqual([77, 88]);
    expect(probes[0]?.thresholds.maxClearRatio).toBe(0.9);
  });
});
