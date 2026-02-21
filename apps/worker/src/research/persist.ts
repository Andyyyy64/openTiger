import { db } from "@openTiger/db";
import { artifacts } from "@openTiger/db/schema";
import {
  researchClaims,
  researchEvidence,
  researchJobs,
  researchReports,
} from "@openTiger/plugin-tiger-research/db";
import { eq } from "drizzle-orm";
import type { Task } from "@openTiger/core";
import type { ResearchInput, ResearchModelOutput, ResearchSearchResult } from "./types";
import { normalizeResearchStage } from "./stage";

function toIsoDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export async function ensureResearchJob(params: {
  jobId: string;
  task: Task;
  query: string;
  profile: string;
  runId: string;
}): Promise<void> {
  const [existing] = await db
    .select({ id: researchJobs.id, metadata: researchJobs.metadata })
    .from(researchJobs)
    .where(eq(researchJobs.id, params.jobId))
    .limit(1);

  const nextMetadata = {
    ...(existing?.metadata as Record<string, unknown> | null),
    taskId: params.task.id,
    taskTitle: params.task.title,
    runId: params.runId,
  };

  if (existing) {
    await db
      .update(researchJobs)
      .set({
        query: params.query,
        qualityProfile: params.profile,
        status: "running",
        updatedAt: new Date(),
        metadata: nextMetadata,
      })
      .where(eq(researchJobs.id, params.jobId));
    return;
  }

  await db.insert(researchJobs).values({
    id: params.jobId,
    query: params.query,
    qualityProfile: params.profile,
    status: "running",
    metadata: nextMetadata,
  });
}

function normalizeClaimText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveClaimStance(verdict: string): "confirmed" | "provisional" | "refuted" {
  if (verdict === "refuted") {
    return "refuted";
  }
  if (verdict === "mixed") {
    return "provisional";
  }
  return "confirmed";
}

function resolveEvidenceStance(
  stage: ReturnType<typeof normalizeResearchStage>,
  verdict: string | undefined,
): "supporting" | "contradicting" | "neutral" {
  if (verdict === "refuted") {
    return "contradicting";
  }
  if (verdict === "mixed") {
    return stage === "challenge" ? "contradicting" : "neutral";
  }
  if (stage === "challenge") {
    return "contradicting";
  }
  return "supporting";
}

export async function persistResearchArtifacts(params: {
  runId: string;
  input: ResearchInput;
  output: ResearchModelOutput;
  searchResults: ResearchSearchResult[];
}): Promise<void> {
  const stage = normalizeResearchStage(params.input.stage);
  let latestReportId: string | null = null;

  await db.transaction(async (tx) => {
    const existingClaims = await tx
      .select({
        id: researchClaims.id,
        claimText: researchClaims.claimText,
        metadata: researchClaims.metadata,
      })
      .from(researchClaims)
      .where(eq(researchClaims.jobId, params.input.jobId));
    const claimByNormalizedText = new Map(
      existingClaims.map((claim) => [normalizeClaimText(claim.claimText), claim]),
    );

    const resolvedClaims: Array<{ id: string; claimText: string }> = [];
    const allowClaimInsert = stage === "plan";
    for (const claim of params.output.claims) {
      const normalized = normalizeClaimText(claim.text);
      if (!normalized) {
        continue;
      }
      const existing = claimByNormalizedText.get(normalized);
      const metadata = {
        ...(existing?.metadata as Record<string, unknown> | null),
        verdict: claim.verdict,
        evidenceUrls: claim.evidenceUrls,
      };

      if (existing) {
        const [updated] = await tx
          .update(researchClaims)
          .set({
            claimText: claim.text,
            stance: resolveClaimStance(claim.verdict),
            confidence: claim.confidence,
            originRunId: params.runId,
            metadata,
            updatedAt: new Date(),
          })
          .where(eq(researchClaims.id, existing.id))
          .returning({ id: researchClaims.id, claimText: researchClaims.claimText });
        if (updated) {
          resolvedClaims.push(updated);
          claimByNormalizedText.set(normalized, {
            id: updated.id,
            claimText: updated.claimText,
            metadata,
          });
        }
        continue;
      }

      if (!allowClaimInsert) {
        continue;
      }

      const [inserted] = await tx
        .insert(researchClaims)
        .values({
          jobId: params.input.jobId,
          claimText: claim.text,
          stance: resolveClaimStance(claim.verdict),
          confidence: claim.confidence,
          originRunId: params.runId,
          metadata,
        })
        .returning({ id: researchClaims.id, claimText: researchClaims.claimText });
      if (inserted) {
        resolvedClaims.push(inserted);
        claimByNormalizedText.set(normalized, {
          id: inserted.id,
          claimText: inserted.claimText,
          metadata,
        });
      }
    }

    // Planning stage can receive seed claims from task context even if model output is sparse.
    if (stage === "plan" && resolvedClaims.length === 0 && (params.input.claims?.length ?? 0) > 0) {
      for (const seedClaim of params.input.claims ?? []) {
        const normalized = normalizeClaimText(seedClaim);
        if (!normalized || claimByNormalizedText.has(normalized)) {
          continue;
        }
        const [inserted] = await tx
          .insert(researchClaims)
          .values({
            jobId: params.input.jobId,
            claimText: seedClaim,
            stance: "provisional",
            confidence: 35,
            originRunId: params.runId,
            metadata: {
              source: "seed_claim",
            },
          })
          .returning({ id: researchClaims.id, claimText: researchClaims.claimText });
        if (inserted) {
          resolvedClaims.push(inserted);
          claimByNormalizedText.set(normalized, {
            id: inserted.id,
            claimText: inserted.claimText,
            metadata: { source: "seed_claim" },
          });
        }
      }
    }

    let targetClaimId = params.input.claimId ?? null;
    if (!targetClaimId && params.input.claimText) {
      targetClaimId =
        claimByNormalizedText.get(normalizeClaimText(params.input.claimText))?.id ?? null;
    }
    if (!targetClaimId && resolvedClaims.length === 1) {
      targetClaimId = resolvedClaims[0]?.id ?? null;
    }

    const existingEvidence = await tx
      .select({
        claimId: researchEvidence.claimId,
        sourceUrl: researchEvidence.sourceUrl,
      })
      .from(researchEvidence)
      .where(eq(researchEvidence.jobId, params.input.jobId));
    const evidenceDedup = new Set(
      existingEvidence.map(
        (evidence) => `${evidence.claimId ?? "none"}::${evidence.sourceUrl ?? ""}`,
      ),
    );

    for (const source of params.output.sources) {
      const dedupeKey = `${targetClaimId ?? "none"}::${source.url}`;
      if (evidenceDedup.has(dedupeKey)) {
        continue;
      }
      evidenceDedup.add(dedupeKey);

      const mappedClaim =
        targetClaimId ??
        (() => {
          const sourceUrl = source.url.trim();
          if (!sourceUrl) {
            return null;
          }
          for (const claim of params.output.claims) {
            if (!claim.evidenceUrls.includes(sourceUrl)) {
              continue;
            }
            return claimByNormalizedText.get(normalizeClaimText(claim.text))?.id ?? null;
          }
          return null;
        })();
      const linkedClaim = params.output.claims.find((claim) =>
        claim.evidenceUrls.includes(source.url),
      );
      await tx.insert(researchEvidence).values({
        jobId: params.input.jobId,
        claimId: mappedClaim,
        sourceUrl: source.url,
        sourceTitle: source.title,
        snippet: source.snippets.join("\n"),
        publishedAt: toIsoDate(source.publishedAt),
        reliability: source.reliability,
        stance: resolveEvidenceStance(stage, linkedClaim?.verdict),
        originRunId: params.runId,
        metadata: {
          snippets: source.snippets,
          stage,
        },
      });
    }

    for (const claim of resolvedClaims) {
      await tx.insert(artifacts).values({
        runId: params.runId,
        type: "research_claim",
        ref: claim.id,
        metadata: {
          researchJobId: params.input.jobId,
          researchClaimId: claim.id,
        },
      });
    }

    for (const source of params.output.sources) {
      await tx.insert(artifacts).values({
        runId: params.runId,
        type: "research_source",
        ref: source.url,
        url: source.url,
        metadata: {
          researchJobId: params.input.jobId,
          title: source.title,
          reliability: source.reliability,
        },
      });
    }

    if (stage === "write") {
      const [report] = await tx
        .insert(researchReports)
        .values({
          jobId: params.input.jobId,
          summary: params.output.summary,
          findings: {
            claims: params.output.claims,
            sources: params.output.sources,
            nextActions: params.output.nextActions,
          },
          limitations: params.output.limitations.join("\n"),
          confidence: params.output.confidence,
          originRunId: params.runId,
        })
        .returning({ id: researchReports.id });
      latestReportId = report?.id ?? null;

      await tx.insert(artifacts).values({
        runId: params.runId,
        type: "research_report",
        ref: report?.id ?? null,
        metadata: {
          researchJobId: params.input.jobId,
          researchReportId: report?.id,
          confidence: params.output.confidence,
          searchResultCount: params.searchResults.length,
        },
      });
    }
  });

  const [existingJob] = await db
    .select({ metadata: researchJobs.metadata })
    .from(researchJobs)
    .where(eq(researchJobs.id, params.input.jobId))
    .limit(1);
  const metadata = {
    ...(existingJob?.metadata as Record<string, unknown> | null),
    lastCompletedStage: stage,
    lastCompletedRunId: params.runId,
    lastStageAt: new Date().toISOString(),
  };
  await db
    .update(researchJobs)
    .set({
      status: "running",
      ...(latestReportId ? { latestReportId } : {}),
      updatedAt: new Date(),
      metadata,
    })
    .where(eq(researchJobs.id, params.input.jobId));
}

export async function failResearchJob(jobId: string, reason: string): Promise<void> {
  const [existingJob] = await db
    .select({ metadata: researchJobs.metadata })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId))
    .limit(1);
  const metadata = {
    ...(existingJob?.metadata as Record<string, unknown> | null),
    lastError: reason,
    lastErrorAt: new Date().toISOString(),
  };

  await db
    .update(researchJobs)
    .set({
      status: "blocked",
      updatedAt: new Date(),
      metadata,
    })
    .where(eq(researchJobs.id, jobId));
}
