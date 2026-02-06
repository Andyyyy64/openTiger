import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { db } from "@sebastian-code/db";
import { artifacts, runs, tasks, agents, events } from "@sebastian-code/db/schema";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  DEFAULT_POLICY,
  PolicySchema,
  type Policy,
  getRepoMode,
  getLocalRepoPath,
  applyRepoModePolicyOverrides,
} from "@sebastian-code/core";
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
} from "@sebastian-code/vcs";

import {
  makeJudgement,
  reviewAndAct,
  type EvaluationSummary,
  type JudgeResult,
} from "./pr-reviewer.js";
import { createDocserTaskForLocal, createDocserTaskForPR } from "./docser.js";

function setupProcessLogging(logName: string): string | undefined {
  const logDir = process.env.SEBASTIAN_LOG_DIR ?? "/tmp/sebastian-code-logs";

  try {
    mkdirSync(logDir, { recursive: true });
  } catch (error) {
    console.error(`[Logger] Failed to create log dir: ${logDir}`, error);
    return;
  }

  const logPath = join(logDir, `${logName}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });

  // ターミナルが流れても追跡できるようにログをファイルに残す
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
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
  }>
> {
  // 成功したrunでPRが作成されているものを取得
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

  // タスク情報を取得
  const pendingPRs: Array<{
    prNumber: number;
    prUrl: string;
    taskId: string;
    runId: string;
    startedAt: Date;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
  }> = [];
  const seenTaskIds = new Set<string>();

  for (const row of result) {
    if (!row.prNumber) continue;
    if (seenTaskIds.has(row.taskId)) continue;

    const prNumber = parseInt(row.prNumber, 10);
    if (isNaN(prNumber)) continue;

    // タスク情報を取得
    const taskResult = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, row.taskId));

    const task = taskResult[0];
    if (!task) continue;

    // Judge待ち（blocked）以外はレビュー対象にしない
    if (task.status !== "blocked") continue;

    pendingPRs.push({
      prNumber,
      prUrl: row.prUrl ?? "",
      taskId: row.taskId,
      runId: row.runId,
      startedAt: row.startedAt,
      taskGoal: task.goal,
      taskRiskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
      allowedPaths: task.allowedPaths ?? [],
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
    // Judge待ち（blocked）以外はレビュー対象にしない
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
    console.log("  - Running LLM code review...");
    llmResult = await evaluateLLM(pr.prNumber, {
      taskGoal: pr.taskGoal,
      workdir: config.workdir,
      instructionsPath: config.instructionsPath,
    });
    console.log(
      `    LLM: ${llmResult.pass ? "PASS" : "FAIL"} (confidence: ${Math.round(llmResult.confidence * 100)}%)`
    );
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
      workdir: config.workdir,
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

async function blockTaskNeedsHumanAfterJudge(params: {
  taskId: string;
  runId: string;
  agentId: string;
  reason: string;
}): Promise<void> {
  const { taskId, runId, agentId, reason } = params;

  await db
    .update(tasks)
    .set({
      status: "blocked",
      blockReason: "needs_human",
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  await db.insert(events).values({
    type: "judge.task_blocked",
    entityType: "task",
    entityId: taskId,
    agentId,
    payload: {
      runId,
      blockReason: "needs_human",
      reason,
    },
  });
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

  // ベースの変更を退避してマージ処理を止めない
  const stashMessage = `sebastian-code base repo auto stash ${new Date().toISOString()}`;
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
      workdir: options.workdir,
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

  // 復帰が妥当と判断された場合のみコミットしてベースをクリーンに保つ
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
      // ローカル作業用のベースは未追跡ファイルを掃除してから再判定する
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
  console.log("sebastian-code Judge started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`Use LLM: ${config.useLlm}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Merge on approve: ${config.mergeOnApprove}`);
  console.log(`Requeue on non-approve: ${config.requeueOnNonApprove}`);
  console.log("=".repeat(60));

  while (true) {
    try {
      // レビュー待ちのPRを取得
      const pendingPRs = await getPendingPRs();

      if (pendingPRs.length > 0) {
        console.log(`\nFound ${pendingPRs.length} PRs to review`);

        for (const pr of pendingPRs) {
          try {
            if (!config.dryRun) {
              const claimed = await claimRunForJudgement(pr.runId);
              if (!claimed) {
                console.log(`  Skip PR #${pr.prNumber}: run already judged`);
                continue;
              }
            }

            const { result, summary } = await judgeSinglePR(pr, config);
            const effectiveResult = config.mergeOnApprove
              ? result
              : { ...result, autoMerge: false };
            let actionResult = {
              commented: false,
              approved: false,
              merged: false,
            };

            let actionError: unknown;
            let requeueReason: string | undefined;

            try {
              if (config.dryRun) {
                console.log("  [Dry run - no action taken]");
              } else {
                // レビューとアクションを実行
                actionResult = await reviewAndAct(pr.prNumber, effectiveResult, summary);
                console.log(
                  `  Actions: commented=${actionResult.commented}, approved=${actionResult.approved}, merged=${actionResult.merged}`
                );

                // マージ済みならタスク完了
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
                  // request_changes / needs_human は再実行キューへ戻す
                  requeueReason = buildJudgeFailureMessage(effectiveResult);
                  await requeueTaskAfterJudge({
                    taskId: pr.taskId,
                    runId: pr.runId,
                    agentId: config.agentId,
                    reason: requeueReason,
                  });
                  console.log(`  Task ${pr.taskId} requeued by judge verdict (${effectiveResult.verdict})`);
                } else if (effectiveResult.verdict === "approve") {
                  // approve でもマージ完了しなければ同一task再実行は行わず、人手対応へ退避する
                  const blockReason = "Judge approved but merge was not completed";
                  await blockTaskNeedsHumanAfterJudge({
                    taskId: pr.taskId,
                    runId: pr.runId,
                    agentId: config.agentId,
                    reason: blockReason,
                  });
                  console.warn(`  Task ${pr.taskId} moved to needs_human because merge did not complete`);
                } else {
                  await db
                    .update(tasks)
                    .set({
                      status: "blocked",
                      blockReason:
                        effectiveResult.verdict === "needs_human"
                          ? "needs_human"
                          : "needs_rework",
                      updatedAt: new Date(),
                    })
                    .where(eq(tasks.id, pr.taskId));
                }
              }
            } catch (error) {
              actionError = error;
              if (!config.dryRun) {
                requeueReason = buildJudgeFailureMessage(effectiveResult, error);
                await requeueTaskAfterJudge({
                  taskId: pr.taskId,
                  runId: pr.runId,
                  agentId: config.agentId,
                  reason: requeueReason,
                });
                console.warn(`  Task ${pr.taskId} requeued due to judge action error`);
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
          }
        }
      }
    } catch (error) {
      console.error("Judge loop error:", error);
    }

    // 次のポーリングまで待機
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

async function runLocalJudgeLoop(config: JudgeConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("sebastian-code Judge (local mode) started");
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
        console.log(`\nFound ${pendingWorktrees.length} worktrees to review`);

        for (const target of pendingWorktrees) {
          try {
            if (!config.dryRun) {
              const claimed = await claimRunForJudgement(target.runId);
              if (!claimed) {
                console.log(`  Skip worktree ${target.worktreePath}: run already judged`);
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
              let nextBlockReason: "needs_rework" | "needs_human" | null = null;
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
                // ローカルマージの成否をログに残して判定結果の追跡を容易にする
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
                  nextBlockReason =
                    result.verdict === "needs_human"
                      ? "needs_human"
                      : "needs_rework";
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
          }
        }
      }
    } catch (error) {
      console.error("Judge loop error:", error);
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
  console.log(`sebastian-code Judge - Reviewing PR #${prNumber}`);
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
      workdir: config.workdir,
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
sebastian-code Judge - Automated PR review and merge

Usage:
  pnpm --filter @sebastian-code/judge start              # Start polling mode
  pnpm --filter @sebastian-code/judge start <PR#>        # Review single PR
  pnpm --filter @sebastian-code/judge start --help       # Show this help

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

Example:
  pnpm --filter @sebastian-code/judge start 42
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

  // PR番号が指定されている場合は単一レビュー
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
