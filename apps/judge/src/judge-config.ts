import { resolve } from "node:path";
import { DEFAULT_POLICY, type Policy } from "@openTiger/core";

export interface JudgeConfig {
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

export const DEFAULT_CONFIG: JudgeConfig = {
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

export const JUDGE_AUTO_FIX_ON_FAIL = process.env.JUDGE_AUTO_FIX_ON_FAIL !== "false";

function resolveJudgeAutoFixMaxAttempts(): number {
  const parsed = Number.parseInt(
    process.env.JUDGE_AUTO_FIX_MAX_ATTEMPTS ?? "-1",
    10
  );
  if (!Number.isFinite(parsed)) {
    return -1;
  }
  if (parsed < 0) {
    return -1;
  }
  return Math.max(1, parsed);
}

export function isJudgeAutoFixUnlimited(): boolean {
  return JUDGE_AUTO_FIX_MAX_ATTEMPTS < 0;
}

export function formatJudgeAutoFixLimit(maxAttempts: number): string {
  return maxAttempts < 0 ? "inf" : String(maxAttempts);
}

export const JUDGE_AUTO_FIX_MAX_ATTEMPTS = resolveJudgeAutoFixMaxAttempts();
export const JUDGE_AWAITING_RETRY_COOLDOWN_MS = Number.parseInt(
  process.env.JUDGE_AWAITING_RETRY_COOLDOWN_MS ?? "120000",
  10
);
export const JUDGE_PR_MERGEABLE_PRECHECK_RETRIES = Number.parseInt(
  process.env.JUDGE_PR_MERGEABLE_PRECHECK_RETRIES ?? "3",
  10
);
export const JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS = Number.parseInt(
  process.env.JUDGE_PR_MERGEABLE_PRECHECK_DELAY_MS ?? "1000",
  10
);
export const JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES = Number.parseInt(
  process.env.JUDGE_DOOM_LOOP_CIRCUIT_BREAKER_RETRIES ?? "2",
  10
);
export const JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES = Number.parseInt(
  process.env.JUDGE_NON_APPROVE_CIRCUIT_BREAKER_RETRIES ?? "2",
  10
);

const BASE_REPO_RECOVERY_MODES = ["none", "stash", "llm"] as const;

export function resolveBaseRepoRecoveryMode(): "none" | "stash" | "llm" {
  const value = process.env.JUDGE_LOCAL_BASE_REPO_RECOVERY;
  return BASE_REPO_RECOVERY_MODES.includes(
    value as (typeof BASE_REPO_RECOVERY_MODES)[number]
  )
    ? (value as (typeof BASE_REPO_RECOVERY_MODES)[number])
    : "llm";
}

export function resolveBaseRepoRecoveryConfidence(): number {
  const value = parseFloat(process.env.JUDGE_LOCAL_BASE_REPO_RECOVERY_CONFIDENCE ?? "");
  if (Number.isFinite(value)) {
    return Math.min(Math.max(value, 0), 1);
  }
  return 0.7;
}

export function resolveBaseRepoRecoveryDiffLimit(): number {
  const value = parseInt(process.env.JUDGE_LOCAL_BASE_REPO_RECOVERY_DIFF_LIMIT ?? "", 10);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return 20000;
}

type BaseRepoRecoveryLevel = "low" | "medium" | "high";

export interface BaseRepoRecoveryRules {
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
  return policy.baseRepoRecovery?.level ?? "medium";
}

export function resolveBaseRepoRecoveryRules(
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
