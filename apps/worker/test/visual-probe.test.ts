import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { runVisualProbes } from "../src/steps/verify/visual-probe";
import { DEFAULT_VISUAL_PROBE_THRESHOLDS } from "../src/steps/verify/visual-analyzer";
import type { VerificationContractVisualProbe } from "../src/steps/verify/visual-probe-contract";

async function createPng(
  path: string,
  width: number,
  height: number,
  pixel: [number, number, number, number],
): Promise<void> {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (width * y + x) << 2;
      image.data[index] = pixel[0];
      image.data[index + 1] = pixel[1];
      image.data[index + 2] = pixel[2];
      image.data[index + 3] = pixel[3];
    }
  }
  await writeFile(path, PNG.sync.write(image));
}

function buildProbe(
  overrides: Partial<VerificationContractVisualProbe>,
): VerificationContractVisualProbe {
  return {
    id: "probe",
    captureCommand: 'node -e "process.exit(0)"',
    imagePath: "frame.png",
    artifactPaths: ["frame.png"],
    skipExitCodes: [],
    whenChangedAny: [],
    whenChangedAll: [],
    thresholds: DEFAULT_VISUAL_PROBE_THRESHOLDS,
    ...overrides,
  };
}

describe("runVisualProbes", () => {
  it("treats configured exit code as skipped", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "opentiger-visual-probe-skip-"));
    await mkdir(repoPath, { recursive: true });
    const probes = [
      buildProbe({
        id: "skip",
        captureCommand: 'node -e "process.exit(77)"',
        skipExitCodes: [77],
      }),
    ];

    const result = await runVisualProbes({ repoPath, probes });
    expect(result.allPassed).toBe(true);
    expect(result.probeResults[0]?.status).toBe("skipped");
    expect(result.commandResults[0]?.outcome).toBe("skipped");
  });

  it("fails when visual analysis reports clear-only frame", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "opentiger-visual-probe-fail-"));
    const imagePath = join(repoPath, "frame.png");
    await createPng(imagePath, 4, 4, [26, 26, 26, 255]);
    const probes = [buildProbe({ id: "fail" })];

    const result = await runVisualProbes({ repoPath, probes });
    expect(result.allPassed).toBe(false);
    expect(result.failedProbe?.id).toBe("fail");
    expect(result.commandResults[0]?.success).toBe(false);
    expect(result.commandResults[0]?.source).toBe("visual-probe");
  });

  it("fails when probe image is stale", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "opentiger-visual-probe-stale-"));
    const imagePath = join(repoPath, "frame.png");
    await createPng(imagePath, 4, 4, [100, 120, 140, 255]);
    const staleDate = new Date(Date.now() - 60_000);
    await utimes(imagePath, staleDate, staleDate);
    const probes = [buildProbe({ id: "stale" })];

    const result = await runVisualProbes({ repoPath, probes });
    expect(result.allPassed).toBe(false);
    expect(result.failedProbe?.id).toBe("stale");
    expect(result.failedProbe?.message).toContain("stale");
  });
});
