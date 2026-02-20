import type { ResearchClaimOutput, ResearchModelOutput, ResearchSourceOutput } from "./types";

const ANSI_ESCAPE_SEQUENCE = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const ANSI_ESCAPE_REGEX = new RegExp(ANSI_ESCAPE_SEQUENCE, "g");
const CONTROL_CHARS_CLASS = `${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const CONTROL_CHARS_REGEX = new RegExp(`[${CONTROL_CHARS_CLASS}]+`, "g");

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

function stripControlChars(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "").replace(CONTROL_CHARS_REGEX, "");
}

function appendMissingJsonClosers(value: string): string {
  const stack: ("{" | "[")[] = [];
  let inString = false;
  let escaping = false;

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (!ch) {
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      if (stack[stack.length - 1] === expected) {
        stack.pop();
      }
    }
  }

  let patched = value.trim();
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const opener = stack[index];
    patched += opener === "{" ? "}" : "]";
  }
  return patched;
}

function buildCandidateVariants(candidate: string): string[] {
  const normalized = stripControlChars(candidate).trim();
  if (!normalized) {
    return [];
  }

  const noTrailingCommas = normalized.replace(/,\s*([}\]])/g, "$1");
  const closed = appendMissingJsonClosers(noTrailingCommas);
  const variants = [normalized, noTrailingCommas, closed];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of variants) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function parseJsonCandidates(raw: string): string[] {
  const normalized = stripControlChars(raw);
  const codeBlocks = [...normalized.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  const objectCandidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const ch = normalized[index];
    if (!ch) {
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

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
        objectCandidates.push(normalized.slice(start, index + 1).trim());
        start = -1;
      }
    }
  }

  return [...codeBlocks, ...objectCandidates, normalized.trim()];
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
    for (const variant of buildCandidateVariants(candidate)) {
      try {
        const parsed = JSON.parse(variant);
        const normalized = normalizeOutput(parsed);
        if (normalized) {
          return normalized;
        }
      } catch {
        continue;
      }
    }
  }

  throw new Error("Failed to parse research output as JSON");
}
