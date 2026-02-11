import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { db } from "@openTiger/db";
import { agents } from "@openTiger/db/schema";
import { eq } from "drizzle-orm";
import {
  DEFAULT_POLICY,
  PolicySchema,
  type Policy,
  getRepoMode,
  applyRepoModePolicyOverrides,
} from "@openTiger/core";
import { setupProcessLogging } from "@openTiger/core/process-logging";
import "dotenv/config";

import {
  evaluateCI,
  evaluatePolicy,
  evaluateLLM,
  evaluateSimple,
  evaluateRiskLevel,
  getPRDiffStats,
} from "./evaluators/index";

import { makeJudgement, reviewAndAct, type EvaluationSummary } from "./pr-reviewer";
import {
  DEFAULT_CONFIG,
  resolveBaseRepoRecoveryMode,
  resolveBaseRepoRecoveryConfidence,
  resolveBaseRepoRecoveryDiffLimit,
  type JudgeConfig,
} from "./judge-config";
import { startHeartbeat } from "./judge-agent";
import { runJudgeLoop } from "./judge-loops";
import { runLocalJudgeLoop } from "./judge-local-loop";

async function loadPolicyConfig(): Promise<Policy> {
  const policyPath =
    process.env.POLICY_PATH ??
    resolve(import.meta.dirname, "../../../packages/policies/default/policy.json");

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

// Review single PR (CLI mode)
async function reviewSinglePR(prNumber: number, config: JudgeConfig): Promise<void> {
  console.log("=".repeat(60));
  console.log(`openTiger Judge - Reviewing PR #${prNumber}`);
  console.log("=".repeat(60));

  // CI evaluation
  console.log("\n[1/3] Checking CI status...");
  const ciResult = await evaluateCI(prNumber);
  console.log(`CI Status: ${ciResult.status}`);
  for (const check of ciResult.details) {
    console.log(`  - ${check.name}: ${check.status}`);
  }

  // Policy evaluation
  console.log("\n[2/3] Checking policy compliance...");
  const diffStats = await getPRDiffStats(prNumber);
  const policyResult = await evaluatePolicy(prNumber, config.policy, []);
  console.log(`Policy: ${policyResult.pass ? "PASS" : "FAIL"}`);
  for (const v of policyResult.violations) {
    console.log(`  - ${v.severity}: ${v.message}`);
  }

  // Computed risk level
  const computedRisk = evaluateRiskLevel(diffStats, config.policy);
  console.log(`Computed Risk: ${computedRisk}`);

  // LLM evaluation
  let llmResult;
  if (config.useLlm) {
    console.log("\n[3/3] Running LLM code review...");
    llmResult = await evaluateLLM(prNumber, {
      taskGoal: "Review this PR",
      instructionsPath: config.instructionsPath,
    });
    console.log(
      `LLM Review: ${llmResult.pass ? "PASS" : "FAIL"} (confidence: ${Math.round(llmResult.confidence * 100)}%)`,
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

  // Verdict (use computed risk)
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

// Show help
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
  GITHUB_AUTH_MODE=gh|token GitHub auth mode (default: gh)
  GITHUB_TOKEN=xxx         GitHub API token (required when mode=token)
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

// Main entry
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Help
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  const agentId = process.env.AGENT_ID ?? "judge-1";

  // Build config
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

  // Register agent
  setupProcessLogging(agentId, { label: "Judge" });
  const judgeModel = process.env.JUDGE_MODEL ?? "google/gemini-3-pro-preview";
  await db.delete(agents).where(eq(agents.id, agentId));

  await db
    .insert(agents)
    .values({
      id: agentId,
      role: "judge",
      status: "idle",
      lastHeartbeat: new Date(),
      metadata: {
        model: judgeModel, // Judge prefers high-quality model for reviews
        provider: "gemini",
      },
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        status: "idle",
        lastHeartbeat: new Date(),
      },
    });

  // Start heartbeat
  startHeartbeat(agentId);

  // Single review if PR number is specified
  const prArg = args.find((arg) => /^\d+$/.test(arg));
  if (prArg) {
    const prNumber = parseInt(prArg, 10);
    await reviewSinglePR(prNumber, config);
    process.exit(0);
  }

  // Polling mode
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
