import type { Policy } from "./domain/policy.js";
import { getRepoMode } from "./repo-mode.js";

export function applyRepoModePolicyOverrides(
  policy: Policy,
  env: NodeJS.ProcessEnv = process.env
): Policy {
  const repoMode = getRepoMode(env);

  if (repoMode === "local") {
    // local modeはローカル開発の試行錯誤を妨げないように下限を保証する
    return {
      ...policy,
      maxLinesChanged: Math.max(policy.maxLinesChanged, 5000),
      maxFilesChanged: Math.max(policy.maxFilesChanged, 100),
    };
  }

  return policy;
}
