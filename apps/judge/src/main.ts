import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { db } from "@openTiger/db";
import { artifacts, runs, tasks, agents, events } from "@openTiger/db/schema";
import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import {
  DEFAULT_POLICY,
  PolicySchema,
  type Policy,
  getRepoMode,
  getLocalRepoPath,
  applyRepoModePolicyOverrides,
} from "@openTiger/core";
import "dotenv/config";

// ハートビートの間隔（ミリ秒）
const HEARTBEAT_INTERVAL = 30000; // 30秒

// ハートビートを送信する関数
async function startHeartbeat(agentId: string) {
  return setInterval(async () => {
    try {
      await db
        .update(agents)
        .set({
          lastHeartbeat: new Date(),
        })
        .where(eq(agents.id, agentId));
    } catch (error) {
      console.error(`[Heartbeat] Failed to send heartbeat for ${agentId}:`, error);
    }
  }, HEARTBEAT_INTERVAL);
}

async function setJudgeAgentState(
  agentId: string,
  status: "idle" | "busy",
  currentTaskId: string | null = null
): Promise<void> {
  await db
    .update(agents)
    .set({
      status,
      currentTaskId,
      lastHeartbeat: new Date(),
    })
    .where(eq(agents.id, agentId));
}

async function safeSetJudgeAgentState(
  agentId: string,
  status: "idle" | "busy",
  currentTaskId: string | null = null
): Promise<void> {
  try {
    await setJudgeAgentState(agentId, status, currentTaskId);
  } catch (error) {
    console.error(`[Judge] Failed to update agent state (${status})`, error);
  }
}

import {
  evaluateCI,
  evaluatePolicy,
  evaluateLLM,
  evaluateLLMDiff,
  evaluateSimple,
  evaluateRiskLevel,
  getPRDiffStats,
  evaluateLocalCI,
  evaluateLocalPolicy,
  getLocalDiffStats,
  getLocalDiffText,
  type LLMEvaluationResult,
} from "./evaluators/index.js";
import {
  checkoutBranch,
  mergeBranch,
  getChangedFiles,
  resetHard,
  getWorkingTreeDiff,
  getUntrackedFiles,
  stashChanges,
  getLatestStashRef,
  applyStash,
  dropStash,
  stageAll,
  commitChanges,
  isMergeInProgress,
  abortMerge,
  cleanUntracked,
  getOctokit,
  getRepoInfo,
} from "@openTiger/vcs";

import {
  makeJudgement,
  reviewAndAct,
  type EvaluationSummary,
  type JudgeResult,
} from "./pr-reviewer.js";
import { createDocserTaskForLocal, createDocserTaskForPR } from "./docser.js";

function setupProcessLogging(logName: string): string | undefined {
  const logDir = process.env.OPENTIGER_LOG_DIR ?? "/tmp/openTiger-logs";

  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create log dir: ${logDir}`, error);
    return;
  }

  const logPath = join(logDir, `${logName}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });

  // Save logs to file so they can be tracked even if terminal output is lost
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk, encoding, callback) => {
    stream.write(chunk);
    return stdoutWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk, encoding, callback) => {
    stream.write(chunk);
    return stderrWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stderr.write;

  process.on("exit", () => {
    stream.end();
  });

  console.log(`[Logger] Judge logs are written to ${logPath}`);
  return logPath;
}

// Judge設定
interface JudgeConfig {
  agentId: string;
  pollIntervalMs: number;
  workdir: string;
  instructionsPath: string;
  useLlm: boolean;
  dryRun: boolean;
  mergeOnApprove: boolean;
  requeueOnNonApprove: boolean;
  policy: Policy;
  mode: "git" | "local";
  baseRepoRecoveryMode: "none" | "stash" | "llm";
  baseRepoRecoveryConfidence: number;
  baseRepoRecoveryDiffLimit: number;
}

// デフォルト設定
const DEFAULT_CONFIG: JudgeConfig = {
  agentId: process.env.AGENT_ID ?? "judge-1",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? "30000", 10),
  workdir: process.cwd(),
  instructionsPath: resolve(import.meta.dirname, "../instructions/review.md"),
  useLlm: process.env.USE_LLM !== "false",
  dryRun: process.env.DRY_RUN === "true",
  mergeOnApprove: process.env.JUDGE_MERGE_ON_APPROVE !== "false",
  requeueOnNonApprove: process.env.JUDGE_REQUEUE_ON_NON_APPROVE !== "false",
  policy: DEFAULT_POLICY,
  mode: "git",
  baseRepoRecoveryMode: "llm",
  baseRepoRecoveryConfidence: 0.7,
  baseRepoRecoveryDiffLimit: 20000,
};

const JUDGE_AUTO_FIX_ON_FAIL = process.env.JUDGE_AUTO_FIX_ON_FAIL !== "false";
const JUDGE_AUTO_FIX_MAX_ATTEMPTS = Number.parseInt(
  process.env.JUDGE_AUTO_FIX_MAX_ATTEMPTS ?? "3",
  10
);
const JUDGE_AWAITING_RETRY_COOLDOWN_MS = Number.parseInt(
  process.env.JUDGE_AWAITING_RETRY_COOLDOWN_MS ?? "120000",
  10
);
const JUDGE_PR_MERGEABLE_PRECHECK_RETRIES = Number.parseInt(
  process.env.JUDGE_PR_MERGEABLE_PRECHECK_RETRIES ?? "3",
  10
);
const JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS = Number.parseInt(
  process.env.JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS ?? "1000",
  10
);
const JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES = Number.parseInt(
  process.env.JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES ?? "2",
  10
);
const JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES = Number.parseInt(
  process.env.JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES ?? "2",
  10
);

const BASE_REPO_RECOVERY_MODES = ["none", "stash", "llm"] as const;

function resolveBaseRepoRecoveryMode(): "none" | "stash" | "llm" {
  const value = process.env.JUDGE_LOCAL_BASE_REPO_RECOVERY;
  return BASE_REPO_RECOVERY_MODES.includes(
    value as (typeof BASE_REPO_RECOVERY_MODES)[number]
  )
    ? (value as (typeof BASE_REPO_RECOVERY_MODES)[number])
    : "llm";
}

function resolveBaseRepoRecoveryConfidence(): number {
  const value = parseFloat(process.env.JUDGE_LOCAL_BASE_REPO_RECOVERY_CONFIDENCE ?? "");
  if (Number.isFinite(value)) {
    return Math.min(Math.max(value, 0), 1);
  }
  return 0.7;
}

function resolveBaseRepoRecoveryDiffLimit(): number {
  const value = parseInt(process.env.JUDGE_LOCAL_BASE_REPO_RECOVERY_DIFF_LIMIT ?? "", 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return 20000;
}

type BaseRepoRecoveryLevel = "low" | "medium" | "high";
interface BaseRepoRecoveryRules {
  level: BaseRepoRecoveryLevel;
  minConfidence: number;
  diffLimit: number;
  requireNoErrors: boolean;
  requireNoWarnings: boolean;
}

const BASE_REPO_RECOVERY_RULES: Record<BaseRepoRecoveryLevel, BaseRepoRecoveryRules> = {
  low: {
    level: "low",
    minConfidence: 0.6,
    diffLimit: 20000,
    requireNoErrors: false,
    requireNoWarnings: false,
  },
  medium: {
    level: "medium",
    minConfidence: 0.75,
    diffLimit: 10000,
    requireNoErrors: true,
    requireNoWarnings: false,
  },
  high: {
    level: "high",
    minConfidence: 0.9,
    diffLimit: 5000,
    requireNoErrors: true,
    requireNoWarnings: true,
  },
};

function resolveBaseRepoRecoveryLevel(policy: Policy): BaseRepoRecoveryLevel {
  return policy.baseRepoRecovery?.level ?? policy.autoMerge.level ?? "medium";
}

function resolveBaseRepoRecoveryRules(
  policy: Policy,
  config: JudgeConfig
): BaseRepoRecoveryRules {
  const level = resolveBaseRepoRecoveryLevel(policy);
  const defaults = BASE_REPO_RECOVERY_RULES[level];
  return {
    level,
    minConfidence: Math.max(defaults.minConfidence, config.baseRepoRecoveryConfidence),
    diffLimit: Math.min(defaults.diffLimit, config.baseRepoRecoveryDiffLimit),
    requireNoErrors: defaults.requireNoErrors,
    requireNoWarnings: defaults.requireNoWarnings,
  };
}

interface PRMergeabilitySnapshot {
  mergeable: boolean | null;
  mergeableState: string;
}

interface PRMergeabilityPrecheck {
  shouldSkipLLM: boolean;
  llmFallback?: LLMEvaluationResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLLMFailureResult(reason: string, suggestions: string[]): LLMEvaluationResult {
  return {
    pass: false,
    confidence: 0,
    reasons: [reason],
    suggestions,
    codeIssues: [],
  };
}

function isMergeConflictState(snapshot: PRMergeabilitySnapshot): boolean {
  if (snapshot.mergeable === true) {
    return false;
  }
  return snapshot.mergeableState === "dirty";
}

async function getPRMergeabilitySnapshot(prNumber: number): Promise<PRMergeabilitySnapshot> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();
  const maxRetries = Number.isFinite(JUDGE_PR_MERGEABLE_PRECHECK_RETRIES)
    ? Math.max(1, JUDGE_PR_MERGEABLE_PRECHECK_RETRIES)
    : 3;
  const retryDelayMs = Number.isFinite(JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS)
    ? Math.max(0, JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS)
    : 1000;

  let mergeable: boolean | null = null;
  let mergeableState = "unknown";

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    mergeable = response.data.mergeable;
    mergeableState = response.data.mergeable_state ?? "unknown";

    if (mergeable !== null || attempt === maxRetries) {
      break;
    }
    await sleep(retryDelayMs);
  }

  return { mergeable, mergeableState };
}

async function tryUpdatePRBranch(
  prNumber: number
): Promise<{ requested: boolean; reason: string }> {
  try {
    const octokit = getOctokit();
    const { owner, repo } = getRepoInfo();
    await octokit.pulls.updateBranch({
      owner,
      repo,
      pull_number: prNumber,
    });
    return { requested: true, reason: "update_branch_requested" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { requested: false, reason: `update_branch_failed:${message}` };
  }
}

async function precheckPRMergeability(prNumber: number): Promise<PRMergeabilityPrecheck> {
  try {
    const snapshot = await getPRMergeabilitySnapshot(prNumber);

    if (isMergeConflictState(snapshot)) {
      return {
        shouldSkipLLM: true,
        llmFallback: createLLMFailureResult("LLM skipped: pr_merge_conflict_detected", [
          "Resolve merge conflicts with base branch before running LLM review.",
        ]),
      };
    }

    if (snapshot.mergeableState === "behind") {
      const sync = await tryUpdatePRBranch(prNumber);
      return {
        shouldSkipLLM: true,
        llmFallback: createLLMFailureResult(
          `LLM skipped: pr_base_behind (${sync.reason})`,
          ["Wait for branch sync and retry judge review."]
        ),
      };
    }

    return { shouldSkipLLM: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      shouldSkipLLM: true,
      llmFallback: createLLMFailureResult(`LLM skipped: mergeability_precheck_failed (${message})`, [
        "Retry judge review after precheck error cooldown.",
      ]),
    };
  }
}

async function recordJudgeReview(
  pr: {
    prNumber: number;
    prUrl: string;
    taskId: string;
    runId: string;
  },
  result: JudgeResult,
  summary: EvaluationSummary,
  actionResult: { commented: boolean; approved: boolean; merged: boolean },
  agentId: string,
  dryRun: boolean
): Promise<void> {
  try {
    await db.insert(events).values({
      type: "judge.review",
      entityType: "task",
      entityId: pr.taskId,
      agentId,
      payload: {
        prNumber: pr.prNumber,
        prUrl: pr.prUrl,
        runId: pr.runId,
        taskId: pr.taskId,
        verdict: result.verdict,
        autoMerge: result.autoMerge,
        riskLevel: result.riskLevel,
        confidence: result.confidence,
        reasons: result.reasons,
        suggestions: result.suggestions,
        summary,
        actions: actionResult,
        dryRun,
      },
    });
  } catch (error) {
    console.error(
      `[Judge] Failed to record review event for PR #${pr.prNumber}:`,
      error
    );
  }
}

async function recordLocalReview(
  target: {
    taskId: string;
    runId: string;
    worktreePath: string;
    baseBranch: string;
    branchName: string;
    baseRepoPath?: string;
  },
  result: JudgeResult,
  summary: EvaluationSummary,
  agentId: string,
  dryRun: boolean,
  mergeResult?: { success: boolean; error?: string }
): Promise<void> {
  try {
    await db.insert(events).values({
      type: "judge.review",
      entityType: "task",
      entityId: target.taskId,
      agentId,
      payload: {
        mode: "local",
        taskId: target.taskId,
        runId: target.runId,
        worktreePath: target.worktreePath,
        baseBranch: target.baseBranch,
        branchName: target.branchName,
        baseRepoPath: target.baseRepoPath,
        verdict: result.verdict,
        autoMerge: result.autoMerge,
        riskLevel: result.riskLevel,
        confidence: result.confidence,
        reasons: result.reasons,
        suggestions: result.suggestions,
        summary,
        dryRun,
        mergeResult,
      },
    });
  } catch (error) {
    console.error("[Judge] Failed to record local review event:", error);
  }
}

async function loadPolicyConfig(): Promise<Policy> {
  const policyPath = process.env.POLICY_PATH
    ?? resolve(import.meta.dirname, "../../../packages/policies/default/policy.json");

  try {
    const raw = await readFile(policyPath, "utf-8");
    const parsed = JSON.parse(raw);
    const policy = PolicySchema.parse(parsed);
    console.log(`[Judge] Loaded policy from ${policyPath}`);
    return policy;
  } catch (error) {
    console.warn(`[Judge] Failed to load policy from ${policyPath}, using defaults`, error);
    return DEFAULT_POLICY;
  }
}

function adjustPolicyForAutoMerge(policy: Policy): Policy {
  const level = policy.autoMerge.level ?? "medium";
  const scale = (() => {
    switch (level) {
      case "low":
        // 自動マージを優先するため許容幅を広げる
        return { lines: 15, files: 10 };
      case "high":
        return { lines: 0.5, files: 0.5 };
      default:
        return { lines: 1, files: 1 };
    }
  })();

  return {
    ...policy,
    maxLinesChanged: Math.max(1, Math.round(policy.maxLinesChanged * scale.lines)),
    maxFilesChanged: Math.max(1, Math.round(policy.maxFilesChanged * scale.files)),
  };
}

// レビュー待ちのPRを取得
async function getPendingPRs(): Promise<
  Array<{
    prNumber: number;
    prUrl: string;
    taskId: string;
    runId: string;
    startedAt: Date;
    taskTitle: string;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
    commands: string[];
  }>
> {
  // Get successful runs that have PRs created
  const result = await db
    .select({
      prNumber: artifacts.ref,
      prUrl: artifacts.url,
      taskId: runs.taskId,
      runId: runs.id,
      startedAt: runs.startedAt,
    })
    .from(artifacts)
    .innerJoin(runs, eq(artifacts.runId, runs.id))
    .where(
      and(
        eq(artifacts.type, "pr"),
        eq(runs.status, "success"),
        isNull(runs.judgedAt),
        isNotNull(artifacts.ref)
      )
    )
    .orderBy(desc(runs.startedAt));

  // Get task information
  const pendingPRs: Array<{
    prNumber: number;
    prUrl: string;
    taskId: string;
    runId: string;
    startedAt: Date;
    taskTitle: string;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
    commands: string[];
  }> = [];
  const seenTaskIds = new Set<string>();

  for (const row of result) {
    if (!row.prNumber) continue;
    if (seenTaskIds.has(row.taskId)) continue;

    const prNumber = parseInt(row.prNumber, 10);
    if (isNaN(prNumber)) continue;

    // Get task information
    const taskResult = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, row.taskId));

    const task = taskResult[0];
    if (!task) continue;

    // Only review tasks waiting for Judge (blocked)
    if (task.status !== "blocked") continue;

    pendingPRs.push({
      prNumber,
      prUrl: row.prUrl ?? "",
      taskId: row.taskId,
      runId: row.runId,
      startedAt: row.startedAt,
      taskTitle: task.title,
      taskGoal: task.goal,
      taskRiskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
      allowedPaths: task.allowedPaths ?? [],
      commands: task.commands ?? [],
    });
    seenTaskIds.add(row.taskId);
  }

  return pendingPRs;
}

async function getPendingWorktrees(): Promise<
  Array<{
    worktreePath: string;
    baseBranch: string;
    branchName: string;
    baseRepoPath?: string;
    taskId: string;
    runId: string;
    startedAt: Date;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
  }>
> {
  const result = await db
    .select({
      worktreePath: artifacts.ref,
      metadata: artifacts.metadata,
      taskId: runs.taskId,
      runId: runs.id,
      startedAt: runs.startedAt,
    })
    .from(artifacts)
    .innerJoin(runs, eq(artifacts.runId, runs.id))
    .where(
      and(
        eq(artifacts.type, "worktree"),
        eq(runs.status, "success"),
        isNull(runs.judgedAt),
        isNotNull(artifacts.ref)
      )
    )
    .orderBy(desc(runs.startedAt));

  const pendingWorktrees: Array<{
    worktreePath: string;
    baseBranch: string;
    branchName: string;
    baseRepoPath?: string;
    taskId: string;
    runId: string;
    startedAt: Date;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
  }> = [];
  const seenTaskIds = new Set<string>();

  for (const row of result) {
    if (!row.worktreePath) continue;
    if (seenTaskIds.has(row.taskId)) continue;
    const metadata = row.metadata;
    const baseBranch =
      typeof metadata === "object" && metadata && "baseBranch" in metadata
        ? String((metadata as { baseBranch?: unknown }).baseBranch ?? "main")
        : (process.env.BASE_BRANCH ?? "main");
    const branchName =
      typeof metadata === "object" && metadata && "branchName" in metadata
        ? String((metadata as { branchName?: unknown }).branchName ?? "HEAD")
        : "HEAD";

    const taskResult = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, row.taskId));

    const task = taskResult[0];
    if (!task) continue;
    // Only review tasks waiting for Judge (blocked)
    if (task.status !== "blocked") continue;

    pendingWorktrees.push({
      worktreePath: row.worktreePath,
      baseBranch,
      branchName,
      baseRepoPath:
        typeof metadata === "object" && metadata && "baseRepoPath" in metadata
          ? String((metadata as { baseRepoPath?: unknown }).baseRepoPath ?? "")
          : getLocalRepoPath(),
      taskId: row.taskId,
      runId: row.runId,
      startedAt: row.startedAt,
      taskGoal: task.goal,
      taskRiskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
      allowedPaths: task.allowedPaths ?? [],
    });
    seenTaskIds.add(row.taskId);
  }

  return pendingWorktrees;
}

// 単一のPRを評価
async function judgeSinglePR(
  pr: {
    prNumber: number;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
  },
  config: JudgeConfig
): Promise<{ result: JudgeResult; summary: EvaluationSummary }> {
  console.log(`\n[Evaluating PR #${pr.prNumber}]`);
  const evaluationPolicy = adjustPolicyForAutoMerge(config.policy);

  // 1. CI評価
  console.log("  - Checking CI status...");
  const ciResult = await evaluateCI(pr.prNumber);
  console.log(`    CI: ${ciResult.pass ? "PASS" : "FAIL"}`);

  // 2. ポリシー評価
  console.log("  - Checking policy compliance...");
  const diffStats = await getPRDiffStats(pr.prNumber);
  const policyResult = await evaluatePolicy(
    pr.prNumber,
    evaluationPolicy,
    pr.allowedPaths
  );
  console.log(`    Policy: ${policyResult.pass ? "PASS" : "FAIL"}`);

  // 計算されたリスクレベル
  const computedRisk = evaluateRiskLevel(diffStats, evaluationPolicy);
  console.log(`    Computed Risk: ${computedRisk} (Task Risk: ${pr.taskRiskLevel})`);

  // 3. LLM評価
  let llmResult;
  if (config.useLlm && ciResult.pass && policyResult.pass) {
    const precheck = await precheckPRMergeability(pr.prNumber);
    if (precheck.shouldSkipLLM) {
      llmResult = precheck.llmFallback ?? createLLMFailureResult(
        "LLM skipped: mergeability_precheck_blocked",
        ["Retry judge review after mergeability precheck."]
      );
      console.log(`    LLM: SKIPPED (${llmResult.reasons.join("; ")})`);
    } else {
      console.log("  - Running LLM code review...");
      llmResult = await evaluateLLM(pr.prNumber, {
        taskGoal: pr.taskGoal,
        instructionsPath: config.instructionsPath,
      });
      console.log(
        `    LLM: ${llmResult.pass ? "PASS" : "FAIL"} (confidence: ${Math.round(llmResult.confidence * 100)}%)`
      );
    }
  } else {
    llmResult = evaluateSimple();
    console.log("    LLM: SKIPPED");
  }

  const summary: EvaluationSummary = {
    ci: ciResult,
    policy: policyResult,
    llm: llmResult,
  };

  // 判定（計算されたリスクと自己申告リスクのうち、高い方を採用）
  const riskPriority = { low: 0, medium: 1, high: 2 };
  const effectiveRisk =
    riskPriority[computedRisk] > riskPriority[pr.taskRiskLevel]
      ? computedRisk
      : pr.taskRiskLevel;

  const result = makeJudgement(summary, config.policy, effectiveRisk);

  console.log(`  => Verdict: ${result.verdict.toUpperCase()}`);
  if (result.autoMerge) {
    console.log("  => Will auto-merge");
  }

  return { result, summary };
}

async function judgeSingleWorktree(
  target: {
    worktreePath: string;
    baseBranch: string;
    branchName: string;
    baseRepoPath?: string;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
  },
  config: JudgeConfig
): Promise<{ result: JudgeResult; summary: EvaluationSummary; diffFiles: string[] }> {
  console.log(`\n[Evaluating Worktree ${target.worktreePath}]`);
  const evaluationPolicy = adjustPolicyForAutoMerge(config.policy);

  const ciResult = evaluateLocalCI();

  const diffStats = await getLocalDiffStats(
    target.worktreePath,
    target.baseBranch,
    target.branchName
  );
  const diffFiles = diffStats.files.map((file) => file.filename);

  const policyResult = await evaluateLocalPolicy(
    target.worktreePath,
    target.baseBranch,
    target.branchName,
    evaluationPolicy,
    target.allowedPaths
  );

  const computedRisk = evaluateRiskLevel(diffStats, evaluationPolicy);

  let llmResult;
  if (config.useLlm && ciResult.pass && policyResult.pass) {
    const diffText = await getLocalDiffText(
      target.worktreePath,
      target.baseBranch,
      target.branchName
    );
    llmResult = await evaluateLLMDiff(diffText, target.taskGoal, {
      instructionsPath: config.instructionsPath,
    });
  } else {
    llmResult = evaluateSimple();
  }

  const summary: EvaluationSummary = {
    ci: ciResult,
    policy: policyResult,
    llm: llmResult,
  };

  const riskPriority = { low: 0, medium: 1, high: 2 };
  const effectiveRisk =
    riskPriority[computedRisk] > riskPriority[target.taskRiskLevel]
      ? computedRisk
      : target.taskRiskLevel;

  const result = makeJudgement(summary, config.policy, effectiveRisk);
  return { result, summary, diffFiles };
}

function buildJudgeFailureMessage(
  result: JudgeResult,
  actionError?: unknown
): string {
  const parts = [`Judge verdict: ${result.verdict}`];
  if (result.reasons.length > 0) {
    parts.push(`Reasons: ${result.reasons.slice(0, 3).join(" / ")}`);
  }
  if (actionError) {
    const message = actionError instanceof Error ? actionError.message : String(actionError);
    parts.push(`Action error: ${message}`);
  }
  return parts.join(" | ").slice(0, 1000);
}

function hasActionableLLMFailures(summary: EvaluationSummary): boolean {
  return !summary.llm.pass && summary.llm.codeIssues.length > 0;
}

function isDoomLoopFailure(summary: EvaluationSummary): boolean {
  if (summary.llm.pass) {
    return false;
  }
  return summary.llm.reasons.some((reason) => reason.toLowerCase().includes("doom_loop_detected"));
}

function isNonActionableLLMFailure(summary: EvaluationSummary): boolean {
  if (summary.llm.pass) {
    return false;
  }
  if (summary.llm.codeIssues.length > 0) {
    return false;
  }
  const reasonText = summary.llm.reasons.join(" ").toLowerCase();
  if (reasonText.length === 0) {
    return summary.llm.confidence <= 0;
  }
  return (
    summary.llm.confidence <= 0
    || reasonText.includes("quota")
    || reasonText.includes("rate limit")
    || reasonText.includes("resource_exhausted")
    || reasonText.includes("pr_merge_conflict_detected")
    || reasonText.includes("pr_base_behind")
    || reasonText.includes("mergeability_precheck_failed")
    || reasonText.includes("llm review failed")
    || reasonText.includes("encountered an error")
    || reasonText.includes("manual review recommended")
  );
}

function escapeSqlLikePattern(input: string): string {
  return input
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function summarizeLLMIssuesForTask(summary: EvaluationSummary): string {
  const issues = summary.llm.codeIssues.slice(0, 12).map((issue, index) => {
    const location = issue.file
      ? `${issue.file}${issue.line ? `:${issue.line}` : ""}`
      : "unknown";
    const suggestion = issue.suggestion ? ` | fix: ${issue.suggestion}` : "";
    return `${index + 1}. [${issue.severity}] ${issue.category} @ ${location}: ${issue.message}${suggestion}`;
  });
  if (issues.length === 0) {
    return summary.llm.reasons.join("\n");
  }
  return issues.join("\n");
}

function isMergeConflictReasonText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return (
    lower.includes("not mergeable")
    || lower.includes("merge conflict")
    || lower.includes("conflict")
    || lower.includes("pr_merge_conflict_detected")
    || lower.includes("mergeable_state")
    || lower.includes("dirty")
    || lower.includes("update_branch_failed")
  );
}

function hasMergeConflictSignals(params: {
  summary: EvaluationSummary;
  mergeDeferredReason?: string;
}): boolean {
  if (isMergeConflictReasonText(params.mergeDeferredReason)) {
    return true;
  }
  if (params.summary.llm.reasons.some((reason) => isMergeConflictReasonText(reason))) {
    return true;
  }
  return params.summary.llm.suggestions.some((suggestion) =>
    isMergeConflictReasonText(suggestion)
  );
}

async function getPrBranchContext(prNumber: number): Promise<{
  headRef?: string;
  headSha?: string;
  baseRef?: string;
}> {
  try {
    const octokit = getOctokit();
    const { owner, repo } = getRepoInfo();
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return {
      headRef: response.data.head.ref ?? undefined,
      headSha: response.data.head.sha ?? undefined,
      baseRef: response.data.base.ref ?? undefined,
    };
  } catch (error) {
    console.warn(
      `[Judge] Failed to resolve PR branch context for #${prNumber}:`,
      error
    );
    return {};
  }
}

async function createAutoFixTaskForPr(params: {
  prNumber: number;
  prUrl: string;
  sourceTaskId: string;
  sourceRunId: string;
  sourceTaskTitle: string;
  sourceTaskGoal: string;
  allowedPaths: string[];
  commands: string[];
  summary: EvaluationSummary;
  agentId: string;
}): Promise<{ created: boolean; taskId?: string; reason: string }> {
  if (!JUDGE_AUTO_FIX_ON_FAIL) {
    return { created: false, reason: "auto_fix_disabled" };
  }
  if (params.summary.llm.pass) {
    return { created: false, reason: "llm_pass" };
  }

  const titlePrefix = `[AutoFix] PR #${params.prNumber}`;
  const titlePattern = `${escapeSqlLikePattern(titlePrefix)}%`;
  const maxAttempts = Number.isFinite(JUDGE_AUTO_FIX_MAX_ATTEMPTS)
    ? Math.max(1, JUDGE_AUTO_FIX_MAX_ATTEMPTS)
    : 3;

  const [activeTask] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(
      and(
        sql`${tasks.title} like ${titlePattern} escape '\\'`,
        inArray(tasks.status, ["queued", "running", "blocked"])
      )
    )
    .limit(1);
  if (activeTask?.id) {
    return { created: false, reason: `existing_active_autofix:${activeTask.id}` };
  }

  const [attemptRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(sql`${tasks.title} like ${titlePattern} escape '\\'`);
  const attemptCount = Number(attemptRow?.count ?? 0);
  if (attemptCount >= maxAttempts) {
    return { created: false, reason: `autofix_attempt_limit_reached:${attemptCount}/${maxAttempts}` };
  }

  const issueFiles = Array.from(
    new Set(
      params.summary.llm.codeIssues
        .map((issue) => issue.file?.trim())
        .filter((file): file is string => Boolean(file))
    )
  );
  const summarizedIssues = summarizeLLMIssuesForTask(params.summary);
  const nextAttempt = attemptCount + 1;
  const prBranchContext = await getPrBranchContext(params.prNumber);

  const [taskRow] = await db
    .insert(tasks)
    .values({
      title: `${titlePrefix} (attempt ${nextAttempt}/${maxAttempts})`,
      goal:
        `Fix judge-reported issues for PR #${params.prNumber} and create a follow-up PR that passes review. ` +
        `Original review task: ${params.sourceTaskId}.`,
      context: {
        files: issueFiles,
        specs:
          "Resolve the issues listed in notes. Keep scope minimal and aligned with allowed paths. " +
          "Do not run long-running dev/watch/start commands.",
        notes: summarizedIssues,
        pr: {
          number: params.prNumber,
          url: params.prUrl,
          sourceTaskId: params.sourceTaskId,
          sourceRunId: params.sourceRunId,
          headRef: prBranchContext.headRef,
          headSha: prBranchContext.headSha,
          baseRef: prBranchContext.baseRef,
        },
      },
      allowedPaths: params.allowedPaths.length > 0 ? params.allowedPaths : ["**"],
      commands: params.commands,
      dependencies: [],
      priority: 80,
      riskLevel: "medium",
      role: "worker",
      status: "queued",
      timeboxMinutes: 60,
    })
    .returning({ id: tasks.id });

  if (!taskRow?.id) {
    return { created: false, reason: "autofix_task_insert_failed" };
  }

  await db.insert(events).values({
    type: "judge.autofix_task_created",
    entityType: "task",
    entityId: taskRow.id,
    agentId: params.agentId,
    payload: {
      prNumber: params.prNumber,
      sourceTaskId: params.sourceTaskId,
      sourceRunId: params.sourceRunId,
      sourceTaskTitle: params.sourceTaskTitle,
      sourceTaskGoal: params.sourceTaskGoal,
      attempt: nextAttempt,
      maxAttempts,
    },
  });

  return { created: true, taskId: taskRow.id, reason: "created" };
}

async function createConflictAutoFixTaskForPr(params: {
  prNumber: number;
  prUrl: string;
  sourceTaskId: string;
  sourceRunId: string;
  sourceTaskTitle: string;
  sourceTaskGoal: string;
  allowedPaths: string[];
  commands: string[];
  summary: EvaluationSummary;
  agentId: string;
  mergeDeferredReason?: string;
}): Promise<{ created: boolean; taskId?: string; reason: string }> {
  if (!JUDGE_AUTO_FIX_ON_FAIL) {
    return { created: false, reason: "auto_fix_disabled" };
  }

  const titlePrefix = `[AutoFix-Conflict] PR #${params.prNumber}`;
  const titlePattern = `${escapeSqlLikePattern(titlePrefix)}%`;
  const maxAttempts = Number.isFinite(JUDGE_AUTO_FIX_MAX_ATTEMPTS)
    ? Math.max(1, JUDGE_AUTO_FIX_MAX_ATTEMPTS)
    : 3;

  const [activeTask] = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(
      and(
        sql`${tasks.title} like ${titlePattern} escape '\\'`,
        inArray(tasks.status, ["queued", "running", "blocked"])
      )
    )
    .limit(1);
  if (activeTask?.id) {
    return { created: false, reason: `existing_active_conflict_autofix:${activeTask.id}` };
  }

  const [attemptRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(sql`${tasks.title} like ${titlePattern} escape '\\'`);
  const attemptCount = Number(attemptRow?.count ?? 0);
  if (attemptCount >= maxAttempts) {
    return { created: false, reason: `conflict_autofix_attempt_limit_reached:${attemptCount}/${maxAttempts}` };
  }

  const reasonLine = params.mergeDeferredReason
    ? `merge_reason: ${params.mergeDeferredReason}`
    : "merge_reason: unknown";
  const llmReasonLines = params.summary.llm.reasons.length > 0
    ? params.summary.llm.reasons.map((reason) => `- ${reason}`).join("\n")
    : "- (none)";
  const nextAttempt = attemptCount + 1;
  const prBranchContext = await getPrBranchContext(params.prNumber);

  const [taskRow] = await db
    .insert(tasks)
    .values({
      title: `${titlePrefix} (attempt ${nextAttempt}/${maxAttempts})`,
      goal:
        `Resolve merge conflicts for PR #${params.prNumber} and make it mergeable without human intervention. ` +
        `Original review task: ${params.sourceTaskId}.`,
      context: {
        files: [],
        specs:
          "Resolve base-branch conflicts for the target PR. Prefer updating the existing PR branch. " +
          "If not feasible, create a replacement PR that contains equivalent changes and references the original PR.",
        notes:
          `${reasonLine}\n` +
          "Judge/LLM reasons:\n" +
          `${llmReasonLines}\n` +
          "Do not run long-running dev/watch/start commands.",
        pr: {
          number: params.prNumber,
          url: params.prUrl,
          sourceTaskId: params.sourceTaskId,
          sourceRunId: params.sourceRunId,
          headRef: prBranchContext.headRef,
          headSha: prBranchContext.headSha,
          baseRef: prBranchContext.baseRef,
        },
      },
      allowedPaths: params.allowedPaths.length > 0 ? params.allowedPaths : ["**"],
      commands: params.commands,
      dependencies: [],
      priority: 90,
      riskLevel: "medium",
      role: "worker",
      status: "queued",
      timeboxMinutes: 60,
    })
    .returning({ id: tasks.id });

  if (!taskRow?.id) {
    return { created: false, reason: "conflict_autofix_task_insert_failed" };
  }

  await db.insert(events).values({
    type: "judge.conflict_autofix_task_created",
    entityType: "task",
    entityId: taskRow.id,
    agentId: params.agentId,
    payload: {
      prNumber: params.prNumber,
      sourceTaskId: params.sourceTaskId,
      sourceRunId: params.sourceRunId,
      sourceTaskTitle: params.sourceTaskTitle,
      sourceTaskGoal: params.sourceTaskGoal,
      attempt: nextAttempt,
      maxAttempts,
      mergeDeferredReason: params.mergeDeferredReason,
    },
  });

  return { created: true, taskId: taskRow.id, reason: "created" };
}

async function requeueTaskAfterJudge(params: {
  taskId: string;
  runId: string;
  agentId: string;
  reason: string;
}): Promise<void> {
  const { taskId, runId, agentId, reason } = params;

  const [task] = await db
    .select({ retryCount: tasks.retryCount })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const nextRetryCount = (task?.retryCount ?? 0) + 1;

  await db
    .update(tasks)
    .set({
      status: "queued",
      blockReason: null,
      retryCount: nextRetryCount,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  await db.insert(events).values({
    type: "judge.task_requeued",
    entityType: "task",
    entityId: taskId,
    agentId,
    payload: {
      runId,
      reason,
      retryCount: nextRetryCount,
    },
  });
}

async function getTaskRetryCount(taskId: string): Promise<number> {
  const [task] = await db
    .select({ retryCount: tasks.retryCount })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  return task?.retryCount ?? 0;
}

async function scheduleTaskForJudgeRetry(params: {
  taskId: string;
  runId: string;
  agentId: string;
  reason: string;
  restoreRunImmediately?: boolean;
}): Promise<void> {
  const { taskId, runId, agentId, reason, restoreRunImmediately = true } = params;
  const [task] = await db
    .select({ retryCount: tasks.retryCount })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  const nextRetryCount = (task?.retryCount ?? 0) + 1;

  await db
    .update(tasks)
    .set({
      status: "blocked",
      blockReason: "awaiting_judge",
      retryCount: nextRetryCount,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  if (restoreRunImmediately) {
    await db
      .update(runs)
      .set({
        judgedAt: null,
      })
      .where(eq(runs.id, runId));
  }

  await db.insert(events).values({
    type: "judge.task_requeued",
    entityType: "task",
    entityId: taskId,
    agentId,
    payload: {
      runId,
      reason,
      retryCount: nextRetryCount,
    },
  });
}

function isImportedPrReviewTask(goal: string, title: string): boolean {
  return (
    goal.startsWith("Review and process open PR #")
    || title.startsWith("[PR] Review #")
  );
}

async function recoverAwaitingJudgeBacklog(agentId: string): Promise<number> {
  const cooldownMs = Number.isFinite(JUDGE_AWAITING_RETRY_COOLDOWN_MS)
    && JUDGE_AWAITING_RETRY_COOLDOWN_MS > 0
    ? JUDGE_AWAITING_RETRY_COOLDOWN_MS
    : 120000;
  const cutoff = new Date(Date.now() - cooldownMs);

  const stuckTasks = await db
    .select({
      id: tasks.id,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "blocked"),
        eq(tasks.blockReason, "awaiting_judge"),
        lte(tasks.updatedAt, cutoff)
      )
    );

  if (stuckTasks.length === 0) {
    return 0;
  }

  let recovered = 0;
  for (const task of stuckTasks) {
    const [pendingRun] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.taskId, task.id),
          eq(runs.status, "success"),
          isNull(runs.judgedAt)
        )
      )
      .limit(1);

    if (pendingRun?.id) {
      continue;
    }

    const [recoverableRun] = await db
      .select({
        runId: runs.id,
      })
      .from(runs)
      .innerJoin(artifacts, eq(artifacts.runId, runs.id))
      .where(
        and(
          eq(runs.taskId, task.id),
          eq(runs.status, "success"),
          inArray(artifacts.type, ["pr", "worktree"])
        )
      )
      .orderBy(desc(runs.startedAt))
      .limit(1);

    if (!recoverableRun?.runId) {
      continue;
    }

    await db
      .update(runs)
      .set({
        judgedAt: null,
      })
      .where(eq(runs.id, recoverableRun.runId));

    await db.insert(events).values({
      type: "judge.task_recovered",
      entityType: "task",
      entityId: task.id,
      agentId,
      payload: {
        reason: "recover_awaiting_judge_run_restored",
        runId: recoverableRun.runId,
        cooldownMs,
      },
    });
    recovered += 1;
  }

  return recovered;
}

async function claimRunForJudgement(runId: string): Promise<boolean> {
  const result = await db
    .update(runs)
    .set({
      judgedAt: new Date(),
      judgementVersion: sql`${runs.judgementVersion} + 1`,
    })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, "success"),
        isNull(runs.judgedAt)
      )
    )
    .returning({ id: runs.id });

  return result.length > 0;
}

async function recoverDirtyBaseRepo(options: {
  baseRepoPath: string;
  baseBranch: string;
  runId: string;
  taskId: string;
  agentId: string;
  workdir: string;
  instructionsPath: string;
  useLlm: boolean;
  recoveryMode: "none" | "stash" | "llm";
  recoveryRules: BaseRepoRecoveryRules;
}): Promise<{ success: boolean; error?: string }> {
  if (options.recoveryMode === "none") {
    return { success: false, error: "base repo has uncommitted changes" };
  }

  const diffResult = await getWorkingTreeDiff(options.baseRepoPath);
  const fullDiff = diffResult.success ? diffResult.stdout : "";
  const untrackedFiles = await getUntrackedFiles(options.baseRepoPath);
  const dirtyFiles = await getChangedFiles(options.baseRepoPath);

  const diffTruncated = fullDiff.length > options.recoveryRules.diffLimit;
  const diffForRecord = diffTruncated
    ? `${fullDiff.slice(0, options.recoveryRules.diffLimit)}\n... (truncated)`
    : fullDiff;

  // Stash base changes to prevent merge process from stopping
  const stashMessage = `openTiger base repo auto stash ${new Date().toISOString()}`;
  const stashResult = await stashChanges(options.baseRepoPath, stashMessage);
  if (!stashResult.success) {
    return {
      success: false,
      error: `failed to stash changes: ${stashResult.stderr}`,
    };
  }

  const stashRef = await getLatestStashRef(options.baseRepoPath);

  try {
    await db.insert(artifacts).values({
      runId: options.runId,
      type: "base_repo_diff",
      ref: stashRef ?? null,
      metadata: {
        baseRepoPath: options.baseRepoPath,
        baseBranch: options.baseBranch,
        dirtyFiles,
        untrackedFiles,
        diff: diffForRecord,
        diffTruncated,
      },
    });
  } catch (error) {
    console.warn("[Judge] Failed to save base repo diff artifact:", error);
  }

  await db.insert(events).values({
    type: "judge.base_repo_stashed",
    entityType: "run",
    entityId: options.runId,
    agentId: options.agentId,
    payload: {
      taskId: options.taskId,
      baseRepoPath: options.baseRepoPath,
      baseBranch: options.baseBranch,
      stashRef,
      dirtyFiles,
      untrackedFiles,
      diffTruncated,
      recoveryLevel: options.recoveryRules.level,
    },
  });

  if (!options.useLlm || options.recoveryMode !== "llm") {
    return { success: true };
  }

  // stash した内容をLLMで判定して復帰の可否を決める
  const llmResult = await evaluateLLMDiff(
    fullDiff,
    "ローカルベースリポジトリの未コミット変更です。システム専用リポジトリに残すべきか判断してください。",
    {
      instructionsPath: options.instructionsPath,
      timeoutSeconds: 300,
    }
  );

  await db.insert(events).values({
    type: "judge.base_repo_recovery_decision",
    entityType: "run",
    entityId: options.runId,
    agentId: options.agentId,
    payload: {
      taskId: options.taskId,
      stashRef,
      pass: llmResult.pass,
      confidence: llmResult.confidence,
      reasons: llmResult.reasons,
      suggestions: llmResult.suggestions,
      recoveryLevel: options.recoveryRules.level,
    },
  });

  const hasError = llmResult.codeIssues.some((issue) => issue.severity === "error");
  const hasWarning = llmResult.codeIssues.some((issue) => issue.severity === "warning");
  const meetsConfidence = llmResult.confidence >= options.recoveryRules.minConfidence;
  const meetsErrors = !options.recoveryRules.requireNoErrors || !hasError;
  const meetsWarnings = !options.recoveryRules.requireNoWarnings || !hasWarning;
  const shouldRestore =
    llmResult.pass && meetsConfidence && meetsErrors && meetsWarnings;
  if (!shouldRestore || !stashRef) {
    return { success: true };
  }

  const applyResult = await applyStash(options.baseRepoPath, stashRef);
  if (!applyResult.success) {
    console.warn("[Judge] Failed to apply stash:", applyResult.stderr);
    await checkoutBranch(options.baseRepoPath, options.baseBranch);
    await resetHard(options.baseRepoPath, options.baseBranch);
    await cleanUntracked(options.baseRepoPath);
    return { success: true };
  }

  // Only commit if recovery is deemed valid to keep base clean
  const stageResult = await stageAll(options.baseRepoPath);
  if (!stageResult.success) {
    await checkoutBranch(options.baseRepoPath, options.baseBranch);
    await resetHard(options.baseRepoPath, options.baseBranch);
    await cleanUntracked(options.baseRepoPath);
    return {
      success: true,
      error: `failed to stage recovered changes: ${stageResult.stderr}`,
    };
  }

  const commitResult = await commitChanges(
    options.baseRepoPath,
    "chore: recover base repo changes"
  );
  if (!commitResult.success) {
    const combinedMessage = `${commitResult.stdout}\n${commitResult.stderr}`;
    if (!combinedMessage.includes("nothing to commit")) {
      await checkoutBranch(options.baseRepoPath, options.baseBranch);
      await resetHard(options.baseRepoPath, options.baseBranch);
      await cleanUntracked(options.baseRepoPath);
      return {
        success: true,
        error: `failed to commit recovered changes: ${commitResult.stderr}`,
      };
    }
  }

  const dropResult = await dropStash(options.baseRepoPath, stashRef);
  if (!dropResult.success) {
    console.warn("[Judge] Failed to drop stash:", dropResult.stderr);
  }

  return { success: true };
}

async function mergeLocalBranch(target: {
  baseRepoPath?: string;
  baseBranch: string;
  branchName: string;
  runId: string;
  taskId: string;
  agentId: string;
  workdir: string;
  instructionsPath: string;
  useLlm: boolean;
  recoveryMode: "none" | "stash" | "llm";
  recoveryRules: BaseRepoRecoveryRules;
}): Promise<{ success: boolean; error?: string }> {
  if (!target.baseRepoPath) {
    return { success: false, error: "baseRepoPath is missing" };
  }

  const dirtyFiles = await getChangedFiles(target.baseRepoPath);
  if (dirtyFiles.length > 0) {
    const mergeInProgress = await isMergeInProgress(target.baseRepoPath);
    if (mergeInProgress) {
      const abortResult = await abortMerge(target.baseRepoPath);
      if (!abortResult.success) {
        return {
          success: false,
          error: `failed to abort merge: ${abortResult.stderr}`,
        };
      }
    }

    const recoverResult = await recoverDirtyBaseRepo({
      baseRepoPath: target.baseRepoPath,
      baseBranch: target.baseBranch,
      runId: target.runId,
      taskId: target.taskId,
      agentId: target.agentId,
      workdir: target.workdir,
      instructionsPath: target.instructionsPath,
      useLlm: target.useLlm,
      recoveryMode: target.recoveryMode,
      recoveryRules: target.recoveryRules,
    });
    if (!recoverResult.success) {
      return {
        success: false,
        error: recoverResult.error ?? "base repo has uncommitted changes",
      };
    }

    const afterRecover = await getChangedFiles(target.baseRepoPath);
    if (afterRecover.length > 0) {
      // Clean untracked files from local working base before re-evaluating
      const cleanResult = await cleanUntracked(target.baseRepoPath);
      if (!cleanResult.success) {
        return {
          success: false,
          error: `failed to clean untracked files: ${cleanResult.stderr}`,
        };
      }
      const afterClean = await getChangedFiles(target.baseRepoPath);
      if (afterClean.length > 0) {
        return {
          success: false,
          error: "base repo has uncommitted changes",
        };
      }
    }
  }

  const checkoutResult = await checkoutBranch(
    target.baseRepoPath,
    target.baseBranch
  );
  if (!checkoutResult.success) {
    return {
      success: false,
      error: `failed to checkout base branch: ${checkoutResult.stderr}`,
    };
  }

  // まずはfast-forwardで安全に取り込み、失敗時はマージコミットを許可する
  const ffResult = await mergeBranch(
    target.baseRepoPath,
    target.branchName,
    { ffOnly: true }
  );
  if (!ffResult.success) {
    const mergeResult = await mergeBranch(
      target.baseRepoPath,
      target.branchName,
      { ffOnly: false, noEdit: true }
    );
    if (!mergeResult.success) {
      const abortResult = await abortMerge(target.baseRepoPath);
      if (!abortResult.success) {
        return {
          success: false,
          error: `failed to abort merge: ${abortResult.stderr}`,
        };
      }
      return {
        success: false,
        error: `failed to merge branch: ${mergeResult.stderr}`,
      };
    }
  }

  return { success: true };
}

// レビューループ
async function runJudgeLoop(config: JudgeConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("openTiger Judge started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`Use LLM: ${config.useLlm}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Merge on approve: ${config.mergeOnApprove}`);
  console.log(`Requeue on non-approve: ${config.requeueOnNonApprove}`);
  console.log(
    `Non-approve circuit breaker retries: ${
      Number.isFinite(JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES)
        ? Math.max(1, JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES)
        : 2
    }`
  );
  console.log("=".repeat(60));

  while (true) {
    try {
      const recoveredAwaiting = await recoverAwaitingJudgeBacklog(config.agentId);
      if (recoveredAwaiting > 0) {
        console.log(`[Judge] Recovered ${recoveredAwaiting} awaiting_judge task(s) by restoring runs`);
      }

      // レビュー待ちのPRを取得
      const pendingPRs = await getPendingPRs();

      if (pendingPRs.length > 0) {
        await safeSetJudgeAgentState(config.agentId, "busy");
        console.log(`\nFound ${pendingPRs.length} PRs to review`);

        for (const pr of pendingPRs) {
          try {
            await safeSetJudgeAgentState(config.agentId, "busy", pr.taskId);
            if (!config.dryRun) {
              const claimed = await claimRunForJudgement(pr.runId);
              if (!claimed) {
                console.log(`  Skip PR #${pr.prNumber}: run already judged`);
                await safeSetJudgeAgentState(config.agentId, "busy");
                continue;
              }
            }

            const { result, summary } = await judgeSinglePR(pr, config);
            const effectiveResult = config.mergeOnApprove
              ? result
              : { ...result, autoMerge: false };
            let actionResult: {
              commented: boolean;
              approved: boolean;
              merged: boolean;
              mergeDeferred?: boolean;
              mergeDeferredReason?: string;
            } = {
              commented: false,
              approved: false,
              merged: false,
            };

            let actionError: unknown;
            let requeueReason: string | undefined;
            const importedPrReviewTask = isImportedPrReviewTask(pr.taskGoal, pr.taskTitle);

            try {
              if (config.dryRun) {
                console.log("  [Dry run - no action taken]");
              } else {
                // レビューとアクションを実行
                actionResult = await reviewAndAct(pr.prNumber, effectiveResult, summary);
                console.log(
                  `  Actions: commented=${actionResult.commented}, approved=${actionResult.approved}, merged=${actionResult.merged}`
                );

                // If merged, task is complete
                if (actionResult.merged) {
                  await db
                    .update(tasks)
                    .set({
                      status: "done",
                      blockReason: null,
                      updatedAt: new Date(),
                    })
                    .where(eq(tasks.id, pr.taskId));
                  console.log(`  Task ${pr.taskId} marked as done`);

                  const docserResult = await createDocserTaskForPR({
                    mode: "git",
                    prNumber: pr.prNumber,
                    taskId: pr.taskId,
                    runId: pr.runId,
                    agentId: config.agentId,
                    workdir: config.workdir,
                  });
                  if (docserResult.created) {
                    console.log(`  Docser task created: ${docserResult.docserTaskId}`);
                  }
                } else if (effectiveResult.verdict !== "approve" && config.requeueOnNonApprove) {
                  // On LLM FAIL, create a fix task instead of entering Judge re-evaluation loop
                  if (!summary.llm.pass) {
                    if (hasActionableLLMFailures(summary)) {
                      const autoFix = await createAutoFixTaskForPr({
                        prNumber: pr.prNumber,
                        prUrl: pr.prUrl,
                        sourceTaskId: pr.taskId,
                        sourceRunId: pr.runId,
                        sourceTaskTitle: pr.taskTitle,
                        sourceTaskGoal: pr.taskGoal,
                        allowedPaths: pr.allowedPaths,
                        commands: pr.commands,
                        summary,
                        agentId: config.agentId,
                      });

                      if (autoFix.created) {
                        await db
                          .update(tasks)
                          .set({
                            status: "blocked",
                            blockReason: "needs_rework",
                            updatedAt: new Date(),
                          })
                          .where(eq(tasks.id, pr.taskId));
                        console.log(
                          `  Task ${pr.taskId} blocked as needs_rework; auto-fix task queued: ${autoFix.taskId}`
                        );
                      } else {
                        requeueReason = `${buildJudgeFailureMessage(effectiveResult)} | ${autoFix.reason}`;
                        if (importedPrReviewTask) {
                          await scheduleTaskForJudgeRetry({
                            taskId: pr.taskId,
                            runId: pr.runId,
                            agentId: config.agentId,
                            reason: `retry_imported_pr_review:${requeueReason}`,
                          });
                          console.log(
                            `  Task ${pr.taskId} scheduled for judge retry (${effectiveResult.verdict})`
                          );
                        } else {
                          await requeueTaskAfterJudge({
                            taskId: pr.taskId,
                            runId: pr.runId,
                            agentId: config.agentId,
                            reason: requeueReason,
                          });
                          console.log(
                            `  Task ${pr.taskId} requeued by judge verdict (${effectiveResult.verdict})`
                          );
                        }
                      }
                    } else {
                      const doomLoopThreshold = Number.isFinite(JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES)
                        ? Math.max(1, JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES)
                        : 2;
                      const isDoomLoop = isDoomLoopFailure(summary);
                      const currentRetryCount = await getTaskRetryCount(pr.taskId);
                      const shouldTripCircuitBreaker = isDoomLoop
                        && currentRetryCount >= doomLoopThreshold;

                      if (shouldTripCircuitBreaker) {
                        const autoFix = await createAutoFixTaskForPr({
                          prNumber: pr.prNumber,
                          prUrl: pr.prUrl,
                          sourceTaskId: pr.taskId,
                          sourceRunId: pr.runId,
                          sourceTaskTitle: pr.taskTitle,
                          sourceTaskGoal: pr.taskGoal,
                          allowedPaths: pr.allowedPaths,
                          commands: pr.commands,
                          summary,
                          agentId: config.agentId,
                        });

                        if (autoFix.created) {
                          await db
                            .update(tasks)
                            .set({
                              status: "blocked",
                              blockReason: "needs_rework",
                              updatedAt: new Date(),
                            })
                            .where(eq(tasks.id, pr.taskId));
                          console.log(
                            `  Task ${pr.taskId} hit doom-loop circuit breaker; auto-fix task queued: ${autoFix.taskId}`
                          );
                        } else {
                          requeueReason = `${buildJudgeFailureMessage(effectiveResult)} | doom_loop_circuit_breaker_failed:${autoFix.reason}`;
                          await scheduleTaskForJudgeRetry({
                            taskId: pr.taskId,
                            runId: pr.runId,
                            agentId: config.agentId,
                            reason: importedPrReviewTask
                              ? `retry_imported_pr_review:${requeueReason}`
                              : requeueReason,
                            restoreRunImmediately: false,
                          });
                          console.log(
                            `  Task ${pr.taskId} doom-loop breaker fallback to judge retry (${autoFix.reason})`
                          );
                        }
                      } else {
                        // LLM failures without code diffs (quota exceeded, execution errors) are re-evaluated after cooldown
                        requeueReason = `${buildJudgeFailureMessage(effectiveResult)} | llm_non_actionable_failure`;
                        await scheduleTaskForJudgeRetry({
                          taskId: pr.taskId,
                          runId: pr.runId,
                          agentId: config.agentId,
                          reason: importedPrReviewTask
                            ? `retry_imported_pr_review:${requeueReason}`
                            : requeueReason,
                          // Don't immediately re-evaluate the same run; Judge will restore the run after a short cooldown
                          restoreRunImmediately: false,
                        });
                        const marker = isNonActionableLLMFailure(summary)
                          ? "non-actionable"
                          : "llm-failed";
                        console.log(
                          `  Task ${pr.taskId} scheduled for judge retry after cooldown (${marker})`
                        );
                      }
                    }
                  } else {
                    // CI/Policy系の非approveは再キューし、閾値超過でAutoFixへ昇格
                    const retryThreshold = Number.isFinite(JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES)
                      ? Math.max(1, JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES)
                      : 2;
                    const currentRetryCount = await getTaskRetryCount(pr.taskId);
                    const shouldEscalate = currentRetryCount >= retryThreshold;

                    if (shouldEscalate) {
                      const autoFix = await createAutoFixTaskForPr({
                        prNumber: pr.prNumber,
                        prUrl: pr.prUrl,
                        sourceTaskId: pr.taskId,
                        sourceRunId: pr.runId,
                        sourceTaskTitle: pr.taskTitle,
                        sourceTaskGoal: pr.taskGoal,
                        allowedPaths: pr.allowedPaths,
                        commands: pr.commands,
                        summary,
                        agentId: config.agentId,
                      });

                      if (autoFix.created) {
                        await db
                          .update(tasks)
                          .set({
                            status: "blocked",
                            blockReason: "needs_rework",
                            updatedAt: new Date(),
                          })
                          .where(eq(tasks.id, pr.taskId));
                        console.log(
                          `  Task ${pr.taskId} hit non-approve circuit breaker; auto-fix task queued: ${autoFix.taskId}`
                        );
                      } else {
                        await db
                          .update(tasks)
                          .set({
                            status: "blocked",
                            blockReason: "needs_rework",
                            updatedAt: new Date(),
                          })
                          .where(eq(tasks.id, pr.taskId));
                        console.warn(
                          `  Task ${pr.taskId} blocked as needs_rework; non-approve circuit breaker fallback (${autoFix.reason})`
                        );
                      }
                    } else {
                      requeueReason = buildJudgeFailureMessage(effectiveResult);
                      if (importedPrReviewTask) {
                        await scheduleTaskForJudgeRetry({
                          taskId: pr.taskId,
                          runId: pr.runId,
                          agentId: config.agentId,
                          reason: `retry_imported_pr_review:${requeueReason}`,
                        });
                        console.log(
                          `  Task ${pr.taskId} scheduled for judge retry (${effectiveResult.verdict})`
                        );
                      } else {
                        await requeueTaskAfterJudge({
                          taskId: pr.taskId,
                          runId: pr.runId,
                          agentId: config.agentId,
                          reason: requeueReason,
                        });
                        console.log(
                          `  Task ${pr.taskId} requeued by judge verdict (${effectiveResult.verdict})`
                        );
                      }
                    }
                  }
                } else if (effectiveResult.verdict === "approve") {
                  // If approve but merge didn't complete, send conflict-related ones to AutoFix, others back to judge retry
                  let handledByConflictAutoFix = false;
                  const conflictSignals = hasMergeConflictSignals({
                    summary,
                    mergeDeferredReason: actionResult.mergeDeferredReason,
                  });
                  if (conflictSignals && !actionResult.mergeDeferred) {
                    const conflictAutoFix = await createConflictAutoFixTaskForPr({
                      prNumber: pr.prNumber,
                      prUrl: pr.prUrl,
                      sourceTaskId: pr.taskId,
                      sourceRunId: pr.runId,
                      sourceTaskTitle: pr.taskTitle,
                      sourceTaskGoal: pr.taskGoal,
                      allowedPaths: pr.allowedPaths,
                      commands: pr.commands,
                      summary,
                      agentId: config.agentId,
                      mergeDeferredReason: actionResult.mergeDeferredReason,
                    });

                    if (conflictAutoFix.created) {
                      await db
                        .update(tasks)
                        .set({
                          status: "blocked",
                          blockReason: "needs_rework",
                          updatedAt: new Date(),
                        })
                        .where(eq(tasks.id, pr.taskId));
                      console.warn(
                        `  Task ${pr.taskId} blocked as needs_rework; conflict auto-fix task queued: ${conflictAutoFix.taskId}`
                      );
                      handledByConflictAutoFix = true;
                    } else {
                      const fallbackReason =
                        `Judge approved but merge conflict auto-fix was not queued (${conflictAutoFix.reason})`;
                      await scheduleTaskForJudgeRetry({
                        taskId: pr.taskId,
                        runId: pr.runId,
                        agentId: config.agentId,
                        reason: fallbackReason,
                        restoreRunImmediately: false,
                      });
                      console.warn(
                        `  Task ${pr.taskId} scheduled for judge retry (conflict autofix fallback: ${conflictAutoFix.reason})`
                      );
                    }
                    // レビュー記録は継続して残す
                  }

                  if (!handledByConflictAutoFix) {
                    const retryReason = actionResult.mergeDeferred
                      ? `Judge approved but merge deferred: ${actionResult.mergeDeferredReason ?? "pending_branch_sync"}`
                      : `Judge approved but merge was not completed${actionResult.mergeDeferredReason ? ` (${actionResult.mergeDeferredReason})` : ""}`;
                    await scheduleTaskForJudgeRetry({
                      taskId: pr.taskId,
                      runId: pr.runId,
                      agentId: config.agentId,
                      reason: retryReason,
                      // If update-branch was triggered, don't re-evaluate the same run until cooldown
                      restoreRunImmediately: !actionResult.mergeDeferred,
                    });
                    console.warn(`  Task ${pr.taskId} scheduled for judge retry because merge did not complete`);
                  }
                } else {
                  await db
                    .update(tasks)
                    .set({
                      status: "blocked",
                      blockReason: "needs_rework",
                      updatedAt: new Date(),
                    })
                    .where(eq(tasks.id, pr.taskId));
                }
              }
            } catch (error) {
              actionError = error;
              if (!config.dryRun) {
                requeueReason = buildJudgeFailureMessage(effectiveResult, error);
                await scheduleTaskForJudgeRetry({
                  taskId: pr.taskId,
                  runId: pr.runId,
                  agentId: config.agentId,
                  reason: `judge_action_error:${requeueReason}`,
                });
                console.warn(`  Task ${pr.taskId} scheduled for judge retry due to judge action error`);
              }
            }

            await recordJudgeReview(
              pr,
              effectiveResult,
              summary,
              actionResult,
              config.agentId,
              config.dryRun
            );

            if (actionError) {
              throw actionError;
            }
          } catch (error) {
            console.error(`  Error processing PR #${pr.prNumber}:`, error);
          } finally {
            await safeSetJudgeAgentState(config.agentId, "busy");
          }
        }
      }
    } catch (error) {
      console.error("Judge loop error:", error);
    } finally {
      await safeSetJudgeAgentState(config.agentId, "idle");
    }

    // 次のポーリングまで待機
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

async function runLocalJudgeLoop(config: JudgeConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("openTiger Judge (local mode) started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`Use LLM: ${config.useLlm}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Requeue on non-approve: ${config.requeueOnNonApprove}`);
  console.log("=".repeat(60));

  while (true) {
    try {
      const recoveryRules = resolveBaseRepoRecoveryRules(config.policy, config);
      const pendingWorktrees = await getPendingWorktrees();

      if (pendingWorktrees.length > 0) {
        await safeSetJudgeAgentState(config.agentId, "busy");
        console.log(`\nFound ${pendingWorktrees.length} worktrees to review`);

        for (const target of pendingWorktrees) {
          try {
            await safeSetJudgeAgentState(config.agentId, "busy", target.taskId);
            if (!config.dryRun) {
              const claimed = await claimRunForJudgement(target.runId);
              if (!claimed) {
                console.log(`  Skip worktree ${target.worktreePath}: run already judged`);
                await safeSetJudgeAgentState(config.agentId, "busy");
                continue;
              }
            }

            const { result, summary, diffFiles } = await judgeSingleWorktree(
              target,
              config
            );
            let mergeResult: { success: boolean; error?: string } | undefined;

            if (!config.dryRun) {
              let nextStatus: "done" | "queued" | "blocked";
              let requeueReason: string | undefined;
              let nextBlockReason: "needs_rework" | null = null;
              if (result.verdict === "approve") {
                mergeResult = await mergeLocalBranch({
                  baseRepoPath: target.baseRepoPath,
                  baseBranch: target.baseBranch,
                  branchName: target.branchName,
                  runId: target.runId,
                  taskId: target.taskId,
                  agentId: config.agentId,
                  workdir: config.workdir,
                  instructionsPath: config.instructionsPath,
                  useLlm: config.useLlm,
                  recoveryMode: config.baseRepoRecoveryMode,
                  recoveryRules,
                });
                nextStatus = mergeResult.success ? "done" : "queued";
                if (!mergeResult.success) {
                  console.error(
                    "[Judge] Failed to merge local branch:",
                    mergeResult.error
                  );
                  requeueReason = buildJudgeFailureMessage(result, mergeResult.error);
                }
                // Log local merge success/failure to facilitate tracking of evaluation results
                console.log(
                  `[Judge] Local merge result: ${mergeResult.success ? "success" : "failed"}`
                );

                if (mergeResult.success) {
                  const docserResult = await createDocserTaskForLocal({
                    mode: "local",
                    worktreePath: target.worktreePath,
                    baseBranch: target.baseBranch,
                    branchName: target.branchName,
                    baseRepoPath: target.baseRepoPath,
                    taskId: target.taskId,
                    runId: target.runId,
                    agentId: config.agentId,
                    workdir: config.workdir,
                    diffFiles,
                  });
                  if (docserResult.created) {
                    console.log(`  Docser task created: ${docserResult.docserTaskId}`);
                  } else if (docserResult.reason) {
                    console.log(`  Docser task skipped: ${docserResult.reason}`);
                  }
                }
              } else {
                nextStatus = config.requeueOnNonApprove ? "queued" : "blocked";
                if (config.requeueOnNonApprove) {
                  requeueReason = buildJudgeFailureMessage(result);
                } else {
                  nextBlockReason = "needs_rework";
                }
              }
              await db
                .update(tasks)
                .set({
                  status: nextStatus,
                  blockReason: nextStatus === "blocked" ? nextBlockReason : null,
                  updatedAt: new Date(),
                })
                .where(eq(tasks.id, target.taskId));

              if (requeueReason) {
                await requeueTaskAfterJudge({
                  taskId: target.taskId,
                  runId: target.runId,
                  agentId: config.agentId,
                  reason: requeueReason,
                });
                console.log(`  Task ${target.taskId} requeued in local judge loop`);
              }
            }

            await recordLocalReview(
              {
                taskId: target.taskId,
                runId: target.runId,
                worktreePath: target.worktreePath,
                baseBranch: target.baseBranch,
                branchName: target.branchName,
                baseRepoPath: target.baseRepoPath,
              },
              result,
              summary,
              config.agentId,
              config.dryRun,
              mergeResult
            );
          } catch (error) {
            console.error(`  Error processing worktree ${target.worktreePath}:`, error);
          } finally {
            await safeSetJudgeAgentState(config.agentId, "busy");
          }
        }
      }
    } catch (error) {
      console.error("Judge loop error:", error);
    } finally {
      await safeSetJudgeAgentState(config.agentId, "idle");
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

// 単一PRをレビュー（CLIモード）
async function reviewSinglePR(
  prNumber: number,
  config: JudgeConfig
): Promise<void> {
  console.log("=".repeat(60));
  console.log(`openTiger Judge - Reviewing PR #${prNumber}`);
  console.log("=".repeat(60));

  // CI評価
  console.log("\n[1/3] Checking CI status...");
  const ciResult = await evaluateCI(prNumber);
  console.log(`CI Status: ${ciResult.status}`);
  for (const check of ciResult.details) {
    console.log(`  - ${check.name}: ${check.status}`);
  }

  // ポリシー評価
  console.log("\n[2/3] Checking policy compliance...");
  const diffStats = await getPRDiffStats(prNumber);
  const policyResult = await evaluatePolicy(prNumber, config.policy, []);
  console.log(`Policy: ${policyResult.pass ? "PASS" : "FAIL"}`);
  for (const v of policyResult.violations) {
    console.log(`  - ${v.severity}: ${v.message}`);
  }

  // 計算されたリスクレベル
  const computedRisk = evaluateRiskLevel(diffStats, config.policy);
  console.log(`Computed Risk: ${computedRisk}`);

  // LLM評価
  let llmResult;
  if (config.useLlm) {
    console.log("\n[3/3] Running LLM code review...");
    llmResult = await evaluateLLM(prNumber, {
      taskGoal: "Review this PR",
      instructionsPath: config.instructionsPath,
    });
    console.log(
      `LLM Review: ${llmResult.pass ? "PASS" : "FAIL"} (confidence: ${Math.round(llmResult.confidence * 100)}%)`
    );
    for (const issue of llmResult.codeIssues) {
      console.log(`  - ${issue.severity}: ${issue.message}`);
    }
  } else {
    llmResult = evaluateSimple();
    console.log("\n[3/3] LLM review skipped");
  }

  const summary: EvaluationSummary = {
    ci: ciResult,
    policy: policyResult,
    llm: llmResult,
  };

  // 判定（計算されたリスクを採用）
  const result = makeJudgement(summary, config.policy, computedRisk);

  console.log("\n" + "=".repeat(60));
  console.log(`VERDICT: ${result.verdict.toUpperCase()}`);
  if (result.reasons.length > 0) {
    console.log("Reasons:");
    for (const reason of result.reasons) {
      console.log(`  - ${reason}`);
    }
  }
  if (result.suggestions.length > 0) {
    console.log("Suggestions:");
    for (const suggestion of result.suggestions) {
      console.log(`  - ${suggestion}`);
    }
  }
  console.log(`Auto-merge: ${result.autoMerge ? "YES" : "NO"}`);
  console.log("=".repeat(60));

  if (!config.dryRun) {
    console.log("\nPosting review comment...");
    await reviewAndAct(prNumber, result, summary);
    console.log("Done!");
  } else {
    console.log("\n[Dry run - no action taken]");
  }
}

// ヘルプを表示
function showHelp(): void {
  console.log(`
openTiger Judge - Automated PR review and merge

Usage:
  pnpm --filter @openTiger/judge start              # Start polling mode
  pnpm --filter @openTiger/judge start <PR#>        # Review single PR
  pnpm --filter @openTiger/judge start --help       # Show this help

Options:
  --help          Show this help message
  --dry-run       Evaluate but don't post comments or merge
  --no-llm        Skip LLM code review

Environment Variables:
  POLL_INTERVAL_MS=30000   Polling interval
  USE_LLM=false            Disable LLM review
  DRY_RUN=true             Enable dry run mode
  GITHUB_TOKEN=xxx         GitHub API token
  JUDGE_MODEL=xxx          Judge LLM model
  JUDGE_MODE=git|local|auto Judge execution mode
  JUDGE_LOCAL_BASE_REPO_RECOVERY=llm|stash|none Recovery strategy for local base repo
  JUDGE_LOCAL_BASE_REPO_RECOVERY_CONFIDENCE=0.7 LLM confidence threshold
  JUDGE_LOCAL_BASE_REPO_RECOVERY_DIFF_LIMIT=20000 Diff size limit for DB storage
  JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES=2 Retry threshold before non-approve escalation

Example:
  pnpm --filter @openTiger/judge start 42
`);
}

// メイン処理
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ヘルプ
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  const agentId = process.env.AGENT_ID ?? "judge-1";

  // 設定を構築
  const config = {
    ...DEFAULT_CONFIG,
    agentId,
    policy: await loadPolicyConfig(),
  };
  config.policy = applyRepoModePolicyOverrides(config.policy);
  config.baseRepoRecoveryMode = resolveBaseRepoRecoveryMode();
  config.baseRepoRecoveryConfidence = resolveBaseRepoRecoveryConfidence();
  config.baseRepoRecoveryDiffLimit = resolveBaseRepoRecoveryDiffLimit();

  if (args.includes("--dry-run")) {
    config.dryRun = true;
  }

  if (args.includes("--no-llm")) {
    config.useLlm = false;
  }

  // エージェント登録
  setupProcessLogging(agentId);
  const judgeModel = process.env.JUDGE_MODEL ?? "google/gemini-3-pro-preview";
  await db.delete(agents).where(eq(agents.id, agentId));

  await db.insert(agents).values({
    id: agentId,
    role: "judge",
    status: "idle",
    lastHeartbeat: new Date(),
    metadata: {
      model: judgeModel, // Judgeは高精度モデルでレビュー品質を優先する
      provider: "gemini",
    },
  }).onConflictDoUpdate({
    target: agents.id,
    set: {
      status: "idle",
      lastHeartbeat: new Date(),
    },
  });

  // ハートビート開始
  const heartbeatTimer = startHeartbeat(agentId);

  // Single review if PR number is specified
  const prArg = args.find((arg) => /^\d+$/.test(arg));
  if (prArg) {
    const prNumber = parseInt(prArg, 10);
    await reviewSinglePR(prNumber, config);
    process.exit(0);
  }

  // ポーリングモード
  const repoMode = getRepoMode();
  const judgeMode = process.env.JUDGE_MODE;
  const effectiveMode =
    judgeMode === "git" || judgeMode === "local"
      ? judgeMode
      : repoMode === "local"
        ? "local"
        : "git";

  if (effectiveMode === "local") {
    await runLocalJudgeLoop({ ...config, mode: "local" });
  } else {
    await runJudgeLoop({ ...config, mode: "git" });
  }
}

main().catch((error) => {
  console.error("Judge crashed:", error);
  process.exit(1);
});
