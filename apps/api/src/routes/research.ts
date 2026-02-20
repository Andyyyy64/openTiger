import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@openTiger/db";
import { artifacts, leases, runs, tasks } from "@openTiger/db/schema";
import {
  researchClaims,
  researchEvidence,
  researchJobs,
  researchReports,
} from "@openTiger/plugin-tiger-research/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ensureResearchPlannerStarted, ensureResearchRuntimeStarted } from "./research-runtime";

export const researchRoute = new Hono();

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, 100);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}...`;
}

function stageLabel(stage: string): string {
  const normalized = stage.trim().toLowerCase();
  if (normalized === "plan" || normalized === "planning") {
    return "Plan";
  }
  if (normalized === "challenge") {
    return "Challenge";
  }
  if (normalized === "write") {
    return "Write";
  }
  return "Collect";
}

function getResearchPlannerPendingWindowMs(): number {
  const parsed = Number.parseInt(process.env.RESEARCH_PLANNER_PENDING_WINDOW_MS ?? "90000", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 90000;
  }
  return parsed;
}

researchRoute.get("/jobs", async (c) => {
  const status = c.req.query("status");
  const limit = parseLimit(c.req.query("limit"), 50);

  const whereClause = status ? eq(researchJobs.status, status) : undefined;

  const jobs = whereClause
    ? await db
        .select()
        .from(researchJobs)
        .where(whereClause)
        .orderBy(desc(researchJobs.updatedAt))
        .limit(limit)
    : await db.select().from(researchJobs).orderBy(desc(researchJobs.updatedAt)).limit(limit);

  return c.json({ jobs });
});

researchRoute.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");

  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, id)).limit(1);
  if (!job) {
    return c.json({ error: "Research job not found" }, 404);
  }

  const [claims, evidence, reports, linkedTasks] = await Promise.all([
    db
      .select()
      .from(researchClaims)
      .where(eq(researchClaims.jobId, id))
      .orderBy(desc(researchClaims.createdAt)),
    db
      .select()
      .from(researchEvidence)
      .where(eq(researchEvidence.jobId, id))
      .orderBy(desc(researchEvidence.createdAt)),
    db
      .select()
      .from(researchReports)
      .where(eq(researchReports.jobId, id))
      .orderBy(desc(researchReports.createdAt)),
    db
      .select()
      .from(tasks)
      .where(
        and(eq(tasks.kind, "research"), sql`${tasks.context} -> 'research' ->> 'jobId' = ${id}`),
      )
      .orderBy(desc(tasks.createdAt)),
  ]);

  const taskIds = linkedTasks.map((task) => task.id);
  const linkedRuns =
    taskIds.length > 0
      ? await db
          .select()
          .from(runs)
          .where(inArray(runs.taskId, taskIds))
          .orderBy(desc(runs.startedAt))
      : [];

  return c.json({
    job,
    claims,
    evidence,
    reports,
    tasks: linkedTasks,
    runs: linkedRuns,
  });
});

const createResearchJobSchema = z.object({
  query: z.string().min(1),
  qualityProfile: z.string().min(1).optional(),
  priority: z.number().int().optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  timeboxMinutes: z.number().int().positive().optional(),
});

researchRoute.post("/jobs", zValidator("json", createResearchJobSchema), async (c) => {
  const body = c.req.valid("json");
  const jobId = randomUUID();
  const profile = body.qualityProfile ?? "high_precision";
  const plannerPendingUntilIso = new Date(
    Date.now() + getResearchPlannerPendingWindowMs(),
  ).toISOString();

  const [job] = await db
    .insert(researchJobs)
    .values({
      id: jobId,
      query: body.query,
      qualityProfile: profile,
      status: "queued",
      metadata: {
        createdFrom: "api",
        orchestrator: {
          stage: "planning",
          updatedAt: new Date().toISOString(),
          plannerRequestedAt: new Date().toISOString(),
          plannerPendingUntil: plannerPendingUntilIso,
          notes: [],
        },
      },
    })
    .returning();

  if (!job) {
    return c.json({ error: "Failed to create research job" }, 500);
  }

  const runtime = await ensureResearchRuntimeStarted();
  const planner = await ensureResearchPlannerStarted(jobId);

  let fallbackTask: Record<string, unknown> | null = null;
  if (planner.errors.length > 0) {
    const [task] = await db
      .insert(tasks)
      .values({
        title: `[Research/Plan] ${truncateText(body.query, 72)}`,
        goal: "Decompose the research query into concrete claims for parallel investigation.",
        kind: "research",
        role: "worker",
        lane: "research",
        context: {
          research: {
            jobId,
            query: body.query,
            stage: "plan",
            profile,
          },
          notes: "Planner start failed; fallback plan task created by API.",
        },
        allowedPaths: [],
        commands: [],
        targetArea: `research:${jobId}`,
        priority: body.priority ?? 0,
        riskLevel: body.riskLevel ?? "medium",
        status: "queued",
        timeboxMinutes: body.timeboxMinutes ?? 90,
      })
      .returning();

    if (!task) {
      return c.json({ error: "Failed to create fallback research planning task" }, 500);
    }
    fallbackTask = task as Record<string, unknown>;
  }

  const [latestJob] = await db
    .select({ metadata: researchJobs.metadata })
    .from(researchJobs)
    .where(eq(researchJobs.id, jobId))
    .limit(1);

  await db
    .update(researchJobs)
    .set({
      metadata: {
        ...((latestJob?.metadata as Record<string, unknown> | null) ??
          (job.metadata as Record<string, unknown> | null)),
        planner: {
          mode: "planner_first",
          requestedAt: new Date().toISOString(),
          started: planner.started,
          skipped: planner.skipped,
          errors: planner.errors,
        },
        ...(fallbackTask && typeof fallbackTask.id === "string"
          ? { fallbackTaskId: fallbackTask.id }
          : {}),
      },
      updatedAt: new Date(),
    })
    .where(eq(researchJobs.id, jobId));

  return c.json({ job, runtime, planner, ...(fallbackTask ? { fallbackTask } : {}) }, 201);
});

const createResearchTaskSchema = z.object({
  stage: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  claimId: z.string().uuid().optional(),
  claimText: z.string().optional(),
  claims: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  timeboxMinutes: z.number().int().positive().optional(),
});

researchRoute.post("/jobs/:id/tasks", zValidator("json", createResearchTaskSchema), async (c) => {
  const jobId = c.req.param("id");
  const body = c.req.valid("json");

  const [job] = await db.select().from(researchJobs).where(eq(researchJobs.id, jobId)).limit(1);
  if (!job) {
    return c.json({ error: "Research job not found" }, 404);
  }

  const stage = body.stage ?? "collect";
  const profile = body.profile ?? job.qualityProfile ?? "high_precision";
  const defaultTitle = `[Research/${stageLabel(stage)}] ${truncateText(job.query, 64)}`;

  const [task] = await db
    .insert(tasks)
    .values({
      title: body.title ?? defaultTitle,
      goal:
        body.goal ??
        `Execute TigerResearch ${stageLabel(stage).toLowerCase()} stage and update evidence-backed findings.`,
      kind: "research",
      role: "worker",
      lane: "research",
      context: {
        research: {
          jobId,
          query: job.query,
          stage,
          profile,
          claimId: body.claimId,
          claimText: body.claimText,
          claims: body.claims,
        },
        notes: `TigerResearch follow-up stage: ${stage}`,
      },
      allowedPaths: [],
      commands: [],
      targetArea: `research:${jobId}`,
      priority: body.priority ?? 0,
      riskLevel: body.riskLevel ?? "medium",
      status: "queued",
      timeboxMinutes: body.timeboxMinutes ?? 60,
    })
    .returning();

  if (!task) {
    return c.json({ error: "Failed to create research task" }, 500);
  }

  await db
    .update(researchJobs)
    .set({
      status: "queued",
      updatedAt: new Date(),
      metadata: {
        ...(job.metadata as Record<string, unknown> | null),
        latestTaskId: task.id,
      },
    })
    .where(eq(researchJobs.id, jobId));

  const runtime = await ensureResearchRuntimeStarted();

  return c.json({ task, runtime }, 201);
});

// Delete all research jobs and related data from DB
researchRoute.delete("/jobs", async (c) => {
  const jobRows = await db.select({ id: researchJobs.id }).from(researchJobs);
  const jobIds = jobRows.map((r) => r.id);
  const jobIdSet = new Set(jobIds);

  if (jobIds.length === 0) {
    return c.json({ deleted: 0, jobs: 0, tasks: 0 });
  }

  const researchTaskRows = await db
    .select({ id: tasks.id, context: tasks.context })
    .from(tasks)
    .where(eq(tasks.kind, "research"));

  const taskIds = researchTaskRows
    .filter((row) => {
      const ctx = row.context as { research?: { jobId?: string } } | null;
      const jid = ctx?.research?.jobId;
      return typeof jid === "string" && jobIdSet.has(jid);
    })
    .map((r) => r.id);

  await db.transaction(async (tx) => {
    // 1) Resolve run ids linked to research tasks
    const runRows =
      taskIds.length > 0
        ? await tx.select({ id: runs.id }).from(runs).where(inArray(runs.taskId, taskIds))
        : [];
    const runIds = runRows.map((r) => r.id);

    // 2) Delete direct run children first
    if (runIds.length > 0) {
      await tx.delete(artifacts).where(inArray(artifacts.runId, runIds));
    }

    // 3) Delete research domain children that reference runs/jobs
    await tx.delete(researchEvidence).where(inArray(researchEvidence.jobId, jobIds));
    await tx.delete(researchClaims).where(inArray(researchClaims.jobId, jobIds));
    await tx.delete(researchReports).where(inArray(researchReports.jobId, jobIds));

    // 4) Delete runtime rows
    if (runIds.length > 0) {
      await tx.delete(runs).where(inArray(runs.id, runIds));
    }
    if (taskIds.length > 0) {
      await tx.delete(leases).where(inArray(leases.taskId, taskIds));
      await tx.delete(tasks).where(inArray(tasks.id, taskIds));
    }

    // 5) Finally delete jobs
    await tx.delete(researchJobs).where(inArray(researchJobs.id, jobIds));
  });

  return c.json({
    deleted: jobIds.length,
    jobs: jobIds.length,
    tasks: taskIds.length,
  });
});
