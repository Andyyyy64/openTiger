import { Octokit } from "@octokit/rest";
import { spawnSync } from "node:child_process";

// GitHub API client
let octokitInstance: Octokit | null = null;
let octokitToken: string | null = null;

export type GitHubAuthMode = "gh" | "token";

export interface GitHubClientOptions {
  token?: string;
  authMode?: string;
  owner?: string;
  repo?: string;
}

type GitHubTokenResolveOptions = {
  token?: string;
  authMode?: string;
  env?: NodeJS.ProcessEnv;
};

function normalizeNonEmpty(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveGitHubAuthMode(rawValue: string | undefined): GitHubAuthMode {
  const value = rawValue?.trim().toLowerCase();
  return value === "token" ? "token" : "gh";
}

function resolveGhToken(env: NodeJS.ProcessEnv): string {
  const result = spawnSync("gh", ["auth", "token"], {
    env,
    encoding: "utf-8",
  });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new Error(
        "GitHub auth mode is 'gh' but GitHub CLI is not installed. Install `gh` from https://cli.github.com/ and run `gh auth login`.",
      );
    }
    throw new Error(`Failed to execute \`gh auth token\`: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `GitHub auth mode is 'gh' but no authenticated session was found. Run \`gh auth login\`${detail ? ` (${detail})` : ""}.`,
    );
  }
  const token = normalizeNonEmpty(result.stdout);
  if (!token) {
    throw new Error(
      "GitHub auth mode is 'gh' but `gh auth token` returned an empty value. Re-run `gh auth login`.",
    );
  }
  return token;
}

export function resolveGitHubToken(options: GitHubTokenResolveOptions = {}): string {
  const env = options.env ?? process.env;
  const mode = resolveGitHubAuthMode(options.authMode ?? env.GITHUB_AUTH_MODE);
  if (mode === "token") {
    const token = normalizeNonEmpty(options.token) ?? normalizeNonEmpty(env.GITHUB_TOKEN);
    if (!token) {
      throw new Error(
        "GitHub auth mode is 'token' but GITHUB_TOKEN is not set. Set GITHUB_TOKEN or switch GITHUB_AUTH_MODE to 'gh'.",
      );
    }
    return token;
  }
  return resolveGhToken(env);
}

export function getOctokit(options: GitHubClientOptions = {}): Octokit {
  const token = resolveGitHubToken({
    token: options.token,
    authMode: options.authMode,
  });

  // Recreate client when token changes (e.g. after DB config update)
  if (!octokitInstance || octokitToken !== token) {
    octokitInstance = new Octokit({
      auth: token,
    });
    octokitToken = token;
  }

  return octokitInstance;
}

// Get repo info
export interface RepoInfo {
  owner: string;
  repo: string;
}

export function getRepoInfo(options: GitHubClientOptions = {}): RepoInfo {
  const owner = options.owner ?? process.env.GITHUB_OWNER;
  const repo = options.repo ?? process.env.GITHUB_REPO;

  if (!owner || !repo) {
    throw new Error("GITHUB_OWNER and GITHUB_REPO environment variables must be set");
  }

  return { owner, repo };
}
