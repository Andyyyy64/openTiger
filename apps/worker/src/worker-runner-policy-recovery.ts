import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@openTiger/db";
import { events, tasks } from "@openTiger/db/schema";
import { runOpenCode } from "@openTiger/llm";
import {
  extractOutsideAllowedViolationPaths,
  mergeUniquePaths,
  resolveCommandDrivenAllowedPaths,
  resolvePolicyViolationAutoAllowPaths,
  type PolicyRecoveryConfig,
  type Task,
} from "@openTiger/core";
import { and, eq, inArray, ne } from "drizzle-orm";
import { matchesPattern } from "./steps/verify/paths";
import { buildOpenCodeEnv } from "./env";

export type PolicyRecoveryDecisionAction = "allow" | "discard" | "deny";

export type PolicyRecoveryDecision = {
  path: string;
  action: PolicyRecoveryDecisionAction;
  reason: string;
};

export type PolicyRecoveryLlmResult = {
  decisions: PolicyRecoveryDecision[];
  confidence: number | null;
  summary?: string;
};

export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return raw;
}

function shouldEnablePolicyRecoveryLlm(): boolean {
  return (process.env.WORKER_POLICY_RECOVERY_USE_LLM ?? "true").toLowerCase() !== "false";
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

export async function recordPolicyRecoveryEvent(params: {
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

export function sanitizeLlmDecisions(params: {
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

export async function runPolicyRecoveryLlm(params: {
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

export async function applyAllowedPathAdjustments(params: {
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

export async function tryAutoAllowViolationPaths(params: {
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
