import { Octokit } from "@octokit/rest";

// GitHub APIクライアント
let octokitInstance: Octokit | null = null;

export function getOctokit(): Octokit {
  if (!octokitInstance) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN environment variable is not set");
    }

    octokitInstance = new Octokit({
      auth: token,
    });
  }

  return octokitInstance;
}

// リポジトリ情報を取得
export interface RepoInfo {
  owner: string;
  repo: string;
}

export function getRepoInfo(): RepoInfo {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;

  if (!owner || !repo) {
    throw new Error(
      "GITHUB_OWNER and GITHUB_REPO environment variables must be set"
    );
  }

  return { owner, repo };
}
