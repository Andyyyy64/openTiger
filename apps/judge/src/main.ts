import { createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { db } from "@h1ve/db";
import { artifacts, runs, tasks, agents, events } from "@h1ve/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { DEFAULT_POLICY, PolicySchema, type Policy } from "@h1ve/core";
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
  evaluateSimple,
  evaluateRiskLevel,
  getPRDiffStats,
} from "./evaluators/index.js";

import {
  makeJudgement,
  reviewAndAct,
  type EvaluationSummary,
  type JudgeResult,
} from "./pr-reviewer.js";

function setupProcessLogging(logName: string): string | undefined {
  const logDir = process.env.H1VE_LOG_DIR ?? "/tmp/h1ve-logs";

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
  policy: Policy;
}

// デフォルト設定
const DEFAULT_CONFIG: JudgeConfig = {
  agentId: process.env.AGENT_ID ?? "judge-1",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? "30000", 10),
  workdir: process.cwd(),
  instructionsPath: resolve(import.meta.dirname, "../instructions/review.md"),
  useLlm: process.env.USE_LLM !== "false",
  dryRun: process.env.DRY_RUN === "true",
  policy: DEFAULT_POLICY,
};

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
    })
    .from(artifacts)
    .innerJoin(runs, eq(artifacts.runId, runs.id))
    .where(
      and(
        eq(artifacts.type, "pr"),
        eq(runs.status, "success"),
        isNotNull(artifacts.ref)
      )
    );

  // タスク情報を取得
  const pendingPRs: Array<{
    prNumber: number;
    prUrl: string;
    taskId: string;
    runId: string;
    taskGoal: string;
    taskRiskLevel: "low" | "medium" | "high";
    allowedPaths: string[];
  }> = [];

  for (const row of result) {
    if (!row.prNumber) continue;

    const prNumber = parseInt(row.prNumber, 10);
    if (isNaN(prNumber)) continue;

    // タスク情報を取得
    const taskResult = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, row.taskId));

    const task = taskResult[0];
    if (!task) continue;

    // すでに完了しているタスクはスキップ
    if (task.status === "done") continue;

    pendingPRs.push({
      prNumber,
      prUrl: row.prUrl ?? "",
      taskId: row.taskId,
      runId: row.runId,
      taskGoal: task.goal,
      taskRiskLevel: (task.riskLevel as "low" | "medium" | "high") ?? "low",
      allowedPaths: task.allowedPaths ?? [],
    });
  }

  return pendingPRs;
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

// レビューループ
async function runJudgeLoop(config: JudgeConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log("h1ve Judge started");
  console.log("=".repeat(60));
  console.log(`Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`Use LLM: ${config.useLlm}`);
  console.log(`Dry run: ${config.dryRun}`);
  console.log("=".repeat(60));

  while (true) {
    try {
      // レビュー待ちのPRを取得
      const pendingPRs = await getPendingPRs();

      if (pendingPRs.length > 0) {
        console.log(`\nFound ${pendingPRs.length} PRs to review`);

        for (const pr of pendingPRs) {
          try {
            const { result, summary } = await judgeSinglePR(pr, config);
            let actionResult = {
              commented: false,
              approved: false,
              merged: false,
            };

            let actionError: unknown;

            try {
              if (config.dryRun) {
                console.log("  [Dry run - no action taken]");
              } else {
                // レビューとアクションを実行
                actionResult = await reviewAndAct(pr.prNumber, result, summary);
                console.log(
                  `  Actions: commented=${actionResult.commented}, approved=${actionResult.approved}, merged=${actionResult.merged}`
                );

                // 自動マージされた場合、タスクを完了に更新
                if (actionResult.merged) {
                  await db
                    .update(tasks)
                    .set({
                      status: "done",
                      updatedAt: new Date(),
                    })
                    .where(eq(tasks.id, pr.taskId));
                  console.log(`  Task ${pr.taskId} marked as done`);
                }
              }
            } catch (error) {
              actionError = error;
            }

            await recordJudgeReview(
              pr,
              result,
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

// 単一PRをレビュー（CLIモード）
async function reviewSinglePR(
  prNumber: number,
  config: JudgeConfig
): Promise<void> {
  console.log("=".repeat(60));
  console.log(`h1ve Judge - Reviewing PR #${prNumber}`);
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
h1ve Judge - Automated PR review and merge

Usage:
  pnpm --filter @h1ve/judge start              # Start polling mode
  pnpm --filter @h1ve/judge start <PR#>        # Review single PR
  pnpm --filter @h1ve/judge start --help       # Show this help

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

Example:
  pnpm --filter @h1ve/judge start 42
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
  await runJudgeLoop(config);
}

main().catch((error) => {
  console.error("Judge crashed:", error);
  process.exit(1);
});
