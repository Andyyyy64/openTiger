import type { Policy } from "./domain/policy.js";
import { getRepoMode } from "./repo-mode.js";

export function applyRepoModePolicyOverrides(
  policy: Policy,
  env: NodeJS.ProcessEnv = process.env
): Policy {
  const repoMode = getRepoMode(env);

  // 環境変数による明示的なオーバーライドはモードを問わず適用する
  const maxLinesOverride = parseInt(env.LOCAL_POLICY_MAX_LINES ?? "", 10);
  const maxFilesOverride = parseInt(env.LOCAL_POLICY_MAX_FILES ?? "", 10);

  const overridden = {
    ...policy,
    maxLinesChanged: Number.isFinite(maxLinesOverride)
      ? maxLinesOverride
      : policy.maxLinesChanged,
    maxFilesChanged: Number.isFinite(maxFilesOverride)
      ? maxFilesOverride
      : policy.maxFilesChanged,
  };

  if (repoMode === "local") {
    // local modeはローカル開発の試行錯誤を妨げないように下限を保証する
    return {
      ...overridden,
      maxLinesChanged: Math.max(overridden.maxLinesChanged, 5000),
      maxFilesChanged: Math.max(overridden.maxFilesChanged, 100),
    };
  }

  return overridden;
}
