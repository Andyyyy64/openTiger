import type { Requirement, RequirementFieldName, RiskItem } from "./parser";
import { generateAndParseWithRetry } from "./llm-json-retry";
import { getPlannerOpenCodeEnv } from "./opencode-config";

interface RequirementCompletionPayload {
  goal?: string;
  background?: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  scope?: {
    inScope?: string[];
    outOfScope?: string[];
  };
  allowedPaths?: string[];
  riskAssessment?: Array<{
    risk?: string;
    impact?: string;
    mitigation?: string;
  }>;
  notes?: string;
  warnings?: string[];
}

function isRequirementCompletionPayload(value: unknown): value is RequirementCompletionPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  return true;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringList(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const list: string[] = [];
  for (const item of value) {
    const normalized = normalizeString(item);
    if (!normalized) {
      continue;
    }
    if (!list.includes(normalized)) {
      list.push(normalized);
    }
    if (list.length >= maxItems) {
      break;
    }
  }
  return list;
}

function normalizeRiskImpact(value: unknown): "high" | "medium" | "low" {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  if (normalized === "h") {
    return "high";
  }
  if (normalized === "m") {
    return "medium";
  }
  if (normalized === "l") {
    return "low";
  }
  return "medium";
}

function normalizeRiskAssessment(value: unknown): RiskItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const risks: RiskItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const risk = normalizeString(record.risk);
    const mitigation = normalizeString(record.mitigation);
    if (!risk || !mitigation) {
      continue;
    }
    risks.push({
      risk,
      impact: normalizeRiskImpact(record.impact),
      mitigation,
    });
    if (risks.length >= 20) {
      break;
    }
  }
  return risks;
}

function buildCompletionPrompt(params: {
  rawContent: string;
  current: Requirement;
  missingFields: RequirementFieldName[];
}): string {
  const currentSummary = JSON.stringify(
    {
      goal: params.current.goal,
      background: params.current.background,
      constraints: params.current.constraints,
      acceptanceCriteria: params.current.acceptanceCriteria,
      scope: params.current.scope,
      allowedPaths: params.current.allowedPaths,
      riskAssessment: params.current.riskAssessment,
      notes: params.current.notes,
    },
    null,
    2,
  );

  return `
You normalize rough requirement text into a structured planning requirement.
Use the user's text as source of truth and infer only what is reasonably implied.
Do not call tools. Output JSON only.

## Missing Fields To Complete
${params.missingFields.map((field) => `- ${field}`).join("\n")}

## Raw Requirement Text
\`\`\`
${params.rawContent}
\`\`\`

## Current Parsed Draft (fallback parser output)
\`\`\`json
${currentSummary}
\`\`\`

## Completion Rules
- Fill missing fields with practical, minimal content.
- Keep acceptance criteria verifiable and concrete.
- Infer allowedPaths from requirement intent when possible.
- If allowedPaths cannot be inferred safely, return ["**"].
- Keep constraints and scope realistic; avoid over-committing details.
- Keep risk assessment concise and actionable.

## Output JSON Schema
\`\`\`json
{
  "goal": "string",
  "background": "string",
  "constraints": ["string"],
  "acceptanceCriteria": ["string"],
  "scope": {
    "inScope": ["string"],
    "outOfScope": ["string"]
  },
  "allowedPaths": ["string"],
  "riskAssessment": [
    { "risk": "string", "impact": "low|medium|high", "mitigation": "string" }
  ],
  "notes": "string",
  "warnings": ["string"]
}
\`\`\`
`.trim();
}

export async function completeRequirementWithLlm(params: {
  workdir: string;
  timeoutSeconds: number;
  rawContent: string;
  current: Requirement;
  missingFields: RequirementFieldName[];
}): Promise<{ requirement: Requirement; warnings: string[] }> {
  const plannerModel = process.env.PLANNER_MODEL ?? "google/gemini-3-pro-preview";
  const prompt = buildCompletionPrompt(params);
  const payload = await generateAndParseWithRetry<RequirementCompletionPayload>({
    workdir: params.workdir,
    model: plannerModel,
    prompt,
    timeoutSeconds: Math.min(params.timeoutSeconds, 300),
    env: getPlannerOpenCodeEnv(),
    guard: isRequirementCompletionPayload,
    label: "Requirement completion",
  });

  const missing = new Set(params.missingFields);
  const next: Requirement = { ...params.current };

  if (missing.has("goal")) {
    next.goal = normalizeString(payload.goal) ?? next.goal;
  }
  if (missing.has("background")) {
    next.background = normalizeString(payload.background) ?? next.background;
  }
  if (missing.has("constraints")) {
    const constraints = normalizeStringList(payload.constraints);
    if (constraints.length > 0) {
      next.constraints = constraints;
    }
  }
  if (missing.has("acceptanceCriteria")) {
    const acceptance = normalizeStringList(payload.acceptanceCriteria);
    if (acceptance.length > 0) {
      next.acceptanceCriteria = acceptance;
    }
  }
  if (missing.has("scope")) {
    const inScope = normalizeStringList(payload.scope?.inScope);
    const outOfScope = normalizeStringList(payload.scope?.outOfScope);
    if (inScope.length > 0 || outOfScope.length > 0) {
      next.scope = {
        inScope: inScope.length > 0 ? inScope : next.scope.inScope,
        outOfScope: outOfScope.length > 0 ? outOfScope : next.scope.outOfScope,
      };
    }
  }
  if (missing.has("allowedPaths")) {
    const allowedPaths = normalizeStringList(payload.allowedPaths, 30);
    if (allowedPaths.length > 0) {
      next.allowedPaths = allowedPaths;
    }
  }
  if (missing.has("riskAssessment")) {
    const risks = normalizeRiskAssessment(payload.riskAssessment);
    if (risks.length > 0) {
      next.riskAssessment = risks;
    }
  }
  if (missing.has("notes")) {
    const notes = normalizeString(payload.notes);
    if (notes) {
      next.notes = notes;
    }
  }

  const warnings = normalizeStringList(payload.warnings, 10);
  return { requirement: next, warnings };
}
