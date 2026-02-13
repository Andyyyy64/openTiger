import type { ResearchClaimOutput, ResearchModelOutput, ResearchSourceOutput } from "./types";

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return Math.round(value);
}

function parseJsonCandidates(raw: string): string[] {
  const codeBlocks = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  const objectCandidates: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index];
    if (ch === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objectCandidates.push(raw.slice(start, index + 1).trim());
        start = -1;
      }
    }
  }

  return [...codeBlocks, ...objectCandidates, raw.trim()];
}

function normalizeClaim(value: unknown): ResearchClaimOutput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) {
    return null;
  }

  const verdictRaw = typeof record.verdict === "string" ? record.verdict.toLowerCase() : "";
  const verdict: ResearchClaimOutput["verdict"] =
    verdictRaw === "mixed" || verdictRaw === "refuted" ? verdictRaw : "supported";

  const evidenceUrls = Array.isArray(record.evidenceUrls)
    ? record.evidenceUrls
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];

  return {
    text,
    confidence: clampScore(Number(record.confidence ?? 0)),
    verdict,
    evidenceUrls,
  };
}

function normalizeSource(value: unknown): ResearchSourceOutput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!url) {
    return null;
  }

  const snippets = Array.isArray(record.snippets)
    ? record.snippets
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];

  return {
    url,
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : url,
    reliability: clampScore(Number(record.reliability ?? 0)),
    publishedAt:
      typeof record.publishedAt === "string" && record.publishedAt.trim()
        ? record.publishedAt.trim()
        : undefined,
    snippets,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function normalizeOutput(raw: unknown): ResearchModelOutput | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) {
    return null;
  }

  const claims = Array.isArray(record.claims)
    ? record.claims
        .map((entry) => normalizeClaim(entry))
        .filter((entry): entry is ResearchClaimOutput => Boolean(entry))
    : [];

  const sources = Array.isArray(record.sources)
    ? record.sources
        .map((entry) => normalizeSource(entry))
        .filter((entry): entry is ResearchSourceOutput => Boolean(entry))
    : [];

  return {
    summary,
    confidence: clampScore(Number(record.confidence ?? 0)),
    claims,
    sources,
    limitations: normalizeStringArray(record.limitations),
    nextActions: normalizeStringArray(record.nextActions),
  };
}

export function parseResearchOutput(stdout: string): ResearchModelOutput {
  const candidates = parseJsonCandidates(stdout);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeOutput(parsed);
      if (normalized) {
        return normalized;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Failed to parse research output as JSON");
}
