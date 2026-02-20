function resolvePlannerQuotaWaits(): string {
  const fromPlannerEnv = process.env.PLANNER_OPENCODE_MAX_QUOTA_WAITS?.trim();
  if (fromPlannerEnv && /^-?\d+$/.test(fromPlannerEnv)) {
    return fromPlannerEnv;
  }
  return "0";
}

export function getResearchPlannerOpenCodeEnv(
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    OPENCODE_MAX_QUOTA_WAITS: resolvePlannerQuotaWaits(),
    OPENCODE_ECHO_STDOUT: "false",
    CLAUDE_CODE_ECHO_STDOUT: "false",
  };

  const plannerWaitOnQuota = process.env.PLANNER_OPENCODE_WAIT_ON_QUOTA?.trim();
  if (plannerWaitOnQuota) {
    env.OPENCODE_WAIT_ON_QUOTA = plannerWaitOnQuota;
  }

  const plannerQuotaRetryDelay = process.env.PLANNER_OPENCODE_QUOTA_RETRY_DELAY_MS?.trim();
  if (plannerQuotaRetryDelay && /^\d+$/.test(plannerQuotaRetryDelay)) {
    env.OPENCODE_QUOTA_RETRY_DELAY_MS = plannerQuotaRetryDelay;
  }

  const plannerEchoStdout = process.env.PLANNER_OPENCODE_ECHO_STDOUT?.trim();
  if (plannerEchoStdout) {
    env.OPENCODE_ECHO_STDOUT = plannerEchoStdout;
  }

  const plannerClaudeEchoStdout = process.env.PLANNER_CLAUDE_CODE_ECHO_STDOUT?.trim();
  if (plannerClaudeEchoStdout) {
    env.CLAUDE_CODE_ECHO_STDOUT = plannerClaudeEchoStdout;
  }

  return { ...env, ...extraEnv };
}
