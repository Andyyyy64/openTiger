import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";

export type VisualProbeMetrics = {
  width: number;
  height: number;
  pixelCount: number;
  centerPixel: [number, number, number, number];
  clearRatio: number;
  nearBlackRatio: number;
  luminanceStdDev: number;
};

export type VisualProbeThresholds = {
  clearColor: [number, number, number];
  clearTolerance: number;
  nearBlackLumaThreshold: number;
  maxClearRatio: number;
  maxNearBlackRatio: number;
  minLuminanceStdDev: number;
};

export type VisualProbeAnalysisResult = {
  passed: boolean;
  reason: string;
  metrics: VisualProbeMetrics;
};

export const DEFAULT_VISUAL_PROBE_THRESHOLDS: VisualProbeThresholds = {
  clearColor: [26, 26, 26],
  clearTolerance: 4,
  nearBlackLumaThreshold: 10,
  maxClearRatio: 0.98,
  maxNearBlackRatio: 0.995,
  minLuminanceStdDev: 1.5,
};

function clampThreshold(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return fallback;
  }
  return value;
}

function calculateLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isClearLikePixel(
  rgb: [number, number, number],
  clearColor: [number, number, number],
  tolerance: number,
): boolean {
  return (
    Math.abs(rgb[0] - clearColor[0]) <= tolerance &&
    Math.abs(rgb[1] - clearColor[1]) <= tolerance &&
    Math.abs(rgb[2] - clearColor[2]) <= tolerance
  );
}

function safeDivision(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

export async function analyzeVisualImage(params: {
  imagePath: string;
  thresholds?: Partial<VisualProbeThresholds>;
}): Promise<VisualProbeAnalysisResult> {
  const buffer = await readFile(params.imagePath);
  const decoded = PNG.sync.read(buffer);
  const { width, height, data } = decoded;
  const pixelCount = width * height;

  if (pixelCount <= 0 || data.length < pixelCount * 4) {
    throw new Error("Visual probe image contains no pixels.");
  }

  const thresholds: VisualProbeThresholds = {
    clearColor: params.thresholds?.clearColor ?? DEFAULT_VISUAL_PROBE_THRESHOLDS.clearColor,
    clearTolerance:
      params.thresholds?.clearTolerance ?? DEFAULT_VISUAL_PROBE_THRESHOLDS.clearTolerance,
    nearBlackLumaThreshold:
      params.thresholds?.nearBlackLumaThreshold ??
      DEFAULT_VISUAL_PROBE_THRESHOLDS.nearBlackLumaThreshold,
    maxClearRatio: clampThreshold(
      params.thresholds?.maxClearRatio ?? DEFAULT_VISUAL_PROBE_THRESHOLDS.maxClearRatio,
      DEFAULT_VISUAL_PROBE_THRESHOLDS.maxClearRatio,
    ),
    maxNearBlackRatio: clampThreshold(
      params.thresholds?.maxNearBlackRatio ?? DEFAULT_VISUAL_PROBE_THRESHOLDS.maxNearBlackRatio,
      DEFAULT_VISUAL_PROBE_THRESHOLDS.maxNearBlackRatio,
    ),
    minLuminanceStdDev:
      params.thresholds?.minLuminanceStdDev ?? DEFAULT_VISUAL_PROBE_THRESHOLDS.minLuminanceStdDev,
  };

  let clearLikePixels = 0;
  let nearBlackPixels = 0;
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index] ?? 0;
    const g = data[index + 1] ?? 0;
    const b = data[index + 2] ?? 0;
    const luminance = calculateLuminance(r, g, b);
    luminanceSum += luminance;
    luminanceSquaredSum += luminance * luminance;

    if (isClearLikePixel([r, g, b], thresholds.clearColor, thresholds.clearTolerance)) {
      clearLikePixels += 1;
    }
    if (luminance <= thresholds.nearBlackLumaThreshold) {
      nearBlackPixels += 1;
    }
  }

  const meanLuminance = safeDivision(luminanceSum, pixelCount);
  const variance = Math.max(
    0,
    safeDivision(luminanceSquaredSum, pixelCount) - meanLuminance * meanLuminance,
  );
  const luminanceStdDev = Math.sqrt(variance);

  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  const centerIndex = (centerY * width + centerX) * 4;
  const centerPixel: [number, number, number, number] = [
    data[centerIndex] ?? 0,
    data[centerIndex + 1] ?? 0,
    data[centerIndex + 2] ?? 0,
    data[centerIndex + 3] ?? 0,
  ];

  const metrics: VisualProbeMetrics = {
    width,
    height,
    pixelCount,
    centerPixel,
    clearRatio: safeDivision(clearLikePixels, pixelCount),
    nearBlackRatio: safeDivision(nearBlackPixels, pixelCount),
    luminanceStdDev,
  };

  if (metrics.clearRatio > thresholds.maxClearRatio) {
    return {
      passed: false,
      reason: `clear ratio ${metrics.clearRatio.toFixed(4)} exceeded max ${thresholds.maxClearRatio.toFixed(4)}`,
      metrics,
    };
  }
  if (metrics.nearBlackRatio > thresholds.maxNearBlackRatio) {
    return {
      passed: false,
      reason: `near-black ratio ${metrics.nearBlackRatio.toFixed(4)} exceeded max ${thresholds.maxNearBlackRatio.toFixed(4)}`,
      metrics,
    };
  }
  if (metrics.luminanceStdDev < thresholds.minLuminanceStdDev) {
    return {
      passed: false,
      reason: `luminance stddev ${metrics.luminanceStdDev.toFixed(4)} below min ${thresholds.minLuminanceStdDev.toFixed(4)}`,
      metrics,
    };
  }

  return {
    passed: true,
    reason: "visual probe passed",
    metrics,
  };
}
