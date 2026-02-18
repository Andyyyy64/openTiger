import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { db } from "@openTiger/db";
import { artifacts } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import { buildGitHubPrUrl } from "./worker-runner-utils";
import type { VisualProbeMetrics } from "./steps/verify/types";

const DEFAULT_LOG_DIR = resolve(import.meta.dirname, "../../../raw-logs");
const LEGACY_LOG_DIR_PLACEHOLDER_MARKER = "/absolute/path/to/opentiger";

function resolveLogDir(fallbackDir: string): string {
  const candidate =
    process.env.OPENTIGER_LOG_DIR?.trim() || process.env.OPENTIGER_RAW_LOG_DIR?.trim();
  if (
    candidate &&
    !candidate.trim().replace(/\\/gu, "/").toLowerCase().includes(LEGACY_LOG_DIR_PLACEHOLDER_MARKER)
  ) {
    return resolve(candidate);
  }
  return resolve(fallbackDir);
}

function normalizeArtifactPath(path: string): string | null {
  const normalized = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  if (!normalized) {
    return null;
  }
  if (normalized.includes("..")) {
    return null;
  }
  return normalized;
}

function normalizeProbeId(path: string): string | null {
  const normalized = path.trim();
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

function isInsidePath(basePath: string, candidatePath: string): boolean {
  const normalizedBase = resolve(basePath);
  const normalizedCandidate = resolve(candidatePath);
  return (
    normalizedCandidate === normalizedBase ||
    normalizedCandidate.startsWith(`${normalizedBase}/`) ||
    normalizedCandidate.startsWith(`${normalizedBase}\\`)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function inferMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".bmp") {
    return "image/bmp";
  }
  if (extension === ".json") {
    return "application/json";
  }
  if (extension === ".txt" || extension === ".log") {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

export async function attachExistingPrArtifact(params: {
  runId: string;
  prNumber: number;
  repoUrl: string;
}): Promise<string | undefined> {
  const prUrl = buildGitHubPrUrl(params.repoUrl, params.prNumber);
  await db.insert(artifacts).values({
    runId: params.runId,
    type: "pr",
    ref: String(params.prNumber),
    url: prUrl,
    metadata: {
      source: "existing_pr_context",
      reused: true,
    },
  });
  return prUrl;
}

export async function persistVisualProbeArtifacts(params: {
  runId: string;
  repoPath: string;
  probeId: string;
  status: "passed" | "failed" | "skipped";
  message: string;
  artifactPaths: string[];
  metrics?: VisualProbeMetrics;
}): Promise<number> {
  if (params.artifactPaths.length === 0) {
    return 0;
  }
  const normalizedProbeId = normalizeProbeId(params.probeId);
  if (!normalizedProbeId) {
    return 0;
  }
  const repoRoot = resolve(params.repoPath);
  const logDir = resolveLogDir(DEFAULT_LOG_DIR);
  let persisted = 0;

  for (const rawPath of params.artifactPaths) {
    const normalizedPath = normalizeArtifactPath(rawPath);
    if (!normalizedPath) {
      continue;
    }
    const sourcePath = resolve(repoRoot, normalizedPath);
    if (!isInsidePath(repoRoot, sourcePath) || !(await pathExists(sourcePath))) {
      continue;
    }

    const storedRelativePath = join(
      "artifacts",
      params.runId,
      "visual-probes",
      normalizedProbeId,
      normalizedPath,
    );
    const destinationPath = resolve(logDir, storedRelativePath);
    if (!isInsidePath(logDir, destinationPath)) {
      continue;
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);

    const destinationStat = await stat(destinationPath);
    const mimeType = inferMimeType(destinationPath);
    const insertResult = await db
      .insert(artifacts)
      .values({
        runId: params.runId,
        type: "ci_result",
        ref: normalizedProbeId,
        metadata: {
          source: "visual_probe",
          probeId: normalizedProbeId,
          status: params.status,
          summary: params.message,
          originalPath: normalizedPath,
          storedPath: storedRelativePath.replace(/\\/g, "/"),
          mimeType,
          sizeBytes: destinationStat.size,
          metrics: params.metrics ?? null,
        },
      })
      .returning({
        id: artifacts.id,
      });
    const artifactId = insertResult[0]?.id;
    if (artifactId) {
      const url = `/api/runs/${params.runId}/artifacts/${artifactId}/content`;
      await db.update(artifacts).set({ url }).where(eq(artifacts.id, artifactId));
    }
    persisted += 1;
  }

  return persisted;
}
