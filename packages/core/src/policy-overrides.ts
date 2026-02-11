import type { Policy } from "./domain/policy";
import { getRepoMode } from "./repo-mode";

export function applyRepoModePolicyOverrides(
  policy: Policy,
  env: NodeJS.ProcessEnv = process.env,
): Policy {
  const repoMode = getRepoMode(env);

  if (repoMode === "local") {
    // Ensure minimum limits so local mode does not hinder iteration during development
    return {
      ...policy,
      maxLinesChanged: Math.max(policy.maxLinesChanged, 5000),
      maxFilesChanged: Math.max(policy.maxFilesChanged, 100),
    };
  }

  return policy;
}
