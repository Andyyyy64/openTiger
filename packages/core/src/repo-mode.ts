export type RepoMode = "git" | "local";

export function resolveRepoMode(value?: string): RepoMode {
  return value === "local" ? "local" : "git";
}

export function getRepoMode(
  env: NodeJS.ProcessEnv = process.env
): RepoMode {
  return resolveRepoMode(env.REPO_MODE);
}

export function getLocalRepoPath(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const value = env.LOCAL_REPO_PATH;
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getLocalWorktreeRoot(
  env: NodeJS.ProcessEnv = process.env
): string {
  const value = env.LOCAL_WORKTREE_ROOT?.trim();
  return value && value.length > 0 ? value : "/tmp/openTiger-worktree";
}
