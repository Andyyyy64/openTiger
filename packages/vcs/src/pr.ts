import { getOctokit, getRepoInfo } from "./client";

// PR検索オプション
export interface SearchPROptions {
  head?: string;
  base?: string;
  state?: "open" | "closed" | "all";
}

// PR作成オプション
export interface CreatePROptions {
  title: string;
  body: string;
  head: string; // ソースブランチ
  base?: string; // ターゲットブランチ（デフォルト: main）
  labels?: string[];
  draft?: boolean;
}

// PR情報
export interface PRInfo {
  number: number;
  url: string;
  title: string;
  state: string;
}

// PRを検索
export async function findPRs(options: SearchPROptions): Promise<PRInfo[]> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  const response = await octokit.pulls.list({
    owner,
    repo,
    head: options.head ? `${owner}:${options.head}` : undefined,
    base: options.base,
    state: options.state ?? "open",
  });

  return response.data.map((pr) => ({
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state,
  }));
}

// PRを更新
export async function updatePR(
  prNumber: number,
  options: Partial<CreatePROptions>,
): Promise<PRInfo> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  const response = await octokit.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    title: options.title,
    body: options.body,
    state: "open",
  });

  // ラベルを更新（既存のラベルに追加）
  if (options.labels && options.labels.length > 0) {
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: prNumber,
      labels: options.labels,
    });
  }

  return {
    number: response.data.number,
    url: response.data.html_url,
    title: response.data.title,
    state: response.data.state,
  };
}

// PRを作成
export async function createPR(options: CreatePROptions): Promise<PRInfo> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  const response = await octokit.pulls.create({
    owner,
    repo,
    title: options.title,
    body: options.body,
    head: options.head,
    base: options.base ?? "main",
    draft: options.draft ?? false,
  });

  // ラベルを追加
  if (options.labels && options.labels.length > 0) {
    await octokit.issues.addLabels({
      owner,
      repo,
      issue_number: response.data.number,
      labels: options.labels,
    });
  }

  return {
    number: response.data.number,
    url: response.data.html_url,
    title: response.data.title,
    state: response.data.state,
  };
}

// PRにコメントを追加
export async function addPRComment(prNumber: number, body: string): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

// PRをマージ
export async function mergePR(
  prNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
): Promise<boolean> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  try {
    await octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: mergeMethod,
    });
    return true;
  } catch (error) {
    console.error(`Failed to merge PR #${prNumber}:`, error);
    return false;
  }
}

// PRを閉じる
export async function closePR(prNumber: number): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  await octokit.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    state: "closed",
  });
}

// PRのCIステータスを取得
export async function getPRCIStatus(prNumber: number): Promise<"success" | "failure" | "pending"> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  // PRの情報を取得
  const pr = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  // コミットのステータスを取得
  const status = await octokit.repos.getCombinedStatusForRef({
    owner,
    repo,
    ref: pr.data.head.sha,
  });

  switch (status.data.state) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    default:
      return "pending";
  }
}
