import { db } from "@openTiger/db";
import { events, runs, tasks } from "@openTiger/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import type {
  JudgeHookEvaluationResult,
  JudgeHookPendingTarget,
  JudgeHook,
} from "@openTiger/plugin-sdk";
import { researchClaims, researchEvidence, researchJobs, researchReports } from "../db";
import { getResearchProfileConfig, resolveResearchStrengthProfile } from "../profile";

type PendingResearchRun = {
  taskId: string;
  runId: string;
  startedAt: Date;
  taskTitle: string;
  taskGoal: string;
  taskRiskLevel: "low" | "medium" | "high";
  researchJobId: string;
  role: string;
};

type ResearchJudgeMetrics = {
  claimCount: number;
  evidenceCount: number;
  reportCount: number;
  latestReportConfidence: number;
};

type ResearchEvaluationData = {
  summary: {
    ci: {
      pass: boolean;
      status: "success" | "failure";
      reasons: string[];
      suggestions: string[];
      details: unknown[];
    };
    policy: {
      pass: boolean;
      reasons: string[];
      suggestions: string[];
      violations: Array<{
        type: "lines" | "files" | "path" | "command" | "pattern";
        severity: "error" | "warning";
        message: string;
      }>;
    };
    llm: {
      pass: boolean;
      confidence: number;
      reasons: string[];
      suggestions: string[];
      codeIssues: Array<{
        severity: "error" | "warning" | "info";
        category: "bug" | "security" | "performance" | "style" | "maintainability";
        message: string;
      }>;
    };
  };
  metrics: ResearchJudgeMetrics;
  researchJobId: string;
  role: string;
  riskLevel: "low" | "medium" | "high";
  confidence: number;
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

function resolveResearchStage(context: unknown): string | null {
  if (!isRecord(context)) {
    return null;
  }
  const research = context.research;
  if (!isRecord(research)) {
    return null;
  }
  const raw = research.stage;
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "write" ||
    normalized === "compose" ||
    normalized === "composing" ||
    normalized === "report"
  ) {
    return "write";
  }
  return normalized.length > 0 ? normalized : null;
}

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

async function getPendingResearchRuns(): Promise<PendingResearchRun[]> {
  const rows = await db
    .select({
      taskId: runs.taskId,
      runId: runs.id,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(runs.status, "success"),
        isNull(runs.judgedAt),
        eq(tasks.kind, "research"),
        eq(tasks.status, "blocked"),
        eq(tasks.blockReason, "awaiting_judge"),
      ),
    )
    .orderBy(desc(runs.startedAt));

  const result: PendingResearchRun[] = [];
  const seenTaskIds = new Set<string>();

  for (const row of rows) {
    if (seenTaskIds.has(row.taskId)) {
      continue;
    }

    const [task] = await db.select().from(tasks).where(eq(tasks.id, row.taskId)).limit(1);
    if (!task) {
      continue;
    }

    const researchJobId = resolveResearchJobId(task.context);
    if (!researchJobId) {
      continue;
    }
    const researchStage = resolveResearchStage(task.context);
    if (researchStage !== "write") {
      continue;
    }

    result.push({
      taskId: row.taskId,
      runId: row.runId,
      startedAt: row.startedAt,
      taskTitle: task.title,
      taskGoal: task.goal,
      taskRiskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
      researchJobId,
      role: task.role ?? "worker",
    });
    seenTaskIds.add(row.taskId);
  }

  return result;
}

async function getPendingResearchRunByTarget(
  target: JudgeHookPendingTarget,
): Promise<PendingResearchRun | null> {
  const [row] = await db
    .select({
      taskId: runs.taskId,
      runId: runs.id,
      startedAt: runs.startedAt,
      taskTitle: tasks.title,
      taskGoal: tasks.goal,
      taskRiskLevel: tasks.riskLevel,
      taskRole: tasks.role,
      context: tasks.context,
      runStatus: runs.status,
      judgedAt: runs.judgedAt,
      taskKind: tasks.kind,
      taskStatus: tasks.status,
      blockReason: tasks.blockReason,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(runs.id, target.runId), eq(runs.taskId, target.taskId)))
    .limit(1);

  if (!row) {
    return null;
  }
  if (row.runStatus !== "success" || row.judgedAt !== null) {
    return null;
  }
  if (
    row.taskKind !== "research" ||
    row.taskStatus !== "blocked" ||
    row.blockReason !== "awaiting_judge"
  ) {
    return null;
  }

  const researchJobId = resolveResearchJobId(row.context);
  if (!researchJobId) {
    return null;
  }
  const researchStage = resolveResearchStage(row.context);
  if (researchStage !== "write") {
    return null;
  }

  return {
    taskId: row.taskId,
    runId: row.runId,
    startedAt: row.startedAt,
    taskTitle: row.taskTitle,
    taskGoal: row.taskGoal,
    taskRiskLevel: (row.taskRiskLevel as "low" | "medium" | "high") ?? "low",
    researchJobId,
    role: row.taskRole ?? "worker",
  };
}

async function evaluateResearchRun(pending: PendingResearchRun): Promise<{
  result: {
    verdict: "approve" | "request_changes";
    reasons: string[];
    suggestions: string[];
    confidence: number;
  };
  summary: ResearchEvaluationData["summary"];
  metrics: ResearchJudgeMetrics;
}> {
  const [jobRow] = await db
    .select({ qualityProfile: researchJobs.qualityProfile })
    .from(researchJobs)
    .where(eq(researchJobs.id, pending.researchJobId))
    .limit(1);
  const profile = resolveResearchStrengthProfile(jobRow?.qualityProfile);
  const profileConfig = getResearchProfileConfig(profile);
  const minClaims = profileConfig.planner.claimCount.min;
  const minEvidencePerClaim = profileConfig.quality.minEvidencePerClaim;
  const minDistinctDomainsPerClaim = profileConfig.quality.minDistinctDomainsPerClaim;
  const requireCounterEvidence = profileConfig.quality.requireCounterEvidence;
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

  const summary: ResearchEvaluationData["summary"] = {
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

  return {
    result: {
      verdict: approved ? "approve" : "request_changes",
      reasons: [...summary.ci.reasons, ...summary.policy.reasons, ...summary.llm.reasons],
      suggestions: [...summary.policy.suggestions, ...summary.llm.suggestions],
      confidence: llmConfidence,
    },
    summary,
    metrics: {
      claimCount,
      evidenceCount,
      reportCount,
      latestReportConfidence: reportConfidence,
    },
  };
}

async function markResearchJobAfterJudge(params: {
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

function asResearchEvaluationData(value: unknown): ResearchEvaluationData | null {
  if (!isRecord(value)) {
    return null;
  }
  const summary = value.summary;
  const metrics = value.metrics;
  if (!isRecord(summary) || !isRecord(metrics)) {
    return null;
  }
  return value as ResearchEvaluationData;
}

async function recordResearchReviewEvent(params: {
  target: PendingResearchRun;
  result: JudgeHookEvaluationResult;
  data: ResearchEvaluationData | null;
  agentId: string;
  dryRun: boolean;
  approved: boolean;
  blocked: boolean;
}): Promise<void> {
  try {
    await db.insert(events).values({
      type: "judge.review",
      entityType: "task",
      entityId: params.target.taskId,
      agentId: params.agentId,
      payload: {
        mode: "research",
        taskId: params.target.taskId,
        runId: params.target.runId,
        researchJobId: params.target.researchJobId,
        role: params.target.role,
        verdict: params.result.verdict,
        autoMerge: false,
        riskLevel: params.target.taskRiskLevel,
        confidence: params.data?.confidence ?? 0,
        reasons: params.result.reasons,
        suggestions: params.result.suggestions ?? [],
        summary: params.data?.summary ?? null,
        metrics: params.data?.metrics ?? null,
        actions: {
          commented: false,
          approved: params.approved,
          merged: false,
          requeued: false,
          blocked: params.blocked,
        },
        dryRun: params.dryRun,
      },
    });
  } catch (error) {
    console.error(
      `[TigerResearch/Judge] Failed to record research review for run ${params.target.runId}:`,
      error,
    );
  }
}

async function collectPendingTargets(): Promise<JudgeHookPendingTarget[]> {
  const pending = await getPendingResearchRuns();
  return pending.map((item) => ({ taskId: item.taskId, runId: item.runId }));
}

async function evaluateTarget(target: JudgeHookPendingTarget): Promise<JudgeHookEvaluationResult> {
  const pending = await getPendingResearchRunByTarget(target);
  if (!pending) {
    return {
      verdict: "request_changes",
      reasons: ["Research run is no longer pending for judge review."],
      suggestions: [],
    };
  }

  const { result, summary, metrics } = await evaluateResearchRun(pending);
  const data: ResearchEvaluationData = {
    summary,
    metrics,
    researchJobId: pending.researchJobId,
    role: pending.role,
    riskLevel: pending.taskRiskLevel,
    confidence: result.confidence,
  };

  return {
    verdict: result.verdict,
    reasons: result.reasons,
    suggestions: result.suggestions,
    data,
  };
}

async function applyVerdict(params: {
  target: JudgeHookPendingTarget;
  result: JudgeHookEvaluationResult;
  agentId: string;
  dryRun: boolean;
}): Promise<void> {
  const pending = await getPendingResearchRunByTarget(params.target);
  if (!pending) {
    return;
  }

  const data = asResearchEvaluationData(params.result.data);
  let approved = false;
  let blocked = false;

  if (!params.dryRun) {
    if (params.result.verdict === "approve") {
      await db
        .update(tasks)
        .set({
          status: "done",
          blockReason: null,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, pending.taskId));
      await markResearchJobAfterJudge({
        jobId: pending.researchJobId,
        verdict: "approve",
        runId: pending.runId,
        agentId: params.agentId,
        notes: params.result.reasons,
        statusOverride: "done",
      });
      approved = true;
    } else {
      await db
        .update(tasks)
        .set({
          status: "blocked",
          blockReason: "needs_rework",
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, pending.taskId));
      await markResearchJobAfterJudge({
        jobId: pending.researchJobId,
        verdict: "request_changes",
        runId: pending.runId,
        agentId: params.agentId,
        notes: params.result.reasons,
        statusOverride: "blocked",
      });
      blocked = true;
    }
  }

  await recordResearchReviewEvent({
    target: pending,
    result: params.result,
    data,
    agentId: params.agentId,
    dryRun: params.dryRun,
    approved,
    blocked,
  });
}

export const tigerResearchJudgeHook: JudgeHook = {
  reviewMode: "research",
  collectPendingTargets,
  evaluateTarget,
  applyVerdict,
};
