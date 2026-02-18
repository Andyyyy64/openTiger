import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { matchesPattern, normalizePathForMatch } from "./paths";
import { DEFAULT_VISUAL_PROBE_THRESHOLDS, type VisualProbeThresholds } from "./visual-analyzer";

const DEFAULT_VERIFY_CONTRACT_PATH = ".opentiger/verify.contract.json";

type VerificationContractVisualProbe = {
  id: string;
  captureCommand: string;
  imagePath: string;
  artifactPaths: string[];
  skipExitCodes: number[];
  whenChangedAny: string[];
  whenChangedAll: string[];
  thresholds: VisualProbeThresholds;
};

type VerificationContract = {
  visualProbes?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      continue;
    }
    values.push(Math.trunc(entry));
  }
  return values;
}

function isInsideUnitRange(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseColorTriplet(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) {
    return null;
  }
  const values = value.map((entry) => (typeof entry === "number" ? Math.trunc(entry) : NaN));
  if (values.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > 255)) {
    return null;
  }
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}

function normalizeProbeId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("..") || /[\\/]/.test(normalized)) {
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeContractPath(path: string): string | null {
  const normalized = normalizePathForMatch(path);
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return null;
  }
  if (/[?*[\]{}]/.test(normalized)) {
    return null;
  }
  return normalized;
}

function resolveVisualProbeThresholds(
  raw: Record<string, unknown>,
): VerificationContractVisualProbe["thresholds"] {
  const clearColor =
    parseColorTriplet(raw.clearColor) ??
    parseColorTriplet(raw.clearColorRgb) ??
    DEFAULT_VISUAL_PROBE_THRESHOLDS.clearColor;
  const clearTolerance =
    typeof raw.clearTolerance === "number" && Number.isFinite(raw.clearTolerance)
      ? Math.max(0, Math.trunc(raw.clearTolerance))
      : DEFAULT_VISUAL_PROBE_THRESHOLDS.clearTolerance;
  const nearBlackLumaThreshold =
    typeof raw.nearBlackLumaThreshold === "number" && Number.isFinite(raw.nearBlackLumaThreshold)
      ? Math.max(0, Math.trunc(raw.nearBlackLumaThreshold))
      : DEFAULT_VISUAL_PROBE_THRESHOLDS.nearBlackLumaThreshold;
  const maxClearRatio = isInsideUnitRange(raw.maxClearRatio)
    ? raw.maxClearRatio
    : DEFAULT_VISUAL_PROBE_THRESHOLDS.maxClearRatio;
  const maxNearBlackRatio = isInsideUnitRange(raw.maxNearBlackRatio)
    ? raw.maxNearBlackRatio
    : DEFAULT_VISUAL_PROBE_THRESHOLDS.maxNearBlackRatio;
  const minLuminanceStdDev =
    typeof raw.minLuminanceStdDev === "number" && Number.isFinite(raw.minLuminanceStdDev)
      ? Math.max(0, raw.minLuminanceStdDev)
      : DEFAULT_VISUAL_PROBE_THRESHOLDS.minLuminanceStdDev;
  return {
    clearColor,
    clearTolerance,
    nearBlackLumaThreshold,
    maxClearRatio,
    maxNearBlackRatio,
    minLuminanceStdDev,
  };
}

function parseVisualProbe(value: unknown): VerificationContractVisualProbe | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeProbeId(value.id);
  const captureCommand =
    typeof value.captureCommand === "string" ? value.captureCommand.trim() : "";
  const imagePathRaw = typeof value.imagePath === "string" ? value.imagePath : "";
  const imagePath = normalizeContractPath(imagePathRaw);
  if (!id || !captureCommand || !imagePath) {
    return null;
  }

  const artifactCandidates = toStringArray(value.artifactPaths)
    .map((candidate) => normalizeContractPath(candidate))
    .filter((candidate): candidate is string => Boolean(candidate));
  const artifactPaths = Array.from(new Set([imagePath, ...artifactCandidates]));
  const skipExitCodes = Array.from(new Set(toNumberArray(value.skipExitCodes)));

  return {
    id,
    captureCommand,
    imagePath,
    artifactPaths,
    skipExitCodes,
    whenChangedAny: toStringArray(value.whenChangedAny),
    whenChangedAll: toStringArray(value.whenChangedAll),
    thresholds: resolveVisualProbeThresholds(value),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function matchesProbeFiles(
  probe: VerificationContractVisualProbe,
  changedFiles: string[],
): boolean {
  if (probe.whenChangedAny.length === 0 && probe.whenChangedAll.length === 0) {
    return true;
  }
  if (changedFiles.length === 0) {
    return false;
  }
  const matchesAny =
    probe.whenChangedAny.length === 0 ||
    changedFiles.some((file) => matchesPattern(file, probe.whenChangedAny));
  const matchesAll = probe.whenChangedAll.every((pattern) =>
    changedFiles.some((file) => matchesPattern(file, [pattern])),
  );
  return matchesAny && matchesAll;
}

export async function loadVisualProbeDefinitions(params: {
  repoPath: string;
  changedFiles: string[];
}): Promise<VerificationContractVisualProbe[]> {
  const relativeContractPath =
    process.env.WORKER_VERIFY_CONTRACT_PATH?.trim() || DEFAULT_VERIFY_CONTRACT_PATH;
  const contractPath = join(params.repoPath, relativeContractPath);
  if (!(await pathExists(contractPath))) {
    return [];
  }

  let parsed: unknown;
  try {
    const raw = await readFile(contractPath, "utf-8");
    parsed = JSON.parse(raw) as VerificationContract;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.visualProbes)) {
    return [];
  }

  const probes = parsed.visualProbes
    .map((probe) => parseVisualProbe(probe))
    .filter((probe): probe is VerificationContractVisualProbe => Boolean(probe))
    .filter((probe) => matchesProbeFiles(probe, params.changedFiles));
  const uniqueById = new Map<string, VerificationContractVisualProbe>();
  for (const probe of probes) {
    if (!uniqueById.has(probe.id)) {
      uniqueById.set(probe.id, probe);
    }
  }
  return Array.from(uniqueById.values());
}

export type { VerificationContractVisualProbe };
