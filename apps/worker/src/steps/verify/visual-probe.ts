import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommandResult, VisualProbeResult } from "./types";
import type { VerificationContractVisualProbe } from "./visual-probe-contract";
import { analyzeVisualImage } from "./visual-analyzer";
import { runCommand } from "./command-runner";

type RunVisualProbesResult = {
  allPassed: boolean;
  commandResults: CommandResult[];
  probeResults: VisualProbeResult[];
  failedProbe?: VisualProbeResult;
};

const VISUAL_PROBE_FRESHNESS_TOLERANCE_MS = 2000;

function summarizeProbeResult(result: VisualProbeResult): string {
  const center = result.metrics?.centerPixel ?? [0, 0, 0, 0];
  const ratios =
    result.metrics === undefined
      ? ""
      : ` clear=${result.metrics.clearRatio.toFixed(4)} nearBlack=${result.metrics.nearBlackRatio.toFixed(4)} stddev=${result.metrics.luminanceStdDev.toFixed(4)}`;
  return `${result.status} (${result.id}) center=[${center.join(",")}],${ratios} ${result.message}`.trim();
}

function toCommandResult(probeResult: VisualProbeResult): CommandResult {
  const summary = summarizeProbeResult(probeResult);
  if (probeResult.status === "failed") {
    return {
      command: `visual-probe:${probeResult.id}`,
      source: "visual-probe",
      success: false,
      outcome: "failed",
      stdout: "",
      stderr: summary,
      durationMs: probeResult.durationMs,
      exitCode: probeResult.exitCode,
    };
  }
  return {
    command: `visual-probe:${probeResult.id}`,
    source: "visual-probe",
    success: true,
    outcome: probeResult.status === "skipped" ? "skipped" : "passed",
    stdout: summary,
    stderr: probeResult.status === "skipped" ? probeResult.message : "",
    durationMs: probeResult.durationMs,
    exitCode: probeResult.exitCode,
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

function isFreshProbeImage(fileMtimeMs: number, captureStartedAtMs: number): boolean {
  return fileMtimeMs + VISUAL_PROBE_FRESHNESS_TOLERANCE_MS >= captureStartedAtMs;
}

function resolveArtifactPaths(
  repoPath: string,
  candidates: string[],
): { relativePaths: string[]; absolutePaths: string[] } {
  const relativePaths: string[] = [];
  const absolutePaths: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const absolute = resolve(repoPath, candidate);
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    absolutePaths.push(absolute);
    relativePaths.push(candidate);
  }
  return { relativePaths, absolutePaths };
}

async function runVisualProbe(params: {
  repoPath: string;
  probe: VerificationContractVisualProbe;
}): Promise<VisualProbeResult> {
  const { repoPath, probe } = params;
  const startedAt = Date.now();
  const imageAbsolutePath = resolve(repoPath, probe.imagePath);
  const captureResult = await runCommand(probe.captureCommand, repoPath);
  const durationMs = Date.now() - startedAt;

  const { relativePaths, absolutePaths } = resolveArtifactPaths(repoPath, probe.artifactPaths);
  const existingArtifactPaths: string[] = [];
  for (let index = 0; index < absolutePaths.length; index += 1) {
    if (await pathExists(absolutePaths[index] ?? "")) {
      const relative = relativePaths[index];
      if (relative) {
        existingArtifactPaths.push(relative);
      }
    }
  }

  if (!captureResult.success) {
    const exitCode = captureResult.exitCode ?? null;
    if (exitCode !== null && probe.skipExitCodes.includes(exitCode)) {
      return {
        id: probe.id,
        status: "skipped",
        message: `probe skipped due to configured skip exit code ${exitCode}`,
        durationMs,
        command: probe.captureCommand,
        exitCode,
        artifactPaths: existingArtifactPaths,
      };
    }
    const failureOutput =
      captureResult.stderr.trim() || captureResult.stdout.trim() || "(no output)";
    return {
      id: probe.id,
      status: "failed",
      message: `probe capture command failed: ${failureOutput.slice(0, 300)}`,
      durationMs,
      command: probe.captureCommand,
      exitCode,
      artifactPaths: existingArtifactPaths,
    };
  }

  let imageStat: Awaited<ReturnType<typeof stat>> | null;
  try {
    imageStat = await stat(imageAbsolutePath);
  } catch {
    imageStat = null;
  }
  if (!imageStat || !imageStat.isFile()) {
    return {
      id: probe.id,
      status: "failed",
      message: `probe image not found: ${probe.imagePath}`,
      durationMs,
      command: probe.captureCommand,
      exitCode: captureResult.exitCode ?? null,
      artifactPaths: existingArtifactPaths,
    };
  }
  if (!isFreshProbeImage(imageStat.mtimeMs, startedAt)) {
    return {
      id: probe.id,
      status: "failed",
      message: `probe image is stale (expected fresh output from capture command): ${probe.imagePath}`,
      durationMs,
      command: probe.captureCommand,
      exitCode: captureResult.exitCode ?? null,
      artifactPaths: existingArtifactPaths,
    };
  }

  try {
    const analysis = await analyzeVisualImage({
      imagePath: imageAbsolutePath,
      thresholds: probe.thresholds,
    });
    return {
      id: probe.id,
      status: analysis.passed ? "passed" : "failed",
      message: analysis.reason,
      durationMs,
      command: probe.captureCommand,
      exitCode: captureResult.exitCode ?? null,
      metrics: analysis.metrics,
      artifactPaths: existingArtifactPaths,
    };
  } catch (error) {
    return {
      id: probe.id,
      status: "failed",
      message: `probe image analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      durationMs,
      command: probe.captureCommand,
      exitCode: captureResult.exitCode ?? null,
      artifactPaths: existingArtifactPaths,
    };
  }
}

export async function runVisualProbes(params: {
  repoPath: string;
  probes: VerificationContractVisualProbe[];
}): Promise<RunVisualProbesResult> {
  const probeResults: VisualProbeResult[] = [];
  const commandResults: CommandResult[] = [];
  let failedProbe: VisualProbeResult | undefined;

  for (const probe of params.probes) {
    console.log(`[Verify] Running visual probe: ${probe.id}`);
    const probeResult = await runVisualProbe({
      repoPath: params.repoPath,
      probe,
    });
    probeResults.push(probeResult);
    commandResults.push(toCommandResult(probeResult));
    if (probeResult.status === "failed" && !failedProbe) {
      failedProbe = probeResult;
      break;
    }
  }

  return {
    allPassed: !failedProbe,
    commandResults,
    probeResults,
    failedProbe,
  };
}
