import { resolve } from "node:path";

// PlannerのLLMはプロンプト内の情報だけで判断できるためツールを無効化する
export const PLANNER_OPENCODE_CONFIG_PATH = resolve(
  import.meta.dirname,
  "../opencode.planner.json"
);

function resolvePlannerQuotaWaits(): string {
  const fromPlannerEnv = process.env.PLANNER_OPENCODE_MAX_QUOTA_WAITS?.trim();
  if (fromPlannerEnv && /^-?\d+$/.test(fromPlannerEnv)) {
    return fromPlannerEnv;
  }

  // Plannerはクォータ待機で長時間停止しないよう、既定では即返す
  return "0";
}

export function getPlannerOpenCodeEnv(
  extraEnv: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {
    OPENCODE_CONFIG: PLANNER_OPENCODE_CONFIG_PATH,
    OPENCODE_MAX_QUOTA_WAITS: resolvePlannerQuotaWaits(),
  };

  const plannerWaitOnQuota = process.env.PLANNER_OPENCODE_WAIT_ON_QUOTA?.trim();
  if (plannerWaitOnQuota) {
    env.OPENCODE_WAIT_ON_QUOTA = plannerWaitOnQuota;
  }

  const plannerQuotaRetryDelay = process.env.PLANNER_OPENCODE_QUOTA_RETRY_DELAY_MS?.trim();
  if (plannerQuotaRetryDelay && /^\d+$/.test(plannerQuotaRetryDelay)) {
    env.OPENCODE_QUOTA_RETRY_DELAY_MS = plannerQuotaRetryDelay;
  }

  return { ...env, ...extraEnv };
}
