import { db } from "@openTiger/db";
import {
  researchClaims,
  researchEvidence,
  researchJobs,
  researchReports,
  tasks,
} from "@openTiger/db/schema";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

type ResearchStage = "plan" | "collect" | "challenge" | "write";

type ResearchTaskContext = {
  jobId?: string;
  query?: string;
  stage?: string;
  profile?: string;
  claimId?: string;
  claimText?: string;
  claims?: string[];
};

type ClaimProgress = {
  claimId: string;
  claimText: string;
  confidence: number;
  evidenceCount: number;
  distinctDomainCount: number;
  counterEvidenceCount: number;
  collectAttempts: number;
  challengeAttempts: number;
  hasCollectDone: boolean;
  hasChallengeDone: boolean;
  hasActiveCollect: boolean;
  hasActiveChallenge: boolean;
};

type QualityThresholds = {
  maxConcurrency: number;
  maxDepth: number;
  minEvidencePerClaim: number;
  minDistinctDomainsPerClaim: number;
  requireCounterEvidence: boolean;
  minReportConfidence: number;
  minVerifiableRatio: number;
};

export type ResearchQualityGateResult = {
  pass: boolean;
  reasons: string[];
  insufficientClaimIds: string[];
  challengeClaimIds: string[];
  metrics: {
    claimCount: number;
    verifiableRatio: number;
    reportConfidence: number;
  };
};

function parseEnvInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return fallback;
  }
  return raw;
}

function parseEnvFloat(name: string, fallback: number): number {
  const raw = Number.parseFloat(process.env[name] ?? "");
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return raw;
}

function parseEnvBool(name: string, fallback: boolean): boolean {
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

function readThresholds(): QualityThresholds {
  return {
    maxConcurrency: Math.max(1, parseEnvInt("RESEARCH_MAX_CONCURRENCY", 6)),
    maxDepth: Math.max(1, parseEnvInt("RESEARCH_MAX_DEPTH", 3)),
    minEvidencePerClaim: Math.max(1, parseEnvInt("RESEARCH_MIN_EVIDENCE_PER_CLAIM", 3)),
    minDistinctDomainsPerClaim: Math.max(
      1,
      parseEnvInt("RESEARCH_MIN_DISTINCT_DOMAINS_PER_CLAIM", 2),
    ),
    requireCounterEvidence: parseEnvBool("RESEARCH_REQUIRE_COUNTER_EVIDENCE", true),
    minReportConfidence: Math.max(
      0,
      Math.min(100, parseEnvInt("RESEARCH_MIN_REPORT_CONFIDENCE", 70)),
    ),
    minVerifiableRatio: Math.max(
      0,
      Math.min(1, parseEnvFloat("RESEARCH_MIN_VERIFIABLE_RATIO", 0.9)),
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

export function normalizeResearchStage(value: string | undefined): ResearchStage {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "plan" ||
    normalized === "planning" ||
    normalized === "decompose" ||
    normalized === "decomposition"
  ) {
    return "plan";
  }
  if (normalized === "challenge" || normalized === "challenging") {
    return "challenge";
  }
  if (
    normalized === "write" ||
    normalized === "compose" ||
    normalized === "composing" ||
    normalized === "report"
  ) {
    return "write";
  }
  return "collect";
}

function readResearchTaskContext(taskContext: unknown): ResearchTaskContext {
  const context = asRecord(taskContext);
  const research = asRecord(context.research);
  return {
    jobId: asString(research.jobId),
    query: asString(research.query),
    stage: asString(research.stage),
    profile: asString(research.profile),
    claimId: asString(research.claimId),
    claimText: asString(research.claimText),
    claims: Array.isArray(research.claims)
      ? research.claims
          .map((value) => asString(value))
          .filter((value): value is string => Boolean(value))
      : undefined,
  };
}

function isTaskActive(task: { status: string; blockReason: string | null }): boolean {
  if (task.status === "queued" || task.status === "running") {
    return true;
  }
  return task.status === "blocked" && task.blockReason === "awaiting_judge";
}

function extractDomain(urlValue: string | null): string | null {
  if (!urlValue) {
    return null;
  }
  try {
    const parsed = new URL(urlValue);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function stageLabel(stage: ResearchStage): string {
  if (stage === "plan") {
    return "Plan";
  }
  if (stage === "collect") {
    return "Collect";
  }
  if (stage === "challenge") {
    return "Challenge";
  }
  return "Write";
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}...`;
}

function buildTaskTitle(stage: ResearchStage, query: string, claimText?: string): string {
  if (claimText) {
    return `[Research/${stageLabel(stage)}] ${truncateText(claimText, 72)}`;
  }
  return `[Research/${stageLabel(stage)}] ${truncateText(query, 72)}`;
}

function buildTaskGoal(stage: ResearchStage): string {
  if (stage === "plan") {
    return "Decompose the research query into concrete claims for parallel investigation.";
  }
  if (stage === "collect") {
    return "Collect high-quality supporting evidence for the target claim.";
  }
  if (stage === "challenge") {
    return "Challenge the target claim with contradictory or independent evidence.";
  }
  return "Synthesize validated claims and evidence into a source-cited final report.";
}

function countAttemptsForClaim(
  rows: Array<{ context: unknown; status: string; blockReason: string | null }>,
  stage: ResearchStage,
  claimId: string,
): number {
  return rows.filter((row) => {
    const context = readResearchTaskContext(row.context);
    return normalizeResearchStage(context.stage) === stage && context.claimId === claimId;
  }).length;
}

function hasDoneStageForClaim(
  rows: Array<{ context: unknown; status: string; blockReason: string | null }>,
  stage: ResearchStage,
  claimId: string,
): boolean {
  return rows.some((row) => {
    if (row.status !== "done") {
      return false;
    }
    const context = readResearchTaskContext(row.context);
    return normalizeResearchStage(context.stage) === stage && context.claimId === claimId;
  });
}

function hasActiveStageForClaim(
  rows: Array<{ context: unknown; status: string; blockReason: string | null }>,
  stage: ResearchStage,
  claimId: string,
): boolean {
  return rows.some((row) => {
    if (!isTaskActive(row)) {
      return false;
    }
    const context = readResearchTaskContext(row.context);
    return normalizeResearchStage(context.stage) === stage && context.claimId === claimId;
  });
}

function hasAnyTaskForStage(
  rows: Array<{ context: unknown; status: string; blockReason: string | null }>,
  stage: ResearchStage,
  includeDone: boolean,
): boolean {
  return rows.some((row) => {
    if (!includeDone && !isTaskActive(row)) {
      return false;
    }
    if (includeDone && row.status !== "done" && !isTaskActive(row)) {
      return false;
    }
    const context = readResearchTaskContext(row.context);
    return normalizeResearchStage(context.stage) === stage;
  });
}

function hasFreshReport(
  report: { createdAt: Date } | undefined,
  claims: Array<{ updatedAt: Date }>,
  evidence: Array<{ createdAt: Date }>,
): boolean {
  if (!report) {
    return false;
  }
  const reportAt = report.createdAt.getTime();
  const latestClaimAt = claims.reduce((acc, claim) => Math.max(acc, claim.updatedAt.getTime()), 0);
  const latestEvidenceAt = evidence.reduce(
    (acc, evidenceRow) => Math.max(acc, evidenceRow.createdAt.getTime()),
    0,
  );
  return reportAt >= latestClaimAt && reportAt >= latestEvidenceAt;
}

export function evaluateResearchQualityGate(
  input: {
    claims: Array<{ id: string; confidence: number }>;
    claimProgress: ClaimProgress[];
    latestReportConfidence: number;
    claimCitationCoverage: Array<{ claimId: string; hasCitation: boolean }>;
  },
  thresholds: QualityThresholds,
): ResearchQualityGateResult {
  const reasons: string[] = [];
  const insufficientClaimIds = new Set<string>();
  const challengeClaimIds = new Set<string>();

  if (input.claims.length === 0) {
    reasons.push("No claims were generated.");
  }

  if (input.latestReportConfidence < thresholds.minReportConfidence) {
    reasons.push(
      `Report confidence is below threshold (${input.latestReportConfidence} < ${thresholds.minReportConfidence}).`,
    );
  }

  for (const progress of input.claimProgress) {
    if (progress.evidenceCount < thresholds.minEvidencePerClaim) {
      reasons.push(
        `Claim ${progress.claimId} lacks evidence (${progress.evidenceCount}/${thresholds.minEvidencePerClaim}).`,
      );
      insufficientClaimIds.add(progress.claimId);
    }
    if (progress.distinctDomainCount < thresholds.minDistinctDomainsPerClaim) {
      reasons.push(
        `Claim ${progress.claimId} lacks source diversity (${progress.distinctDomainCount}/${thresholds.minDistinctDomainsPerClaim}).`,
      );
      insufficientClaimIds.add(progress.claimId);
    }
    if (thresholds.requireCounterEvidence && progress.counterEvidenceCount <= 0) {
      reasons.push(`Claim ${progress.claimId} has no counter-evidence.`);
      challengeClaimIds.add(progress.claimId);
    }
  }

  const missingCitationClaims = input.claimCitationCoverage
    .filter((entry) => !entry.hasCitation)
    .map((entry) => entry.claimId);
  if (missingCitationClaims.length > 0) {
    reasons.push(`Citation coverage is incomplete for ${missingCitationClaims.length} claim(s).`);
    for (const claimId of missingCitationClaims) {
      insufficientClaimIds.add(claimId);
    }
  }

  const verifiableClaims = input.claimProgress.filter(
    (claim) =>
      claim.evidenceCount >= thresholds.minEvidencePerClaim &&
      claim.distinctDomainCount >= thresholds.minDistinctDomainsPerClaim &&
      (!thresholds.requireCounterEvidence || claim.counterEvidenceCount > 0),
  ).length;
  const verifiableRatio =
    input.claimProgress.length > 0 ? verifiableClaims / input.claimProgress.length : 0;

  if (verifiableRatio < thresholds.minVerifiableRatio) {
    reasons.push(
      `Verifiable claim ratio is below threshold (${verifiableRatio.toFixed(2)} < ${thresholds.minVerifiableRatio.toFixed(2)}).`,
    );
  }

  return {
    pass: reasons.length === 0,
    reasons,
    insufficientClaimIds: Array.from(insufficientClaimIds),
    challengeClaimIds: Array.from(challengeClaimIds),
    metrics: {
      claimCount: input.claims.length,
      verifiableRatio,
      reportConfidence: input.latestReportConfidence,
    },
  };
}

async function updateJobState(
  job: { id: string; metadata: unknown },
  params: {
    status: "queued" | "running" | "blocked" | "done" | "failed" | "cancelled";
    stage: string;
    notes?: string[];
  },
): Promise<void> {
  const previousMetadata = asRecord(job.metadata);
  const nextMetadata = {
    ...previousMetadata,
    orchestrator: {
      ...(asRecord(previousMetadata.orchestrator) as Record<string, unknown>),
      stage: params.stage,
      updatedAt: new Date().toISOString(),
      notes: params.notes ?? [],
    },
  };

  await db
    .update(researchJobs)
    .set({
      status: params.status,
      updatedAt: new Date(),
      metadata: nextMetadata,
    })
    .where(eq(researchJobs.id, job.id));
}

async function queueResearchTask(params: {
  jobId: string;
  query: string;
  profile: string;
  stage: ResearchStage;
  claimId?: string;
  claimText?: string;
  claims?: string[];
  priority?: number;
  riskLevel?: "low" | "medium" | "high";
}): Promise<void> {
  const title = buildTaskTitle(params.stage, params.query, params.claimText);
  const goal = buildTaskGoal(params.stage);
  const targetArea = params.claimId
    ? `research:${params.jobId}:claim:${params.claimId}`
    : `research:${params.jobId}`;

  await db.insert(tasks).values({
    title,
    goal,
    kind: "research",
    role: "worker",
    context: {
      research: {
        jobId: params.jobId,
        query: params.query,
        stage: params.stage,
        profile: params.profile,
        claimId: params.claimId,
        claimText: params.claimText,
        claims: params.claims,
      },
      notes: `TigerResearch auto-orchestrated stage: ${params.stage}`,
    },
    allowedPaths: [],
    commands: [],
    targetArea,
    priority: params.priority ?? 0,
    riskLevel: params.riskLevel ?? "medium",
    status: "queued",
    timeboxMinutes: params.stage === "write" ? 90 : 60,
  });
}

async function orchestrateJob(job: typeof researchJobs.$inferSelect): Promise<void> {
  const thresholds = readThresholds();
  const requiresJudge = parseEnvBool("RESEARCH_REQUIRE_JUDGE", false);

  const [claims, evidence, reports, taskRows] = await Promise.all([
    db
      .select({
        id: researchClaims.id,
        claimText: researchClaims.claimText,
        confidence: researchClaims.confidence,
        metadata: researchClaims.metadata,
        updatedAt: researchClaims.updatedAt,
      })
      .from(researchClaims)
      .where(eq(researchClaims.jobId, job.id))
      .orderBy(desc(researchClaims.updatedAt)),
    db
      .select({
        id: researchEvidence.id,
        claimId: researchEvidence.claimId,
        sourceUrl: researchEvidence.sourceUrl,
        stance: researchEvidence.stance,
        createdAt: researchEvidence.createdAt,
      })
      .from(researchEvidence)
      .where(eq(researchEvidence.jobId, job.id))
      .orderBy(desc(researchEvidence.createdAt)),
    db
      .select({
        id: researchReports.id,
        confidence: researchReports.confidence,
        createdAt: researchReports.createdAt,
      })
      .from(researchReports)
      .where(eq(researchReports.jobId, job.id))
      .orderBy(desc(researchReports.createdAt)),
    db
      .select({
        id: tasks.id,
        status: tasks.status,
        blockReason: tasks.blockReason,
        context: tasks.context,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, "research"),
          sql`${tasks.context} -> 'research' ->> 'jobId' = ${job.id}`,
        ),
      ),
  ]);

  const query = job.query;
  const profile = job.qualityProfile;
  const activeRows = taskRows.filter((row) => isTaskActive(row));
  const activePipelineTaskCount = activeRows.filter((row) => {
    const stage = normalizeResearchStage(readResearchTaskContext(row.context).stage);
    return stage === "plan" || stage === "collect" || stage === "challenge" || stage === "write";
  }).length;
  const availableSlots = Math.max(0, thresholds.maxConcurrency - activePipelineTaskCount);
  const hasActivePlan = hasAnyTaskForStage(activeRows, "plan", false);
  const hasActiveWrite = hasAnyTaskForStage(activeRows, "write", false);

  if (claims.length === 0) {
    const hasPlanTask = hasAnyTaskForStage(taskRows, "plan", true);
    const metadata = asRecord(job.metadata);
    const orchestratorMeta = asRecord(metadata.orchestrator);
    const plannerPendingUntilMs = parseIsoTimestamp(orchestratorMeta.plannerPendingUntil);
    const plannerPending = plannerPendingUntilMs !== null && plannerPendingUntilMs > Date.now();

    if (plannerPending) {
      await updateJobState(job, { status: "running", stage: "planning" });
      return;
    }

    if (!hasPlanTask) {
      await queueResearchTask({
        jobId: job.id,
        query,
        profile,
        stage: "plan",
      });
    }
    await updateJobState(job, { status: "running", stage: "planning" });
    return;
  }

  if (hasActivePlan) {
    await updateJobState(job, { status: "running", stage: "planning" });
    return;
  }

  const evidenceByClaimId = new Map<
    string,
    {
      evidenceCount: number;
      domains: Set<string>;
      counterEvidenceCount: number;
    }
  >();
  for (const claim of claims) {
    evidenceByClaimId.set(claim.id, {
      evidenceCount: 0,
      domains: new Set<string>(),
      counterEvidenceCount: 0,
    });
  }
  for (const evidenceRow of evidence) {
    if (!evidenceRow.claimId) {
      continue;
    }
    const bucket = evidenceByClaimId.get(evidenceRow.claimId);
    if (!bucket) {
      continue;
    }
    bucket.evidenceCount += 1;
    const domain = extractDomain(evidenceRow.sourceUrl);
    if (domain) {
      bucket.domains.add(domain);
    }
    if (evidenceRow.stance === "contradicting") {
      bucket.counterEvidenceCount += 1;
    }
  }

  const claimProgress: ClaimProgress[] = claims.map((claim) => {
    const bucket = evidenceByClaimId.get(claim.id);
    return {
      claimId: claim.id,
      claimText: claim.claimText,
      confidence: claim.confidence,
      evidenceCount: bucket?.evidenceCount ?? 0,
      distinctDomainCount: bucket?.domains.size ?? 0,
      counterEvidenceCount: bucket?.counterEvidenceCount ?? 0,
      collectAttempts: countAttemptsForClaim(taskRows, "collect", claim.id),
      challengeAttempts: countAttemptsForClaim(taskRows, "challenge", claim.id),
      hasCollectDone: hasDoneStageForClaim(taskRows, "collect", claim.id),
      hasChallengeDone: hasDoneStageForClaim(taskRows, "challenge", claim.id),
      hasActiveCollect: hasActiveStageForClaim(taskRows, "collect", claim.id),
      hasActiveChallenge: hasActiveStageForClaim(taskRows, "challenge", claim.id),
    };
  });

  const collectQueue: ClaimProgress[] = [];
  const challengeQueue: ClaimProgress[] = [];

  for (const progress of claimProgress) {
    const needsCollect =
      !progress.hasCollectDone ||
      progress.evidenceCount < thresholds.minEvidencePerClaim ||
      progress.distinctDomainCount < thresholds.minDistinctDomainsPerClaim;

    if (
      needsCollect &&
      !progress.hasActiveCollect &&
      progress.collectAttempts < thresholds.maxDepth
    ) {
      collectQueue.push(progress);
      continue;
    }

    const needsChallenge =
      !progress.hasChallengeDone ||
      (thresholds.requireCounterEvidence && progress.counterEvidenceCount <= 0);
    if (
      !needsCollect &&
      needsChallenge &&
      !progress.hasActiveChallenge &&
      progress.challengeAttempts < thresholds.maxDepth
    ) {
      challengeQueue.push(progress);
    }
  }

  if (collectQueue.length > 0) {
    if (availableSlots <= 0) {
      await updateJobState(job, { status: "running", stage: "collecting" });
      return;
    }
    for (const claim of collectQueue.slice(0, availableSlots)) {
      await queueResearchTask({
        jobId: job.id,
        query,
        profile,
        stage: "collect",
        claimId: claim.claimId,
        claimText: claim.claimText,
      });
    }
    await updateJobState(job, { status: "running", stage: "collecting" });
    return;
  }

  if (challengeQueue.length > 0) {
    if (availableSlots <= 0) {
      await updateJobState(job, { status: "running", stage: "challenging" });
      return;
    }
    for (const claim of challengeQueue.slice(0, availableSlots)) {
      await queueResearchTask({
        jobId: job.id,
        query,
        profile,
        stage: "challenge",
        claimId: claim.claimId,
        claimText: claim.claimText,
      });
    }
    await updateJobState(job, { status: "running", stage: "challenging" });
    return;
  }

  const hasActiveCollectOrChallenge = activeRows.some((row) => {
    const context = readResearchTaskContext(row.context);
    const stage = normalizeResearchStage(context.stage);
    return stage === "collect" || stage === "challenge";
  });
  if (hasActiveCollectOrChallenge) {
    await updateJobState(job, { status: "running", stage: "collecting" });
    return;
  }

  const latestReport = reports[0];
  const reportIsFresh = hasFreshReport(latestReport, claims, evidence);
  if (!latestReport || !reportIsFresh) {
    if (!hasActiveWrite) {
      await queueResearchTask({
        jobId: job.id,
        query,
        profile,
        stage: "write",
        claims: claims.map((claim) => claim.claimText),
      });
    }
    await updateJobState(job, { status: "running", stage: "composing" });
    return;
  }

  if (hasActiveWrite) {
    await updateJobState(job, {
      status: "running",
      stage: requiresJudge ? "judging" : "composing",
    });
    return;
  }

  const claimCitationCoverage = claims.map((claim) => {
    const metadata = asRecord(claim.metadata);
    const evidenceUrls = Array.isArray(metadata.evidenceUrls)
      ? metadata.evidenceUrls.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [];
    return {
      claimId: claim.id,
      hasCitation: evidenceUrls.length > 0,
    };
  });

  const gate = evaluateResearchQualityGate(
    {
      claims: claims.map((claim) => ({ id: claim.id, confidence: claim.confidence })),
      claimProgress,
      latestReportConfidence: latestReport.confidence,
      claimCitationCoverage,
    },
    thresholds,
  );

  if (gate.pass) {
    if (!requiresJudge) {
      await updateJobState(job, { status: "done", stage: "completed" });
    } else {
      await updateJobState(job, { status: "running", stage: "judging" });
    }
    return;
  }

  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const existingActiveCollectClaimIds = new Set(
    claimProgress.filter((claim) => claim.hasActiveCollect).map((claim) => claim.claimId),
  );
  const existingActiveChallengeClaimIds = new Set(
    claimProgress.filter((claim) => claim.hasActiveChallenge).map((claim) => claim.claimId),
  );

  if (availableSlots <= 0) {
    await updateJobState(job, { status: "running", stage: "reworking", notes: gate.reasons });
    return;
  }

  let queuedRework = 0;
  const reworkSlots = availableSlots;
  for (const claimId of gate.insufficientClaimIds.slice(0, reworkSlots)) {
    if (existingActiveCollectClaimIds.has(claimId)) {
      continue;
    }
    const progress = claimProgress.find((claim) => claim.claimId === claimId);
    if (!progress || progress.collectAttempts >= thresholds.maxDepth) {
      continue;
    }
    const claim = claimById.get(claimId);
    if (!claim) {
      continue;
    }
    await queueResearchTask({
      jobId: job.id,
      query,
      profile,
      stage: "collect",
      claimId,
      claimText: claim.claimText,
    });
    queuedRework += 1;
  }

  for (const claimId of gate.challengeClaimIds.slice(0, reworkSlots - queuedRework)) {
    if (existingActiveChallengeClaimIds.has(claimId)) {
      continue;
    }
    const progress = claimProgress.find((claim) => claim.claimId === claimId);
    if (!progress || progress.challengeAttempts >= thresholds.maxDepth) {
      continue;
    }
    const claim = claimById.get(claimId);
    if (!claim) {
      continue;
    }
    await queueResearchTask({
      jobId: job.id,
      query,
      profile,
      stage: "challenge",
      claimId,
      claimText: claim.claimText,
    });
    queuedRework += 1;
  }

  if (queuedRework > 0) {
    await updateJobState(job, { status: "running", stage: "reworking", notes: gate.reasons });
    return;
  }

  await updateJobState(job, { status: "blocked", stage: "reworking", notes: gate.reasons });
}

export async function runResearchOrchestrationTick(): Promise<void> {
  if (!parseEnvBool("RESEARCH_ENABLED", true)) {
    return;
  }

  const activeJobs = await db
    .select()
    .from(researchJobs)
    .where(inArray(researchJobs.status, ["queued", "running", "blocked"]))
    .orderBy(asc(researchJobs.updatedAt))
    .limit(30);

  if (activeJobs.length === 0) {
    return;
  }

  for (const job of activeJobs) {
    await orchestrateJob(job);
  }
}
