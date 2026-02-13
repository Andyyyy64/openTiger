import { db } from "@openTiger/db";
import {
  researchClaims,
  researchEvidence,
  researchJobs,
  researchReports,
} from "@openTiger/db/schema";
import { desc, eq } from "drizzle-orm";
import type { EvaluationSummary, JudgeResult } from "./pr-reviewer";
import type { PendingResearchRun } from "./judge-pending";

type ResearchJudgeMetrics = {
  claimCount: number;
  evidenceCount: number;
  reportCount: number;
  latestReportConfidence: number;
};

function parseThreshold(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return fallback;
  }
  return raw;
}

function parseFloatThreshold(name: string, fallback: number): number {
  const raw = Number.parseFloat(process.env[name] ?? "");
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return raw;
}

function parseBooleanThreshold(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  if (raw === "1" || raw.toLowerCase() === "true") {
    return true;
  }
  if (raw === "0" || raw.toLowerCase() === "false") {
    return false;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractDomain(urlValue: string | null): string | null {
  if (!urlValue) {
    return null;
  }
  try {
    return new URL(urlValue).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 100) {
    return 1;
  }
  return value / 100;
}

export async function evaluateResearchRun(
  pending: PendingResearchRun,
): Promise<{ result: JudgeResult; summary: EvaluationSummary; metrics: ResearchJudgeMetrics }> {
  const minClaims = parseThreshold("JUDGE_RESEARCH_MIN_CLAIMS", 1);
  const minEvidencePerClaim = parseThreshold("JUDGE_RESEARCH_MIN_EVIDENCE_PER_CLAIM", 3);
  const minDistinctDomainsPerClaim = parseThreshold(
    "JUDGE_RESEARCH_MIN_DISTINCT_DOMAINS_PER_CLAIM",
    2,
  );
  const requireCounterEvidence = parseBooleanThreshold(
    "JUDGE_RESEARCH_REQUIRE_COUNTER_EVIDENCE",
    true,
  );
  const minConfidence = parseThreshold("JUDGE_RESEARCH_MIN_CONFIDENCE", 70);
  const minVerifiableRatio = Math.max(
    0,
    Math.min(1, parseFloatThreshold("JUDGE_RESEARCH_MIN_VERIFIABLE_RATIO", 0.9)),
  );

  const [latestReportRows, claimRows, evidenceRows, reportRows] = await Promise.all([
    db
      .select({
        id: researchReports.id,
        confidence: researchReports.confidence,
        createdAt: researchReports.createdAt,
      })
      .from(researchReports)
      .where(eq(researchReports.jobId, pending.researchJobId))
      .orderBy(desc(researchReports.createdAt))
      .limit(1),
    db
      .select({
        id: researchClaims.id,
        metadata: researchClaims.metadata,
      })
      .from(researchClaims)
      .where(eq(researchClaims.jobId, pending.researchJobId)),
    db
      .select({
        claimId: researchEvidence.claimId,
        sourceUrl: researchEvidence.sourceUrl,
        stance: researchEvidence.stance,
      })
      .from(researchEvidence)
      .where(eq(researchEvidence.jobId, pending.researchJobId)),
    db
      .select({
        id: researchReports.id,
      })
      .from(researchReports)
      .where(eq(researchReports.jobId, pending.researchJobId)),
  ]);

  const latest = latestReportRows[0];
  const claimCount = claimRows.length;
  const evidenceCount = evidenceRows.length;
  const reportCount = reportRows.length;
  const reportConfidence = latest?.confidence ?? 0;

  const ciReasons: string[] = [];
  const ciSuggestions: string[] = [];
  if (!latest || reportCount <= 0) {
    ciReasons.push("No research report generated for this job.");
    ciSuggestions.push("Run collect/challenge/write stages until a report artifact is produced.");
  }

  const policyReasons: string[] = [];
  const policySuggestions: string[] = [];
  const policyViolations: Array<{
    type: "lines" | "files" | "path" | "command" | "pattern";
    severity: "error" | "warning";
    message: string;
  }> = [];

  if (claimCount < minClaims) {
    policyReasons.push(`Insufficient claims: ${claimCount}/${minClaims}`);
    policySuggestions.push("Add clearer, testable claims before finalizing.");
    policyViolations.push({
      type: "pattern",
      severity: "error",
      message: `research_claims below threshold (${claimCount} < ${minClaims})`,
    });
  }

  const evidenceByClaim = new Map<
    string,
    { evidenceCount: number; domains: Set<string>; counterEvidence: number }
  >();
  for (const claim of claimRows) {
    evidenceByClaim.set(claim.id, {
      evidenceCount: 0,
      domains: new Set<string>(),
      counterEvidence: 0,
    });
  }
  for (const evidence of evidenceRows) {
    if (!evidence.claimId) {
      continue;
    }
    const bucket = evidenceByClaim.get(evidence.claimId);
    if (!bucket) {
      continue;
    }
    bucket.evidenceCount += 1;
    const domain = extractDomain(evidence.sourceUrl);
    if (domain) {
      bucket.domains.add(domain);
    }
    if (evidence.stance === "contradicting") {
      bucket.counterEvidence += 1;
    }
  }

  let verifiableClaimCount = 0;
  for (const claim of claimRows) {
    const bucket = evidenceByClaim.get(claim.id);
    const evidencePerClaim = bucket?.evidenceCount ?? 0;
    const distinctDomainCount = bucket?.domains.size ?? 0;
    const counterEvidenceCount = bucket?.counterEvidence ?? 0;

    if (evidencePerClaim < minEvidencePerClaim) {
      policyReasons.push(
        `Claim ${claim.id} lacks evidence (${evidencePerClaim}/${minEvidencePerClaim}).`,
      );
      policyViolations.push({
        type: "pattern",
        severity: "error",
        message: `claim ${claim.id} evidence below threshold`,
      });
    }
    if (distinctDomainCount < minDistinctDomainsPerClaim) {
      policyReasons.push(
        `Claim ${claim.id} lacks domain diversity (${distinctDomainCount}/${minDistinctDomainsPerClaim}).`,
      );
      policyViolations.push({
        type: "pattern",
        severity: "error",
        message: `claim ${claim.id} domain diversity below threshold`,
      });
    }
    if (requireCounterEvidence && counterEvidenceCount <= 0) {
      policyReasons.push(`Claim ${claim.id} has no counter-evidence.`);
      policyViolations.push({
        type: "pattern",
        severity: "error",
        message: `claim ${claim.id} has no counter-evidence`,
      });
    }

    const claimMetadata = asRecord(claim.metadata);
    const hasCitations =
      Array.isArray(claimMetadata.evidenceUrls) &&
      claimMetadata.evidenceUrls.some((url) => typeof url === "string" && url.trim().length > 0);
    if (!hasCitations) {
      policyReasons.push(`Claim ${claim.id} is missing citation links.`);
      policyViolations.push({
        type: "pattern",
        severity: "error",
        message: `claim ${claim.id} citation coverage is incomplete`,
      });
    }

    const isVerifiable =
      evidencePerClaim >= minEvidencePerClaim &&
      distinctDomainCount >= minDistinctDomainsPerClaim &&
      (!requireCounterEvidence || counterEvidenceCount > 0) &&
      hasCitations;
    if (isVerifiable) {
      verifiableClaimCount += 1;
    }
  }

  const verifiableRatio = claimRows.length > 0 ? verifiableClaimCount / claimRows.length : 0;
  if (verifiableRatio < minVerifiableRatio) {
    policyReasons.push(
      `Verifiable claim ratio below threshold (${verifiableRatio.toFixed(2)} < ${minVerifiableRatio.toFixed(2)}).`,
    );
    policyViolations.push({
      type: "pattern",
      severity: "error",
      message: `verifiable ratio below threshold (${verifiableRatio.toFixed(2)})`,
    });
  }
  if (policyReasons.length > 0) {
    policySuggestions.push("Increase evidence depth, source diversity, and citation completeness.");
  }

  const llmConfidence = normalizeConfidence(reportConfidence);
  const llmReasons: string[] = [];
  const llmSuggestions: string[] = [];
  const llmCodeIssues: Array<{
    severity: "error" | "warning" | "info";
    category: "bug" | "security" | "performance" | "style" | "maintainability";
    message: string;
  }> = [];

  if (!latest) {
    llmReasons.push("Research summary is missing.");
  } else if (reportConfidence < minConfidence) {
    llmReasons.push(`Report confidence below threshold: ${reportConfidence}/${minConfidence}`);
    llmSuggestions.push("Increase cross-source validation and reduce unsupported claims.");
    llmCodeIssues.push({
      severity: "warning",
      category: "maintainability",
      message: "Research confidence is too low for approval.",
    });
  }

  const summary: EvaluationSummary = {
    ci: {
      pass: ciReasons.length === 0,
      status: ciReasons.length === 0 ? "success" : "failure",
      reasons: ciReasons,
      suggestions: ciSuggestions,
      details: [],
    },
    policy: {
      pass: policyReasons.length === 0,
      reasons: policyReasons,
      suggestions: policySuggestions,
      violations: policyViolations,
    },
    llm: {
      pass: llmReasons.length === 0,
      confidence: llmConfidence,
      reasons: llmReasons,
      suggestions: llmSuggestions,
      codeIssues: llmCodeIssues,
    },
  };

  const approved = summary.ci.pass && summary.policy.pass && summary.llm.pass;

  const result: JudgeResult = {
    verdict: approved ? "approve" : "request_changes",
    reasons: [...summary.ci.reasons, ...summary.policy.reasons, ...summary.llm.reasons],
    suggestions: [...summary.policy.suggestions, ...summary.llm.suggestions],
    autoMerge: false,
    riskLevel: pending.taskRiskLevel,
    confidence: llmConfidence,
  };

  return {
    result,
    summary,
    metrics: {
      claimCount,
      evidenceCount,
      reportCount,
      latestReportConfidence: reportConfidence,
    },
  };
}

export async function markResearchJobAfterJudge(params: {
  jobId: string;
  verdict: "approve" | "request_changes";
  runId: string;
  agentId: string;
  notes: string[];
  statusOverride?: "queued" | "blocked" | "done";
}): Promise<void> {
  const status = params.statusOverride ?? (params.verdict === "approve" ? "done" : "blocked");
  const [current] = await db
    .select({ metadata: researchJobs.metadata })
    .from(researchJobs)
    .where(eq(researchJobs.id, params.jobId))
    .limit(1);

  const existingMetadata =
    current &&
    typeof current.metadata === "object" &&
    current.metadata &&
    !Array.isArray(current.metadata)
      ? (current.metadata as Record<string, unknown>)
      : {};

  await db
    .update(researchJobs)
    .set({
      status,
      updatedAt: new Date(),
      metadata: {
        ...existingMetadata,
        lastJudgeRunId: params.runId,
        lastJudgeAgentId: params.agentId,
        lastJudgeVerdict: params.verdict,
        lastJudgeNotes: params.notes,
      },
    })
    .where(eq(researchJobs.id, params.jobId));
}
