import { mkdir } from "node:fs/promises";
import { db } from "@openTiger/db";
import { runs } from "@openTiger/db/schema";
import { researchClaims, researchEvidence } from "@openTiger/plugin-tiger-research/db";
import { desc, eq } from "drizzle-orm";
import { runOpenCode } from "@openTiger/llm";
import type { OpenCodeResult } from "@openTiger/llm";
import { buildOpenCodeEnv } from "../env";
import { finalizeTaskState } from "../worker-runner-state";
import type { WorkerResult } from "../worker-runner-types";
import { isQuotaFailure } from "../worker-task-helpers";
import { resolveResearchInstructionsPath } from "./instructions";
import { resolveResearchInput } from "./input";
import { buildResearchPrompt } from "./prompt";
import { parseResearchOutput } from "./parser";
import { ensureResearchJob, failResearchJob, persistResearchArtifacts } from "./persist";
import { searchResearchSources } from "./search";
import { isWriteStage, normalizeResearchStage } from "./stage";
import type {
  ResearchContextSnapshot,
  ResearchExecutionResult,
  ResearchInput,
  ResearchModelOutput,
} from "./types";

const DEFAULT_RESEARCH_PARSE_REGEN_RETRIES = 2;
const DEFAULT_RESEARCH_PARSE_REGEN_TIMEOUT_SECONDS = 240;
const MAX_PARSE_RECOVERY_PREVIEW_CHARS = 4000;

function resolveResearchParseRetryCount(): number {
  const parsed = Number.parseInt(
    process.env.RESEARCH_PARSE_REGEN_RETRIES ?? String(DEFAULT_RESEARCH_PARSE_REGEN_RETRIES),
    10,
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_RESEARCH_PARSE_REGEN_RETRIES;
  }
  return parsed;
}

function resolveResearchParseRegenTimeout(baseTimeoutSeconds: number): number {
  const parsed = Number.parseInt(
    process.env.RESEARCH_PARSE_REGEN_TIMEOUT_SECONDS ??
      String(DEFAULT_RESEARCH_PARSE_REGEN_TIMEOUT_SECONDS),
    10,
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.max(
      120,
      Math.min(baseTimeoutSeconds, DEFAULT_RESEARCH_PARSE_REGEN_TIMEOUT_SECONDS),
    );
  }
  return parsed;
}

function clipParseRecoveryOutput(text: string): string {
  return text.trim().slice(0, MAX_PARSE_RECOVERY_PREVIEW_CHARS);
}

function buildResearchParseRecoveryPrompt(params: {
  basePrompt: string;
  previousOutput: string;
  parseError: string;
}): string {
  return `${params.basePrompt}

## JSON Regeneration Requirement
The previous answer could not be parsed as valid JSON.
Regenerate the full result as one valid JSON object only.
Do not output markdown fences or any explanatory text.

Parse error:
${params.parseError}

Previous answer:
\`\`\`
${clipParseRecoveryOutput(params.previousOutput)}
\`\`\``;
}

function mergeTokenUsage(results: OpenCodeResult[]): OpenCodeResult["tokenUsage"] {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let hasAny = false;
  let hasCacheRead = false;
  let hasCacheWrite = false;

  for (const result of results) {
    if (!result.tokenUsage) {
      continue;
    }
    hasAny = true;
    inputTokens += result.tokenUsage.inputTokens;
    outputTokens += result.tokenUsage.outputTokens;
    if (typeof result.tokenUsage.cacheReadTokens === "number") {
      hasCacheRead = true;
      cacheReadTokens += result.tokenUsage.cacheReadTokens;
    }
    if (typeof result.tokenUsage.cacheWriteTokens === "number") {
      hasCacheWrite = true;
      cacheWriteTokens += result.tokenUsage.cacheWriteTokens;
    }
  }

  if (!hasAny) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(hasCacheRead ? { cacheReadTokens } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens } : {}),
  };
}

async function runResearchWithParseRecovery(params: {
  basePrompt: string;
  workdir: string;
  instructionsPath: string;
  model: string;
  timeoutSeconds: number;
  env: Record<string, string>;
}): Promise<{ openCodeResult: OpenCodeResult; parsed: ResearchModelOutput }> {
  const parseRetryCount = resolveResearchParseRetryCount();
  const maxAttempts = parseRetryCount + 1;
  const results: OpenCodeResult[] = [];
  let currentPrompt = params.basePrompt;
  const regenTimeoutSeconds = resolveResearchParseRegenTimeout(params.timeoutSeconds);
  let lastParseError = "unknown parse error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timeoutSeconds = attempt === 1 ? params.timeoutSeconds : regenTimeoutSeconds;
    const openCodeResult = await runOpenCode({
      workdir: params.workdir,
      instructionsPath: params.instructionsPath,
      task: currentPrompt,
      model: params.model,
      timeoutSeconds,
      env: params.env,
      inheritEnv: false,
    });

    if (!openCodeResult.success) {
      throw new Error(openCodeResult.stderr || "Research execution failed");
    }

    results.push(openCodeResult);
    try {
      const parsed = parseResearchOutput(openCodeResult.stdout);
      return {
        openCodeResult: {
          ...openCodeResult,
          tokenUsage: mergeTokenUsage(results),
        },
        parsed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastParseError = message;
      if (attempt >= maxAttempts) {
        break;
      }
      console.warn(
        `[Research] JSON parse retry ${attempt}/${parseRetryCount} due to parse error: ${message}`,
      );
      currentPrompt = buildResearchParseRecoveryPrompt({
        basePrompt: params.basePrompt,
        previousOutput: openCodeResult.stdout,
        parseError: message,
      });
    }
  }

  throw new Error(
    `Failed to parse research output as JSON after retries (${maxAttempts} attempts): ${lastParseError}`,
  );
}

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
  const model =
    params.model ??
    process.env.WORKER_MODEL ??
    process.env.OPENCODE_MODEL ??
    "google/gemini-3-pro-preview";
  const timeoutSeconds = Math.max(Math.min(params.task.timeboxMinutes * 60, 1800), 120);
  const { openCodeResult, parsed } = await runResearchWithParseRecovery({
    basePrompt: prompt,
    workdir: params.workspacePath,
    instructionsPath,
    model,
    timeoutSeconds,
    env: taskEnv,
  });

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
    const quotaFailure = isQuotaFailure(message);
    await failResearchJob(input.jobId, message).catch(() => undefined);

    await finalizeTaskState({
      runId,
      taskId: task.id,
      agentId,
      runStatus: "failed",
      taskStatus: quotaFailure ? "blocked" : "failed",
      blockReason: quotaFailure ? "quota_wait" : null,
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
