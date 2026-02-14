import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@openTiger/db";
import { events, tasks } from "@openTiger/db/schema";
import { runOpenCode } from "@openTiger/llm";
import {
  extractOutsideAllowedViolationPaths,
  extractPolicyViolationPaths,
  loadPolicyRecoveryConfig,
  mergeUniquePaths,
  resolveCommandDrivenAllowedPaths,
  resolvePolicyViolationAutoAllowPaths,
  type Policy,
  type PolicyRecoveryConfig,
  type Task,
} from "@openTiger/core";
import { discardChangesForPaths } from "@openTiger/vcs";
import { and, eq, inArray, ne } from "drizzle-orm";
import { executeTask, verifyChanges, type ExecuteResult, type VerifyResult } from "./steps/index";
import { buildOpenCodeEnv } from "./env";
import {
  isLikelyGeneratedArtifactPath,
  matchesPattern,
  persistGeneratedPathHints,
} from "./steps/verify/paths";
import { shouldAllowNoChanges } from "./worker-task-helpers";
import { finalizeTaskState } from "./worker-runner-state";
import {
  appendContextNotes,
  buildVerifyRecoveryHint,
  encodeVerifyReworkMarker,
  isExecutionTimeout,
  parseRecoveryAttempts,
  restoreExpectedBranchContext,
  shouldAttemptVerifyRecovery,
  summarizeVerificationFailure,
} from "./worker-runner-utils";
import type { WorkerResult } from "./worker-runner-types";
import { recordContextDeltaFailure } from "./context/context-delta";

interface RunVerificationPhaseOptions {
  repoPath: string;
  taskData: Task;
  taskId: string;
  runId: string;
  agentId: string;
  branchName: string;
  baseBranch: string;
  repoMode: "git" | "local";
  verificationAllowedPaths: string[];
  effectivePolicy: Policy;
  instructionsPath?: string;
  model?: string;
  retryHints: string[];
  executeResult: ExecuteResult;
  runtimeExecutorDisplayName: string;
}

type VerificationPhaseResult =
  | {
      success: true;
      verifyResult: VerifyResult;
      executeResult: ExecuteResult;
    }
  | {
      success: false;
      result: WorkerResult;
    };

type PolicyRecoveryDecisionAction = "allow" | "discard" | "deny";

type PolicyRecoveryDecision = {
  path: string;
  action: PolicyRecoveryDecisionAction;
  reason: string;
};

type PolicyRecoveryLlmResult = {
  decisions: PolicyRecoveryDecision[];
  confidence: number | null;
  summary?: string;
};

function shouldEnableNoChangeVerificationFallback(): boolean {
  const mode = (process.env.WORKER_NO_CHANGE_CONFIRM_MODE ?? "verify").trim().toLowerCase();
  if (!mode) {
    return true;
  }
  return !["off", "false", "strict", "disabled", "none"].includes(mode);
}

function hasMeaningfulVerificationPass(verifyResult: VerifyResult): boolean {
  return verifyResult.commandResults.some((result) => result.outcome === "passed");
}

const DOCSER_SAFE_VERIFY_COMMAND = /^\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?check(?:\s+.*)?$/i;

function resolveVerificationCommands(taskData: Task): string[] {
  const commands = taskData.commands ?? [];
  if (taskData.role !== "docser") {
    return commands;
  }
  const safeCommands = commands.filter((command) =>
    DOCSER_SAFE_VERIFY_COMMAND.test(command.trim()),
  );
  if (safeCommands.length !== commands.length) {
    console.warn(
      `[Worker] Skipping non-docser-safe verification commands: ${commands.join(", ") || "(none)"}`,
    );
  }
  return safeCommands;
}

function shouldEnablePolicyRecoveryLlm(): boolean {
  return (process.env.WORKER_POLICY_RECOVERY_USE_LLM ?? "true").toLowerCase() !== "false";
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return raw;
}

function stripControlChars(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code === 9 || code === 10 || code === 13) return char;
      if (code <= 31 || code === 127) return "";
      return char;
    })
    .join("");
}

function extractCodeBlockCandidates(text: string): string[] {
  const matches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  const candidates: string[] = [];
  for (const match of matches) {
    const body = match[1]?.trim();
    if (body) {
      candidates.push(body);
    }
  }
  return candidates;
}

function extractBalancedObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1).trim();
        if (candidate) {
          candidates.push(candidate);
        }
        start = -1;
      }
    }
  }

  return candidates;
}

function collectJsonCandidates(text: string): string[] {
  const normalized = stripControlChars(text);
  const ordered = [
    ...extractCodeBlockCandidates(normalized),
    ...extractBalancedObjectCandidates(normalized),
    normalized.trim(),
  ];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    const value = candidate.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePolicyRecoveryLlmResult(text: string): PolicyRecoveryLlmResult | null {
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    const decisionsRaw = parsed.decisions;
    if (!Array.isArray(decisionsRaw)) {
      continue;
    }
    const decisions: PolicyRecoveryDecision[] = [];
    for (const decisionRaw of decisionsRaw) {
      if (!isRecord(decisionRaw)) {
        continue;
      }
      const path = typeof decisionRaw.path === "string" ? decisionRaw.path.trim() : "";
      const action = decisionRaw.action;
      if (!path || (action !== "allow" && action !== "discard" && action !== "deny")) {
        continue;
      }
      const reason = typeof decisionRaw.reason === "string" ? decisionRaw.reason.trim() : "";
      decisions.push({ path, action, reason });
    }
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : null;
    const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
    return { decisions, confidence, summary };
  }
  return null;
}

function isSafePolicyRecoveryPath(path: string): boolean {
  if (!path || path.startsWith("/")) {
    return false;
  }
  if (path.includes("..") || /[*?[\]{}]/.test(path)) {
    return false;
  }
  return true;
}

async function recordPolicyRecoveryEvent(params: {
  type: string;
  taskId: string;
  runId: string;
  agentId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(events).values({
      type: params.type,
      entityType: "task",
      entityId: params.taskId,
      agentId: params.agentId,
      payload: {
        runId: params.runId,
        ...params.payload,
      },
    });
  } catch (error) {
    console.warn(
      `[Worker] Failed to record policy recovery event (${params.type}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadConcurrentTaskSummary(taskId: string): Promise<string[]> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      role: tasks.role,
      status: tasks.status,
      targetArea: tasks.targetArea,
      touches: tasks.touches,
      allowedPaths: tasks.allowedPaths,
    })
    .from(tasks)
    .where(and(ne(tasks.id, taskId), inArray(tasks.status, ["queued", "running"])))
    .limit(10);

  return rows.map((row) => {
    const touches = row.touches?.slice(0, 5).join(", ") || "";
    const allowed = row.allowedPaths?.slice(0, 5).join(", ") || "";
    return [
      `id=${row.id}`,
      `status=${row.status}`,
      `role=${row.role}`,
      `title=${row.title}`,
      row.targetArea ? `targetArea=${row.targetArea}` : "",
      touches ? `touches=[${touches}]` : "",
      allowed ? `allowed=[${allowed}]` : "",
    ]
      .filter((value) => value.length > 0)
      .join(" ");
  });
}

function buildPolicyRecoveryPrompt(params: {
  taskData: Task;
  allowedPaths: string[];
  deniedPaths: string[];
  violatingPaths: string[];
  policyViolations: string[];
  changedFiles: string[];
  concurrentTaskSummaries: string[];
}): string {
  const concurrentText =
    params.concurrentTaskSummaries.length > 0
      ? params.concurrentTaskSummaries.map((line) => `- ${line}`).join("\n")
      : "- (none)";
  return [
    "You are a policy recovery judge for an autonomous coding worker.",
    "Decide how to recover from policy violations on changed files.",
    "Return JSON only. Never run tools. Never propose wildcard paths.",
    "",
    "Output schema:",
    "{",
    '  "decisions":[{"path":"...", "action":"allow|discard|deny", "reason":"..."}],',
    '  "summary":"...",',
    '  "confidence": 0.0',
    "}",
    "",
    "Rules:",
    "- Use allow only when the path is clearly required for task completion.",
    "- Use discard for collateral/conflict changes that should be removed.",
    "- Use deny when a path must stay blocked.",
    "- Only return paths from violatingPaths.",
    "",
    "Task:",
    `title: ${params.taskData.title}`,
    `goal: ${params.taskData.goal}`,
    `role: ${params.taskData.role}`,
    "",
    "Context:",
    `allowedPaths: ${JSON.stringify(params.allowedPaths)}`,
    `deniedPaths: ${JSON.stringify(params.deniedPaths)}`,
    `violatingPaths: ${JSON.stringify(params.violatingPaths)}`,
    `policyViolations: ${JSON.stringify(params.policyViolations)}`,
    `changedFiles: ${JSON.stringify(params.changedFiles)}`,
    "Concurrent tasks:",
    concurrentText,
  ].join("\n");
}

function sanitizeLlmDecisions(params: {
  llmResult: PolicyRecoveryLlmResult;
  violatingPaths: string[];
  deniedPaths: string[];
}): {
  allowPaths: string[];
  discardPaths: string[];
  denyPaths: string[];
  droppedPaths: string[];
} {
  const violatingPathSet = new Set(params.violatingPaths.map((path) => path.toLowerCase()));
  const allowPaths = new Set<string>();
  const discardPaths = new Set<string>();
  const denyPaths = new Set<string>();
  const droppedPaths = new Set<string>();

  for (const decision of params.llmResult.decisions) {
    const normalizedPath = decision.path.trim().replace(/\\/g, "/");
    if (!isSafePolicyRecoveryPath(normalizedPath)) {
      droppedPaths.add(normalizedPath);
      continue;
    }
    if (!violatingPathSet.has(normalizedPath.toLowerCase())) {
      droppedPaths.add(normalizedPath);
      continue;
    }
    if (decision.action === "allow" && matchesPattern(normalizedPath, params.deniedPaths)) {
      droppedPaths.add(normalizedPath);
      denyPaths.add(normalizedPath);
      continue;
    }
    if (decision.action === "allow") {
      allowPaths.add(normalizedPath);
    } else if (decision.action === "discard") {
      discardPaths.add(normalizedPath);
    } else {
      denyPaths.add(normalizedPath);
    }
  }

  return {
    allowPaths: Array.from(allowPaths),
    discardPaths: Array.from(discardPaths),
    denyPaths: Array.from(denyPaths),
    droppedPaths: Array.from(droppedPaths),
  };
}

async function runPolicyRecoveryLlm(params: {
  repoPath: string;
  taskData: Task;
  taskId: string;
  allowedPaths: string[];
  deniedPaths: string[];
  policyViolations: string[];
  changedFiles: string[];
  model?: string;
}): Promise<{
  allowPaths: string[];
  discardPaths: string[];
  denyPaths: string[];
  droppedPaths: string[];
  confidence: number | null;
  model: string | null;
  latencyMs: number;
  violatingPaths: string[];
  summary?: string;
} | null> {
  if (!shouldEnablePolicyRecoveryLlm()) {
    return null;
  }
  if (params.taskData.role === "docser") {
    return null;
  }

  const violatingPaths = extractOutsideAllowedViolationPaths(params.policyViolations);
  if (violatingPaths.length === 0) {
    return null;
  }

  const concurrentTaskSummaries = await loadConcurrentTaskSummary(params.taskId);
  const prompt = buildPolicyRecoveryPrompt({
    taskData: params.taskData,
    allowedPaths: params.allowedPaths,
    deniedPaths: params.deniedPaths,
    violatingPaths,
    policyViolations: params.policyViolations,
    changedFiles: params.changedFiles,
    concurrentTaskSummaries,
  });

  const timeoutSeconds = parsePositiveIntEnv("WORKER_POLICY_RECOVERY_TIMEOUT_SECONDS", 90);
  const recoveryModel =
    process.env.WORKER_POLICY_RECOVERY_MODEL?.trim() ||
    params.model?.trim() ||
    process.env.WORKER_MODEL?.trim() ||
    process.env.OPENCODE_SMALL_MODEL?.trim() ||
    process.env.OPENCODE_MODEL?.trim() ||
    undefined;
  const env = await buildOpenCodeEnv(params.repoPath);
  const isolatedWorkdir = await mkdtemp(join(tmpdir(), "openTiger-worker-policy-"));

  try {
    const startedAt = Date.now();
    const result = await runOpenCode({
      workdir: isolatedWorkdir,
      task: prompt,
      model: recoveryModel,
      timeoutSeconds,
      env,
      inheritEnv: false,
      maxRetries: 0,
    });
    const latencyMs = Date.now() - startedAt;
    if (!result.success) {
      console.warn(`[Worker] Policy recovery LLM call failed: ${result.stderr}`);
      return null;
    }
    const llmResult = parsePolicyRecoveryLlmResult(result.stdout);
    if (!llmResult) {
      console.warn("[Worker] Policy recovery LLM response could not be parsed as JSON.");
      return null;
    }
    const sanitized = sanitizeLlmDecisions({
      llmResult,
      violatingPaths,
      deniedPaths: params.deniedPaths,
    });
    return {
      allowPaths: sanitized.allowPaths,
      discardPaths: sanitized.discardPaths,
      denyPaths: sanitized.denyPaths,
      droppedPaths: sanitized.droppedPaths,
      confidence: llmResult.confidence,
      model: recoveryModel ?? null,
      latencyMs,
      violatingPaths,
      summary: llmResult.summary,
    };
  } finally {
    await rm(isolatedWorkdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function applyAllowedPathAdjustments(params: {
  taskId: string;
  allowedPaths: string[];
  extraPaths: string[];
}): Promise<string[]> {
  const { taskId, allowedPaths, extraPaths } = params;
  const nextAllowedPaths = mergeUniquePaths(allowedPaths, extraPaths);
  if (nextAllowedPaths === allowedPaths) {
    return allowedPaths;
  }

  await db
    .update(tasks)
    .set({
      allowedPaths: nextAllowedPaths,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
  const addedPaths = extraPaths.filter((path) => !allowedPaths.includes(path));
  console.log(
    `[Worker] Auto-adjusted allowed paths from policy violations: ${addedPaths.join(", ")}`,
  );
  return nextAllowedPaths;
}

async function tryAutoAllowViolationPaths(params: {
  taskData: Task;
  taskId: string;
  allowedPaths: string[];
  policyViolations: string[];
  policyRecoveryConfig: PolicyRecoveryConfig;
}): Promise<string[]> {
  const { taskData, taskId, allowedPaths, policyViolations, policyRecoveryConfig } = params;
  const outsidePaths = extractOutsideAllowedViolationPaths(policyViolations);
  const autoAllowPaths = resolvePolicyViolationAutoAllowPaths(
    taskData,
    outsidePaths,
    policyRecoveryConfig,
  );
  const commandDrivenPaths = resolveCommandDrivenAllowedPaths(taskData, policyRecoveryConfig);
  return applyAllowedPathAdjustments({
    taskId,
    allowedPaths,
    extraPaths: [...autoAllowPaths, ...commandDrivenPaths],
  });
}

async function attemptGeneratedArtifactRecovery(params: {
  repoPath: string;
  verifyResult: VerifyResult;
  verificationCommands: string[];
  allowedPaths: string[];
  policy: Policy;
  baseBranch: string;
  headBranch: string;
  repoMode: "git" | "local";
  allowNoChanges: boolean;
}): Promise<VerifyResult | null> {
  const violatingPaths = extractPolicyViolationPaths(params.verifyResult.policyViolations).filter(
    (path) => isLikelyGeneratedArtifactPath(path),
  );
  if (violatingPaths.length === 0) {
    return null;
  }

  const cleanupResult = await discardChangesForPaths(params.repoPath, violatingPaths);
  if (!cleanupResult.success) {
    console.warn(
      `[Worker] Failed to discard generated artifact candidates: ${cleanupResult.stderr || "(no stderr)"}`,
    );
    return null;
  }
  const learnedPaths = await persistGeneratedPathHints(params.repoPath, violatingPaths);
  if (learnedPaths.length > 0) {
    console.log(`[Worker] Learned generated artifact path hints: ${learnedPaths.join(", ")}`);
  }

  return verifyChanges({
    repoPath: params.repoPath,
    commands: params.verificationCommands,
    allowedPaths: params.allowedPaths,
    policy: params.policy,
    baseBranch: params.baseBranch,
    headBranch: params.headBranch,
    allowLockfileOutsidePaths: true,
    allowEnvExampleOutsidePaths: params.repoMode === "local",
    allowNoChanges: params.allowNoChanges,
  });
}

export async function runVerificationPhase(
  options: RunVerificationPhaseOptions,
): Promise<VerificationPhaseResult> {
  const {
    repoPath,
    taskData,
    taskId,
    runId,
    agentId,
    branchName,
    baseBranch,
    repoMode,
    verificationAllowedPaths,
    effectivePolicy,
    instructionsPath,
    model,
    retryHints,
    runtimeExecutorDisplayName,
  } = options;
  let executeResult = options.executeResult;
  let effectiveAllowedPaths = [...verificationAllowedPaths];
  const verificationCommands = resolveVerificationCommands(taskData);
  const policyRecoveryConfig = await loadPolicyRecoveryConfig(repoPath);

  console.log("\n[5/7] Verifying changes...");
  let verifyResult = await verifyChanges({
    repoPath,
    commands: verificationCommands,
    allowedPaths: effectiveAllowedPaths,
    policy: effectivePolicy,
    baseBranch,
    headBranch: branchName,
    // Allow lockfile changes from pnpm install
    allowLockfileOutsidePaths: true,
    // Allow .env.example creation in local mode
    allowEnvExampleOutsidePaths: repoMode === "local",
    allowNoChanges: shouldAllowNoChanges(taskData),
  });

  const isNoChangeFailure = (message: string | undefined): boolean => {
    const normalized = (message ?? "").toLowerCase();
    return (
      normalized.includes("no changes were made") ||
      normalized.includes("no relevant changes were made")
    );
  };

  // Attempt self-repair within same process even when failing with no changes
  if (!verifyResult.success && isNoChangeFailure(verifyResult.error)) {
    const rawAttempts = Number.parseInt(process.env.WORKER_NO_CHANGE_RECOVERY_ATTEMPTS ?? "1", 10);
    const noChangeRecoveryAttempts = Number.isFinite(rawAttempts) ? Math.max(0, rawAttempts) : 0;
    for (let attempt = 1; attempt <= noChangeRecoveryAttempts; attempt += 1) {
      const recoveryHint = "No changes detected. Make changes required to meet the task goal.";
      const recoveryHints = [recoveryHint, ...retryHints];
      console.warn(
        `[Worker] No changes detected; recovery attempt ${attempt}/${noChangeRecoveryAttempts}`,
      );
      executeResult = await executeTask({
        repoPath,
        task: taskData,
        instructionsPath,
        model,
        retryHints: recoveryHints,
        policy: effectivePolicy,
      });
      if (!executeResult.success) {
        continue;
      }
      verifyResult = await verifyChanges({
        repoPath,
        commands: verificationCommands,
        allowedPaths: effectiveAllowedPaths,
        policy: effectivePolicy,
        baseBranch,
        headBranch: branchName,
        allowLockfileOutsidePaths: true,
        allowEnvExampleOutsidePaths: repoMode === "local",
        allowNoChanges: shouldAllowNoChanges(taskData),
      });
      if (verifyResult.success) {
        break;
      }
    }
  }

  // Treat as no-op success when verification passes despite zero diff
  if (
    !verifyResult.success &&
    isNoChangeFailure(verifyResult.error) &&
    shouldEnableNoChangeVerificationFallback() &&
    verificationCommands.length > 0
  ) {
    console.warn(
      "[Worker] No diff detected after recovery attempts; running no-change verification fallback.",
    );
    const fallbackVerifyResult = await verifyChanges({
      repoPath,
      commands: verificationCommands,
      allowedPaths: effectiveAllowedPaths,
      policy: effectivePolicy,
      baseBranch,
      headBranch: branchName,
      allowLockfileOutsidePaths: true,
      allowEnvExampleOutsidePaths: repoMode === "local",
      allowNoChanges: true,
    });

    if (fallbackVerifyResult.success && hasMeaningfulVerificationPass(fallbackVerifyResult)) {
      console.log(
        "[Worker] No-change fallback verified successfully. Accepting no-op completion for this task.",
      );
      verifyResult = fallbackVerifyResult;
    } else if (!fallbackVerifyResult.success) {
      verifyResult = fallbackVerifyResult;
    } else {
      console.warn(
        "[Worker] No-change fallback skipped acceptance because no verification command produced a passing result.",
      );
    }
  }

  // On allowedPaths violation, attempt self-repair within same process instead of immediate fail
  if (!verifyResult.success && verifyResult.policyViolations.length > 0) {
    const nextAllowedPaths = await tryAutoAllowViolationPaths({
      taskData,
      taskId,
      allowedPaths: effectiveAllowedPaths,
      policyViolations: verifyResult.policyViolations,
      policyRecoveryConfig,
    });
    const autoAdjustedAllowedPaths = nextAllowedPaths !== effectiveAllowedPaths;
    effectiveAllowedPaths = nextAllowedPaths;

    if (autoAdjustedAllowedPaths) {
      verifyResult = await verifyChanges({
        repoPath,
        commands: verificationCommands,
        allowedPaths: effectiveAllowedPaths,
        policy: effectivePolicy,
        baseBranch,
        headBranch: branchName,
        allowLockfileOutsidePaths: true,
        allowEnvExampleOutsidePaths: repoMode === "local",
        allowNoChanges: shouldAllowNoChanges(taskData),
      });
    }

    if (!verifyResult.success && verifyResult.policyViolations.length > 0) {
      const rawAttempts = Number.parseInt(process.env.WORKER_POLICY_RECOVERY_ATTEMPTS ?? "1", 10);
      const policyRecoveryAttempts = Number.isFinite(rawAttempts) ? Math.max(0, rawAttempts) : 0;
      let llmDeniedRecovery = false;
      for (let attempt = 1; attempt <= policyRecoveryAttempts; attempt += 1) {
        await restoreExpectedBranchContext(repoPath, branchName, runtimeExecutorDisplayName);
        const llmRecovery = await runPolicyRecoveryLlm({
          repoPath,
          taskData,
          taskId,
          allowedPaths: effectiveAllowedPaths,
          deniedPaths: effectivePolicy.deniedPaths,
          policyViolations: verifyResult.policyViolations,
          changedFiles: verifyResult.changedFiles,
          model,
        });
        if (llmRecovery) {
          const llmApplied =
            llmRecovery.allowPaths.length > 0 || llmRecovery.discardPaths.length > 0;
          const decisionSummary = {
            allowCount: llmRecovery.allowPaths.length,
            discardCount: llmRecovery.discardPaths.length,
            denyCount: llmRecovery.denyPaths.length,
            droppedCount: llmRecovery.droppedPaths.length,
          };
          await recordPolicyRecoveryEvent({
            type: "task.policy_recovery_decided",
            taskId,
            runId,
            agentId,
            payload: {
              attempt,
              confidence: llmRecovery.confidence,
              summary: llmRecovery.summary ?? null,
              violatingPaths: llmRecovery.violatingPaths,
              model: llmRecovery.model,
              latencyMs: llmRecovery.latencyMs,
              decisionSummary,
              allowPaths: llmRecovery.allowPaths,
              discardPaths: llmRecovery.discardPaths,
              denyPaths: llmRecovery.denyPaths,
              droppedPaths: llmRecovery.droppedPaths,
              policyViolations: verifyResult.policyViolations,
            },
          });

          if (llmRecovery.discardPaths.length > 0) {
            const discardResult = await discardChangesForPaths(repoPath, llmRecovery.discardPaths);
            if (!discardResult.success) {
              console.warn(
                `[Worker] Failed to discard LLM-selected paths: ${discardResult.stderr || "(no stderr)"}`,
              );
            } else {
              console.log(
                `[Worker] Discarded LLM-selected paths: ${llmRecovery.discardPaths.join(", ")}`,
              );
              const learnedPaths = await persistGeneratedPathHints(
                repoPath,
                llmRecovery.discardPaths,
              );
              if (learnedPaths.length > 0) {
                console.log(
                  `[Worker] Learned generated artifact path hints: ${learnedPaths.join(", ")}`,
                );
              }
            }
          }

          if (llmRecovery.allowPaths.length > 0) {
            effectiveAllowedPaths = await applyAllowedPathAdjustments({
              taskId,
              allowedPaths: effectiveAllowedPaths,
              extraPaths: llmRecovery.allowPaths,
            });
          }

          if (llmApplied) {
            const appliedAction =
              llmRecovery.allowPaths.length > 0 && llmRecovery.discardPaths.length > 0
                ? "allow+discard"
                : llmRecovery.allowPaths.length > 0
                  ? "allow"
                  : "discard";
            await recordPolicyRecoveryEvent({
              type: "task.policy_recovery_applied",
              taskId,
              runId,
              agentId,
              payload: {
                attempt,
                action: appliedAction,
                violatingPaths: llmRecovery.violatingPaths,
                model: llmRecovery.model,
                latencyMs: llmRecovery.latencyMs,
                decisionSummary,
                allowedPaths: llmRecovery.allowPaths,
                discardedPaths: llmRecovery.discardPaths,
                nextAllowedPaths: effectiveAllowedPaths,
              },
            });
          }

          if (llmRecovery.denyPaths.length > 0 && !llmApplied) {
            llmDeniedRecovery = true;
            await recordPolicyRecoveryEvent({
              type: "task.policy_recovery_denied",
              taskId,
              runId,
              agentId,
              payload: {
                attempt,
                denyPaths: llmRecovery.denyPaths,
                summary: llmRecovery.summary ?? null,
                violatingPaths: llmRecovery.violatingPaths,
                model: llmRecovery.model,
                latencyMs: llmRecovery.latencyMs,
                decisionSummary,
              },
            });
            break;
          }

          if (llmApplied) {
            verifyResult = await verifyChanges({
              repoPath,
              commands: verificationCommands,
              allowedPaths: effectiveAllowedPaths,
              policy: effectivePolicy,
              baseBranch,
              headBranch: branchName,
              allowLockfileOutsidePaths: true,
              allowEnvExampleOutsidePaths: repoMode === "local",
              allowNoChanges: shouldAllowNoChanges(taskData),
            });
            if (verifyResult.success) {
              break;
            }
            if (verifyResult.policyViolations.length === 0) {
              console.log(
                "[Worker] Policy violations were resolved after LLM recovery; continuing with verification recovery.",
              );
              break;
            }
            continue;
          }
        }

        const violatingPaths = extractPolicyViolationPaths(verifyResult.policyViolations);
        if (violatingPaths.length > 0) {
          const cleanupResult = await discardChangesForPaths(repoPath, violatingPaths);
          if (!cleanupResult.success) {
            console.warn(
              `[Worker] Failed to clean policy-violating paths before recovery: ${cleanupResult.stderr || "(no stderr)"}`,
            );
          } else {
            console.log(
              `[Worker] Cleaned policy-violating paths before recovery: ${violatingPaths.join(", ")}`,
            );
            const learnedPaths = await persistGeneratedPathHints(repoPath, violatingPaths);
            if (learnedPaths.length > 0) {
              console.log(
                `[Worker] Learned generated artifact path hints: ${learnedPaths.join(", ")}`,
              );
            }
          }

          const verifyAfterCleanup = await verifyChanges({
            repoPath,
            commands: verificationCommands,
            allowedPaths: effectiveAllowedPaths,
            policy: effectivePolicy,
            baseBranch,
            headBranch: branchName,
            allowLockfileOutsidePaths: true,
            allowEnvExampleOutsidePaths: repoMode === "local",
            allowNoChanges: shouldAllowNoChanges(taskData),
          });
          verifyResult = verifyAfterCleanup;
          if (verifyResult.success) {
            console.log(
              "[Worker] Verification passed after cleaning policy-violating paths; skipping recovery execution.",
            );
            break;
          }
          if (verifyResult.policyViolations.length === 0) {
            console.log(
              "[Worker] Policy violations cleared after cleanup; deferring remaining failures to standard verification recovery.",
            );
            break;
          }
        }

        const policyHint = `Remove changes outside allowedPaths and confine edits to allowed paths only: ${verifyResult.policyViolations.join(", ")}`;
        const recoveryHints = [policyHint, ...retryHints];
        console.warn(
          `[Worker] Policy violations detected; recovery attempt ${attempt}/${policyRecoveryAttempts}`,
        );
        executeResult = await executeTask({
          repoPath,
          task: taskData,
          instructionsPath,
          model,
          retryHints: recoveryHints,
          policy: effectivePolicy,
        });
        if (!executeResult.success) {
          continue;
        }
        verifyResult = await verifyChanges({
          repoPath,
          commands: verificationCommands,
          allowedPaths: effectiveAllowedPaths,
          policy: effectivePolicy,
          baseBranch,
          headBranch: branchName,
          allowLockfileOutsidePaths: true,
          allowEnvExampleOutsidePaths: repoMode === "local",
          allowNoChanges: shouldAllowNoChanges(taskData),
        });
        if (verifyResult.success) {
          break;
        }
      }
      if (llmDeniedRecovery && !verifyResult.success && verifyResult.policyViolations.length > 0) {
        console.warn(
          "[Worker] Policy recovery was denied by LLM decision; escalating to blocked for explicit follow-up.",
        );
      }
    }
  }

  if (!verifyResult.success && verifyResult.policyViolations.length > 0) {
    const generatedArtifactRecovery = await attemptGeneratedArtifactRecovery({
      repoPath,
      verifyResult,
      verificationCommands,
      allowedPaths: effectiveAllowedPaths,
      policy: effectivePolicy,
      baseBranch,
      headBranch: branchName,
      repoMode,
      allowNoChanges: shouldAllowNoChanges(taskData),
    });
    if (generatedArtifactRecovery) {
      verifyResult = generatedArtifactRecovery;
    }
  }

  const verifyRecoveryAttempts = parseRecoveryAttempts("WORKER_VERIFY_RECOVERY_ATTEMPTS", 1);
  const allowExplicitVerifyRecovery =
    (process.env.WORKER_VERIFY_RECOVERY_ALLOW_EXPLICIT ?? "true").toLowerCase() !== "false";

  if (
    !verifyResult.success &&
    shouldAttemptVerifyRecovery(verifyResult, allowExplicitVerifyRecovery)
  ) {
    for (let attempt = 1; attempt <= verifyRecoveryAttempts; attempt += 1) {
      const failedCommand = verifyResult.failedCommand ?? "(unknown command)";
      const recoveryHint = buildVerifyRecoveryHint({
        verifyResult,
        attempt,
        maxAttempts: verifyRecoveryAttempts,
      });
      const recoveryHints = [recoveryHint, ...retryHints];
      console.warn(
        `[Worker] Verification failed at ${failedCommand}; recovery attempt ${attempt}/${verifyRecoveryAttempts}`,
      );
      executeResult = await executeTask({
        repoPath,
        task: taskData,
        instructionsPath,
        model,
        retryHints: recoveryHints,
        policy: effectivePolicy,
        verificationRecovery: {
          attempt,
          failedCommand,
          failedCommandSource: verifyResult.failedCommandSource,
          failedCommandStderr: verifyResult.failedCommandStderr,
        },
      });

      if (!executeResult.success) {
        const isTimeout = isExecutionTimeout(
          executeResult.openCodeResult.stderr,
          executeResult.openCodeResult.exitCode,
        );
        if (isTimeout) {
          console.warn(
            "[Worker] Verification recovery execution timed out; continuing to re-verify changes.",
          );
        } else {
          continue;
        }
      }

      await restoreExpectedBranchContext(repoPath, branchName, runtimeExecutorDisplayName);
      verifyResult = await verifyChanges({
        repoPath,
        commands: verificationCommands,
        allowedPaths: effectiveAllowedPaths,
        policy: effectivePolicy,
        baseBranch,
        headBranch: branchName,
        allowLockfileOutsidePaths: true,
        allowEnvExampleOutsidePaths: repoMode === "local",
        allowNoChanges: shouldAllowNoChanges(taskData),
      });
      if (verifyResult.success) {
        break;
      }
      if (!shouldAttemptVerifyRecovery(verifyResult, allowExplicitVerifyRecovery)) {
        break;
      }
    }
  }

  if (!verifyResult.success) {
    if (verifyResult.policyViolations.length > 0) {
      const errorMessage =
        verifyResult.error ?? `Policy violations: ${verifyResult.policyViolations.join(", ")}`;
      console.warn("[Worker] Policy violations detected; deferring to rework flow.");
      await recordContextDeltaFailure({
        message: errorMessage,
        failedCommand: verifyResult.failedCommand,
      }).catch(() => undefined);
      await finalizeTaskState({
        runId,
        taskId,
        agentId,
        runStatus: "failed",
        taskStatus: "blocked",
        blockReason: "needs_rework",
        costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
        errorMessage,
        errorMeta: {
          source: "verification",
          failureCode: verifyResult.failureCode ?? "policy_violation",
          failedCommand: verifyResult.failedCommand ?? null,
          failedCommandSource: verifyResult.failedCommandSource ?? null,
          failedCommandStderr: summarizeVerificationFailure(
            verifyResult.failedCommandStderr ?? verifyResult.error,
          ),
          policyViolations: verifyResult.policyViolations,
        },
      });
      return {
        success: false,
        result: {
          success: false,
          taskId,
          runId,
          error: errorMessage,
        },
      };
    }
    if (!verifyResult.failedCommand?.trim()) {
      throw new Error(verifyResult.error ?? "Verification commands failed");
    }
    const failedCommand = verifyResult.failedCommand ?? "(unknown command)";
    const failedSource = verifyResult.failedCommandSource ?? "explicit";
    const stderrSummary = summarizeVerificationFailure(
      verifyResult.failedCommandStderr ?? verifyResult.error,
    );
    const verifyMarker = encodeVerifyReworkMarker({
      failedCommand,
      failedCommandSource: failedSource,
      stderrSummary,
    });
    const existingNotes = taskData.context?.notes;
    const markerPrefix = "[verify-rework-json]";
    const hasVerifyMarker = existingNotes?.includes(markerPrefix) ?? false;
    const notesToAppend = hasVerifyMarker
      ? []
      : [
          "[verify-rework] Verification command failure requires focused rework.",
          `failed_command: ${failedCommand}`,
          `failed_source: ${failedSource}`,
          `failed_stderr: ${stderrSummary}`,
          verifyMarker,
        ];
    if (notesToAppend.length > 0) {
      const updatedContext = {
        ...taskData.context,
        notes: appendContextNotes(existingNotes, notesToAppend),
      };
      await db
        .update(tasks)
        .set({
          context: updatedContext,
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));
    }

    const errorMessage =
      verifyResult.error ??
      `Verification failed at ${failedCommand} [${failedSource}]: ${stderrSummary}`;
    console.warn("[Worker] Verification failure detected; deferring to rework flow.");
    await recordContextDeltaFailure({
      message: errorMessage,
      failedCommand,
    }).catch(() => undefined);
    await finalizeTaskState({
      runId,
      taskId,
      agentId,
      runStatus: "failed",
      taskStatus: "blocked",
      blockReason: "needs_rework",
      costTokens: executeResult.openCodeResult.tokenUsage?.totalTokens ?? null,
      errorMessage,
      errorMeta: {
        source: "verification",
        failureCode: verifyResult.failureCode ?? "verification_command_failed",
        failedCommand,
        failedCommandSource: failedSource,
        failedCommandStderr: stderrSummary,
      },
    });
    return {
      success: false,
      result: {
        success: false,
        taskId,
        runId,
        error: errorMessage,
      },
    };
  }

  return {
    success: true,
    verifyResult,
    executeResult,
  };
}
