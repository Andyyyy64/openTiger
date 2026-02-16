type ResolveTargetAreaInput = {
  id?: string | null;
  kind?: string | null;
  targetArea?: string | null;
  touches?: string[] | null;
  allowedPaths?: string[] | null;
  context?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveResearchJobId(context: unknown): string | null {
  if (!isRecord(context)) {
    return null;
  }
  const research = context.research;
  if (!isRecord(research)) {
    return null;
  }
  const raw = research.jobId;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePathForArea(path: string): string | null {
  let normalized = path.trim();
  if (!normalized || normalized === "*" || normalized === "**") {
    return null;
  }
  normalized = normalized.replaceAll("\\", "/");
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  normalized = normalized.replace(/^\/+/u, "").replace(/\/+/gu, "/").replace(/\/$/u, "");
  if (!normalized) {
    return null;
  }

  const segments = normalized.split("/");
  const stableSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === "*" || segment === "**") {
      break;
    }
    if (/[*!?[\]{}]/u.test(segment)) {
      break;
    }
    stableSegments.push(segment);
    if (stableSegments.length >= 2) {
      break;
    }
  }

  if (stableSegments.length === 0) {
    const first = segments[0]?.replace(/[*?![\]{}].*$/u, "").trim();
    if (!first) {
      return null;
    }
    stableSegments.push(first);
  }

  const first = stableSegments[0];
  const second = stableSegments[1];
  if (!first) {
    return null;
  }

  if (
    second &&
    (first === "apps" ||
      first === "packages" ||
      first === "docs" ||
      first === "ops" ||
      first === "scripts" ||
      first === "templates" ||
      first === "assets")
  ) {
    return `${first}/${second}`;
  }

  return first;
}

function resolvePathArea(paths: string[] | null | undefined): string | null {
  if (!paths || paths.length === 0) {
    return null;
  }

  const candidates = Array.from(
    new Set(
      paths
        .map((path) => normalizePathForArea(path))
        .filter((path): path is string => Boolean(path)),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return candidates[0] ?? null;
}

export function resolveDeterministicTargetArea(input: ResolveTargetAreaInput): string | null {
  const explicitTargetArea = input.targetArea?.trim();
  if (explicitTargetArea) {
    return explicitTargetArea;
  }

  const touchArea = resolvePathArea(input.touches);
  if (touchArea) {
    return `path:${touchArea}`;
  }

  const allowedPathArea = resolvePathArea(input.allowedPaths);
  if (allowedPathArea) {
    return `path:${allowedPathArea}`;
  }

  if (input.kind === "research") {
    const jobId = resolveResearchJobId(input.context);
    if (jobId) {
      return `research:${jobId}`;
    }
    if (input.id) {
      return `research:task:${input.id}`;
    }
  }

  return null;
}
