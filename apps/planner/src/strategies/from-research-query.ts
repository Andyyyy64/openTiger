import { getPlannerOpenCodeEnv } from "../opencode-config";
import { generateAndParseWithRetry } from "../llm-json-retry";

export interface ResearchClaimCandidate {
  text: string;
  priority: number;
  riskLevel: "low" | "medium" | "high";
}

export interface ResearchQueryPlanResult {
  claims: ResearchClaimCandidate[];
  warnings: string[];
}

function normalizeClaimText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inferRiskLevel(text: string): "low" | "medium" | "high" {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("safety") ||
    normalized.includes("medical") ||
    normalized.includes("finance") ||
    normalized.includes("legal") ||
    normalized.includes("security")
  ) {
    return "high";
  }
  if (
    normalized.includes("trend") ||
    normalized.includes("forecast") ||
    normalized.includes("benchmark") ||
    normalized.includes("compare")
  ) {
    return "medium";
  }
  return "low";
}

function buildPromptFromResearchQuery(query: string, profile: string): string {
  return `
You are a planning agent for TigerResearch.
Given the research query below, decompose it into atomic, testable claims for a high-precision research workflow.
Do not call tools. Use only the provided query text.

## Query
${query}

## Profile
${profile}

## Output Requirements
- Return JSON only.
- Produce 4 to 10 non-overlapping claims when scope allows.
- Each claim should be specific, falsifiable, and evidence-friendly.
- Avoid vague or duplicated claims.
- Prioritize claims that are critical to answering the query.

\`\`\`json
{
  "claims": [
    {
      "text": "string",
      "priority": 1,
      "riskLevel": "low"
    }
  ],
  "warnings": []
}
\`\`\`
`.trim();
}

function isResearchQueryPayload(value: unknown): value is {
  claims: Array<{
    text: string;
    priority?: number;
    riskLevel?: string;
  }>;
  warnings?: string[];
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { claims?: unknown };
  return Array.isArray(record.claims);
}

function normalizeClaims(
  rawClaims: Array<{ text: string; priority?: number; riskLevel?: string }>,
): ResearchClaimCandidate[] {
  const seen = new Set<string>();
  const claims: ResearchClaimCandidate[] = [];

  for (const raw of rawClaims) {
    const text = normalizeClaimText(raw.text);
    if (!text) {
      continue;
    }
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const priority =
      Number.isFinite(raw.priority) && typeof raw.priority === "number"
        ? Math.max(1, Math.min(100, Math.round(raw.priority)))
        : 50;
    const riskLevel =
      raw.riskLevel === "high" || raw.riskLevel === "medium" || raw.riskLevel === "low"
        ? raw.riskLevel
        : inferRiskLevel(text);
    claims.push({
      text,
      priority,
      riskLevel,
    });
  }

  claims.sort((a, b) => b.priority - a.priority);
  return claims;
}

export async function generateResearchPlanFromQuery(
  query: string,
  options: {
    workdir: string;
    profile?: string;
    timeoutSeconds?: number;
  },
): Promise<ResearchQueryPlanResult> {
  const profile = options.profile ?? "high_precision";
  const prompt = buildPromptFromResearchQuery(query, profile);
  const plannerModel = process.env.PLANNER_MODEL ?? "google/gemini-3-pro-preview";

  try {
    const parsed = await generateAndParseWithRetry<{
      claims: Array<{ text: string; priority?: number; riskLevel?: string }>;
      warnings?: string[];
    }>({
      workdir: options.workdir,
      model: plannerModel,
      prompt,
      timeoutSeconds: options.timeoutSeconds ?? 180,
      env: getPlannerOpenCodeEnv(),
      guard: isResearchQueryPayload,
      label: "Research query planning",
    });

    const claims = normalizeClaims(parsed.claims);
    if (claims.length > 0) {
      return {
        claims,
        warnings: parsed.warnings ?? [],
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      claims: [
        {
          text: query.trim(),
          priority: 100,
          riskLevel: inferRiskLevel(query),
        },
      ],
      warnings: [`LLM claim decomposition failed; fallback used: ${message}`],
    };
  }

  return {
    claims: [
      {
        text: query.trim(),
        priority: 100,
        riskLevel: inferRiskLevel(query),
      },
    ],
    warnings: ["No valid claims returned by LLM; fallback used."],
  };
}
