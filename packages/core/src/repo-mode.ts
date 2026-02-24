export type RepoMode = "github" | "local-git" | "direct";

export function resolveRepoMode(value?: string): RepoMode {
  // Backward compatibility: map legacy values
  if (value === "git" || value === "github") return "github";
  if (value === "local" || value === "local-git") return "local-git";
  if (value === "direct") return "direct";
  return "github";
}

export function isDirectMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return getRepoMode(env) === "direct";
}

export function requiresGit(mode: RepoMode): boolean {
  return mode !== "direct";
}

export function getRepoMode(env: NodeJS.ProcessEnv = process.env): RepoMode {
  return resolveRepoMode(env.REPO_MODE);
}

export function getLocalRepoPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.LOCAL_REPO_PATH;
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getLocalWorktreeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.LOCAL_WORKTREE_ROOT?.trim();
  return value && value.length > 0 ? value : "/tmp/openTiger-worktree";
}
