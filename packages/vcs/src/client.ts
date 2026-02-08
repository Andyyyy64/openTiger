import { Octokit } from "@octokit/rest";

// GitHub APIクライアント
let octokitInstance: Octokit | null = null;
let octokitToken: string | null = null;

export interface GitHubClientOptions {
  token?: string;
  owner?: string;
  repo?: string;
}

export function getOctokit(options: GitHubClientOptions = {}): Octokit {
  const token = options.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }

  // トークンが変わるケース（DB設定反映後など）ではクライアントを作り直す
  if (!octokitInstance || octokitToken !== token) {
    octokitInstance = new Octokit({
      auth: token,
    });
    octokitToken = token;
  }

  return octokitInstance;
}

// リポジトリ情報を取得
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
