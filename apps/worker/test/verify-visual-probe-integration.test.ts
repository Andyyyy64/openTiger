import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { DEFAULT_POLICY } from "@openTiger/core";
import { verifyChanges } from "../src/steps/verify/verify-changes";

const createdDirs: string[] = [];
const originalAutoVerifyMode = process.env.WORKER_AUTO_VERIFY_MODE;
const originalLightCheckMode = process.env.WORKER_LIGHT_CHECK_MODE;

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

afterEach(async () => {
  if (originalAutoVerifyMode === undefined) {
    delete process.env.WORKER_AUTO_VERIFY_MODE;
  } else {
    process.env.WORKER_AUTO_VERIFY_MODE = originalAutoVerifyMode;
  }
  if (originalLightCheckMode === undefined) {
    delete process.env.WORKER_LIGHT_CHECK_MODE;
  } else {
    process.env.WORKER_LIGHT_CHECK_MODE = originalLightCheckMode;
  }

  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("verifyChanges visual probe integration", () => {
  it("runs visual probes when no verification commands are available", async () => {
    process.env.WORKER_AUTO_VERIFY_MODE = "off";
    process.env.WORKER_LIGHT_CHECK_MODE = "off";

    const repoPath = await mkdtemp(join(tmpdir(), "opentiger-verify-visual-probe-"));
    createdDirs.push(repoPath);

    await mkdir(join(repoPath, ".opentiger"), { recursive: true });
    await mkdir(join(repoPath, "artifacts"), { recursive: true });
    await writeFile(
      join(repoPath, ".opentiger", "verify.contract.json"),
      JSON.stringify(
        {
          visualProbes: [
            {
              id: "clear-frame",
              captureCommand: 'node -e "process.exit(0)"',
              imagePath: "artifacts/frame.png",
              artifactPaths: ["artifacts/frame.png"],
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );
    await createPng(join(repoPath, "artifacts", "frame.png"), 8, 8, [26, 26, 26, 255]);

    const result = await verifyChanges({
      repoPath,
      commands: [],
      allowedPaths: ["**/*"],
      policy: DEFAULT_POLICY,
      allowNoChanges: true,
    });

    expect(result.success).toBe(false);
    expect(result.failedCommandSource).toBe("visual-probe");
    expect(result.failedCommand).toBe("visual-probe:clear-frame");
    expect(result.visualProbeResults).toHaveLength(1);
    expect(result.visualProbeResults?.[0]?.id).toBe("clear-frame");
    expect(result.visualProbeResults?.[0]?.status).toBe("failed");
    expect(result.commandResults.some((entry) => entry.source === "light-check")).toBe(true);
    expect(result.commandResults.some((entry) => entry.source === "visual-probe")).toBe(true);
  });
});
