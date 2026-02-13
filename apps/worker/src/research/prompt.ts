import type { Task } from "@openTiger/core";
import type { ResearchContextSnapshot, ResearchInput, ResearchSearchResult } from "./types";
import { normalizeResearchStage } from "./stage";

function renderSearchResults(results: ResearchSearchResult[]): string {
  if (results.length === 0) {
    return "(none)";
  }

  return results
    .map((result, index) => {
      const published = result.publishedAt ? `\n  publishedAt: ${result.publishedAt}` : "";
      const source = result.source ? `\n  provider: ${result.source}` : "";
      return [
        `${index + 1}. ${result.title}`,
        `  url: ${result.url}`,
        `  snippet: ${result.snippet}`,
        `${published}${source}`.trimEnd(),
      ]
        .filter((line) => line.trim().length > 0)
        .join("\n");
    })
    .join("\n\n");
}

export function buildResearchPrompt(params: {
  task: Task;
  input: ResearchInput;
  snapshot: ResearchContextSnapshot;
  searchResults: ResearchSearchResult[];
  warnings: string[];
}): string {
  const { task, input, snapshot, searchResults, warnings } = params;
  const stage = normalizeResearchStage(input.stage);

  const claimsContext =
    snapshot.claims.length > 0
      ? snapshot.claims
          .map(
            (claim, index) =>
              `${index + 1}. id=${claim.id} confidence=${claim.confidence} stance=${claim.stance}\n   ${claim.claimText}`,
          )
          .join("\n")
      : "(none)";

  const evidenceContext =
    snapshot.evidence.length > 0
      ? snapshot.evidence
          .slice(0, 50)
          .map((evidence, index) => {
            const source = evidence.sourceUrl ?? "(no url)";
            const title = evidence.sourceTitle ?? "(untitled)";
            return `${index + 1}. claimId=${evidence.claimId ?? "none"} reliability=${evidence.reliability} stance=${evidence.stance}\n   ${title}\n   ${source}\n   ${evidence.snippet ?? ""}`;
          })
          .join("\n")
      : "(none)";

  const stageObjectives =
    stage === "plan"
      ? [
          "Decompose the query into concrete, testable claims.",
          "Prioritize high-impact claims and avoid duplicates.",
          "Do not overstate confidence before evidence collection.",
        ]
      : stage === "collect"
        ? [
            "Collect high-quality evidence for the target claim.",
            "Prefer primary, authoritative, and recent sources.",
            "Extract concrete snippets that support traceable verification.",
          ]
        : stage === "challenge"
          ? [
              "Stress-test current claims with counter-evidence and contradictions.",
              "Lower confidence when evidence is weak or conflicted.",
              "Surface unresolved conflicts explicitly in limitations.",
            ]
          : [
              "Compress all validated findings into a final source-backed report.",
              "Include only verifiable claims and preserve uncertainty.",
              "Every key claim must be tied to at least one source URL.",
            ];

  const stageSpecificRules =
    stage === "plan"
      ? [
          "Return at least 4 claims when the query scope allows it.",
          "Use sources only when essential for framing; evidence depth comes later.",
        ]
      : stage === "collect"
        ? [
            "Focus on the target claim first.",
            "If evidence quality is low, state insufficiency and next actions clearly.",
          ]
        : stage === "challenge"
          ? [
              "Actively search for disconfirming evidence.",
              "When contradictions exist, keep verdict as mixed/refuted unless resolved.",
            ]
          : [
              "Synthesize across all claims and evidence in context.",
              "Do not invent URLs, publication dates, or numbers.",
            ];

  return `
# TigerResearch Task

## Task Title
${task.title}

## Task Goal
${task.goal}

## Research Input
- jobId: ${input.jobId}
- query: ${input.query}
- stage: ${stage}
- profile: ${input.profile}
${input.claimId ? `- claimId: ${input.claimId}` : ""}
${input.claimText ? `- claimText: ${input.claimText}` : ""}
${input.claims && input.claims.length > 0 ? `- seedClaims: ${input.claims.join(" | ")}` : ""}

## Existing Claims
${claimsContext}

## Existing Evidence
${evidenceContext}

## Search Evidence
${renderSearchResults(searchResults)}

## Search Warnings
${warnings.length > 0 ? warnings.map((warning) => `- ${warning}`).join("\n") : "- none"}

## Stage Objectives
${stageObjectives.map((line) => `- ${line}`).join("\n")}

## Stage Rules
${stageSpecificRules.map((line) => `- ${line}`).join("\n")}

## Required Output
Return JSON only with this schema:

\`\`\`json
{
  "summary": "string",
  "confidence": 0,
  "claims": [
    {
      "text": "string",
      "confidence": 0,
      "verdict": "supported",
      "evidenceUrls": ["https://..."]
    }
  ],
  "sources": [
    {
      "url": "https://...",
      "title": "string",
      "reliability": 0,
      "publishedAt": "ISO-8601 optional",
      "snippets": ["string"]
    }
  ],
  "limitations": ["string"],
  "nextActions": ["string"]
}
\`\`\`

Rules:
- confidence and reliability are integers from 0 to 100.
- verdict must be one of: supported, mixed, refuted.
- Every claim should cite at least one evidence URL when available.
- If evidence is insufficient, say so in limitations.
- Use runtime-integrated web search/tools when available to gather additional evidence.
`.trim();
}
