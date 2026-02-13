import { mkdir } from "node:fs/promises";
import { db } from "@openTiger/db";
import { researchClaims, researchEvidence, runs } from "@openTiger/db/schema";
import { desc, eq } from "drizzle-orm";
import { runOpenCode } from "@openTiger/llm";
import { buildOpenCodeEnv } from "../env";
import { finalizeTaskState } from "../worker-runner-state";
import type { WorkerResult } from "../worker-runner-types";
import { resolveResearchInstructionsPath } from "./instructions";
import { resolveResearchInput } from "./input";
import { buildResearchPrompt } from "./prompt";
import { parseResearchOutput } from "./parser";
import { ensureResearchJob, failResearchJob, persistResearchArtifacts } from "./persist";
import { searchResearchSources } from "./search";
import { isWriteStage, normalizeResearchStage } from "./stage";
import type { ResearchContextSnapshot, ResearchExecutionResult, ResearchInput } from "./types";

function shouldAwaitJudgeForResearchTask(stage: string): boolean {
  const requireJudge = (process.env.RESEARCH_REQUIRE_JUDGE ?? "false").toLowerCase() === "true";
  return requireJudge && isWriteStage(normalizeResearchStage(stage));
}

async function loadResearchSnapshot(input: ResearchInput): Promise<ResearchContextSnapshot> {
  const [claims, evidence] = await Promise.all([
    db
      .select({
        id: researchClaims.id,
        claimText: researchClaims.claimText,
        stance: researchClaims.stance,
        confidence: researchClaims.confidence,
      })
      .from(researchClaims)
      .where(eq(researchClaims.jobId, input.jobId))
      .orderBy(desc(researchClaims.updatedAt), desc(researchClaims.createdAt)),
    db
      .select({
        id: researchEvidence.id,
        claimId: researchEvidence.claimId,
        sourceUrl: researchEvidence.sourceUrl,
        sourceTitle: researchEvidence.sourceTitle,
        snippet: researchEvidence.snippet,
        reliability: researchEvidence.reliability,
        stance: researchEvidence.stance,
      })
      .from(researchEvidence)
      .where(eq(researchEvidence.jobId, input.jobId))
      .orderBy(desc(researchEvidence.createdAt)),
  ]);

  return { claims, evidence };
}

export async function executeResearchTask(params: {
  task: import("@openTiger/core").Task;
  input: ResearchInput;
  runId: string;
  agentId: string;
  workspacePath: string;
  model?: string;
  instructionsPath?: string;
}): Promise<ResearchExecutionResult> {
  const researchInput = params.input;
  const instructionsPath =
    params.instructionsPath ?? resolveResearchInstructionsPath(researchInput.stage);

  await mkdir(params.workspacePath, { recursive: true });
  await ensureResearchJob({
    jobId: researchInput.jobId,
    task: params.task,
    query: researchInput.query,
    profile: researchInput.profile,
    runId: params.runId,
  });

  const snapshot = await loadResearchSnapshot(researchInput);
  const { results: searchResults, warnings } = await searchResearchSources(researchInput.query);
  const prompt = buildResearchPrompt({
    task: params.task,
    input: researchInput,
    snapshot,
    searchResults,
    warnings,
  });

  const taskEnv = await buildOpenCodeEnv(params.workspacePath);
  const openCodeResult = await runOpenCode({
    workdir: params.workspacePath,
    instructionsPath,
    task: prompt,
    model:
      params.model ??
      process.env.WORKER_MODEL ??
      process.env.OPENCODE_MODEL ??
      "google/gemini-3-pro-preview",
    timeoutSeconds: Math.max(Math.min(params.task.timeboxMinutes * 60, 1800), 120),
    env: taskEnv,
    inheritEnv: false,
  });

  if (!openCodeResult.success) {
    throw new Error(openCodeResult.stderr || "Research execution failed");
  }

  const parsed = parseResearchOutput(openCodeResult.stdout);

  await persistResearchArtifacts({
    runId: params.runId,
    input: researchInput,
    output: parsed,
    searchResults,
  });

  return {
    openCodeResult,
    parsed,
    searchResults,
    warnings,
  };
}

export async function runResearchWorker(params: {
  task: import("@openTiger/core").Task;
  runId: string;
  agentId: string;
  workspacePath: string;
  model?: string;
  instructionsPath?: string;
}): Promise<WorkerResult> {
  const { task, runId, agentId } = params;
  const input = resolveResearchInput(task);

  try {
    const result = await executeResearchTask({
      ...params,
      input,
    });
    const awaitJudge = shouldAwaitJudgeForResearchTask(input.stage);

    await finalizeTaskState({
      runId,
      taskId: task.id,
      agentId,
      runStatus: "success",
      taskStatus: awaitJudge ? "blocked" : "done",
      blockReason: awaitJudge ? "awaiting_judge" : null,
      costTokens: result.openCodeResult.tokenUsage?.totalTokens ?? null,
    });

    await db
      .update(runs)
      .set({
        errorMessage: result.warnings.length > 0 ? result.warnings.join(" | ") : null,
      })
      .where(eq(runs.id, runId));

    return {
      success: true,
      taskId: task.id,
      runId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failResearchJob(input.jobId, message).catch(() => undefined);

    await finalizeTaskState({
      runId,
      taskId: task.id,
      agentId,
      runStatus: "failed",
      taskStatus: "failed",
      blockReason: null,
      errorMessage: message,
    });

    return {
      success: false,
      taskId: task.id,
      runId,
      error: message,
    };
  }
}
