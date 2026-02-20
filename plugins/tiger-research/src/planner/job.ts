import { db } from "@openTiger/db";
import { tasks } from "@openTiger/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { PlannerHookHandleJobParams } from "@openTiger/plugin-sdk";
import { researchClaims, researchJobs } from "../db";
import { generateResearchPlanFromQuery } from "./from-research-query";
import { resolveResearchStrengthProfile } from "../profile";

type PlannerConfigLike = {
  useLlm?: boolean;
  dryRun?: boolean;
  workdir?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeResearchStage(
  value: string | undefined,
): "plan" | "collect" | "challenge" | "write" {
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

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}...`;
}

function buildResearchCollectTaskTitle(claimText: string): string {
  return `[Research/Collect] ${truncateText(claimText, 72)}`;
}

function buildResearchCollectTaskGoal(): string {
  return "Collect high-quality supporting evidence for the target claim.";
}

function toPlannerConfig(config: unknown): Required<PlannerConfigLike> {
  const source = (config ?? {}) as PlannerConfigLike;
  return {
    useLlm: source.useLlm ?? true,
    dryRun: source.dryRun ?? false,
    workdir: source.workdir ?? process.cwd(),
  };
}

export async function handleResearchPlanningJob(params: PlannerHookHandleJobParams): Promise<void> {
  const config = toPlannerConfig(params.config);
  const researchJobId = params.jobId;
  const agentId = params.agentId;

  console.log("=".repeat(60));
  console.log("openTiger Planner - TigerResearch claim decomposition");
  console.log("=".repeat(60));
  console.log(`Research Job ID: ${researchJobId}`);
  console.log(`Use LLM: ${config.useLlm}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log("=".repeat(60));

  const [job] = await db
    .select()
    .from(researchJobs)
    .where(eq(researchJobs.id, researchJobId))
    .limit(1);
  if (!job) {
    throw new Error(`Research job not found: ${researchJobId}`);
  }
  if (job.status === "done" || job.status === "cancelled" || job.status === "failed") {
    console.log(`[Planner] Research job is already terminal (status=${job.status}). Skipping.`);
    return;
  }
  const profile = resolveResearchStrengthProfile(job.qualityProfile);

  const existingClaims = await db
    .select({
      id: researchClaims.id,
      claimText: researchClaims.claimText,
    })
    .from(researchClaims)
    .where(eq(researchClaims.jobId, researchJobId));

  let plannerWarnings: string[] = [];
  let plannedClaimInputs: Array<{
    text: string;
    priority: number;
    riskLevel: "low" | "medium" | "high";
  }> = [];

  if (existingClaims.length === 0) {
    if (!config.useLlm) {
      plannedClaimInputs = [
        {
          text: job.query,
          priority: 100,
          riskLevel: "medium",
        },
      ];
      plannerWarnings = [
        "LLM planning is disabled; using single-claim fallback from original query.",
      ];
    } else {
      const decomposition = await generateResearchPlanFromQuery(job.query, {
        workdir: config.workdir,
        profile,
      });
      plannedClaimInputs = decomposition.claims;
      plannerWarnings = decomposition.warnings;
    }
  }

  if (config.dryRun) {
    console.log("\n[Dry run mode - research claims/tasks not saved]");
    const previewClaims = existingClaims.length === 0 ? plannedClaimInputs : existingClaims;
    console.log(`[Dry run] claim_count=${previewClaims.length}`);
    return;
  }

  await db.transaction(async (tx) => {
    const database = tx as unknown as typeof db;

    let claimRows = await database
      .select({
        id: researchClaims.id,
        claimText: researchClaims.claimText,
      })
      .from(researchClaims)
      .where(eq(researchClaims.jobId, researchJobId));

    if (claimRows.length === 0) {
      const seen = new Set<string>();
      for (const claim of plannedClaimInputs) {
        const normalized = claim.text.trim();
        if (!normalized) {
          continue;
        }
        const dedupeKey = normalized.toLowerCase();
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        await database.insert(researchClaims).values({
          jobId: researchJobId,
          claimText: normalized,
          stance: "provisional",
          confidence: 35,
          metadata: {
            plannedBy: "planner",
            plannerAgentId: agentId,
            priority: claim.priority,
            riskLevel: claim.riskLevel,
          },
        });
      }
      claimRows = await database
        .select({
          id: researchClaims.id,
          claimText: researchClaims.claimText,
        })
        .from(researchClaims)
        .where(eq(researchClaims.jobId, researchJobId));
    }

    const existingStageRows = await database
      .select({
        stage: sql<string | null>`${tasks.context} -> 'research' ->> 'stage'`,
        claimId: sql<string | null>`${tasks.context} -> 'research' ->> 'claimId'`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, "research"),
          sql`${tasks.context} -> 'research' ->> 'jobId' = ${researchJobId}`,
        ),
      );

    const collectClaimIds = new Set<string>();
    for (const row of existingStageRows) {
      if (!row.claimId) {
        continue;
      }
      if (normalizeResearchStage(row.stage ?? undefined) === "collect") {
        collectClaimIds.add(row.claimId);
      }
    }

    let queuedCollectTasks = 0;
    for (const claim of claimRows) {
      if (collectClaimIds.has(claim.id)) {
        continue;
      }
      await database.insert(tasks).values({
        title: buildResearchCollectTaskTitle(claim.claimText),
        goal: buildResearchCollectTaskGoal(),
        kind: "research",
        role: "worker",
        lane: "research",
        context: {
          research: {
            jobId: researchJobId,
            query: job.query,
            stage: "collect",
            profile,
            claimId: claim.id,
            claimText: claim.claimText,
          },
          notes: "TigerResearch collect stage task auto-created by planner.",
        },
        allowedPaths: [],
        commands: [],
        targetArea: `research:${researchJobId}:claim:${claim.id}`,
        priority: 0,
        riskLevel: "medium",
        status: "queued",
        timeboxMinutes: 60,
      });
      queuedCollectTasks += 1;
    }

    const previousMetadata = asRecord(job.metadata);
    const previousOrchestrator = asRecord(previousMetadata.orchestrator);
    const nowIso = new Date().toISOString();

    await database
      .update(researchJobs)
      .set({
        status: "running",
        updatedAt: new Date(),
        metadata: {
          ...previousMetadata,
          orchestrator: {
            ...previousOrchestrator,
            stage: "collecting",
            updatedAt: nowIso,
            plannerRequestedAt: previousOrchestrator.plannerRequestedAt ?? nowIso,
            plannerPendingUntil: null,
            plannedAt: nowIso,
            claimCount: claimRows.length,
            notes: plannerWarnings,
          },
          planner: {
            mode: "planner_first",
            agentId,
            queuedCollectTasks,
          },
        },
      })
      .where(eq(researchJobs.id, researchJobId));
  });

  console.log(`\n[Planner] Research planning completed for job ${researchJobId}`);
}
