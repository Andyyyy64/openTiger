import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { analyzeVisualImage } from "../src/steps/verify/visual-analyzer";

async function writePng(params: {
  width: number;
  height: number;
  pixel: (x: number, y: number) => [number, number, number, number];
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opentiger-visual-analyzer-"));
  const filePath = join(dir, "frame.png");
  const image = new PNG({ width: params.width, height: params.height });

  for (let y = 0; y < params.height; y += 1) {
    for (let x = 0; x < params.width; x += 1) {
      const [r, g, b, a] = params.pixel(x, y);
      const index = (params.width * y + x) << 2;
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = a;
    }
  }

  const buffer = PNG.sync.write(image);
  await writeFile(filePath, buffer);
  return filePath;
}

describe("analyzeVisualImage", () => {
  it("fails on near-uniform clear-color frame", async () => {
    const imagePath = await writePng({
      width: 4,
      height: 4,
      pixel: () => [26, 26, 26, 255],
    });
    const result = await analyzeVisualImage({ imagePath });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain("clear ratio");
    expect(result.metrics.clearRatio).toBe(1);
  });

  it("passes on frame with visible color variance", async () => {
    const imagePath = await writePng({
      width: 4,
      height: 4,
      pixel: (x, y) => [x * 50, y * 50, 180, 255],
    });
    const result = await analyzeVisualImage({ imagePath });

    expect(result.passed).toBe(true);
    expect(result.metrics.luminanceStdDev).toBeGreaterThan(1.5);
    expect(result.metrics.centerPixel[3]).toBe(255);
  });
});
