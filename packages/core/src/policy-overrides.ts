import type { Policy } from "./domain/policy.js";
import { getRepoMode } from "./repo-mode.js";

export function applyRepoModePolicyOverrides(
  policy: Policy,
  env: NodeJS.ProcessEnv = process.env
): Policy {
  const repoMode = getRepoMode(env);
  if (repoMode !== "local") {
    return policy;
  }

  const maxLinesOverride = parseInt(env.LOCAL_POLICY_MAX_LINES ?? "", 10);
  const maxFilesOverride = parseInt(env.LOCAL_POLICY_MAX_FILES ?? "", 10);

  // local modeはローカル開発の試行錯誤を妨げないように上限を緩める
  return {
    ...policy,
    maxLinesChanged: Number.isFinite(maxLinesOverride)
      ? Math.max(policy.maxLinesChanged, maxLinesOverride)
      : Math.max(policy.maxLinesChanged, 5000),
    maxFilesChanged: Number.isFinite(maxFilesOverride)
      ? Math.max(policy.maxFilesChanged, maxFilesOverride)
      : Math.max(policy.maxFilesChanged, 100),
  };
}
