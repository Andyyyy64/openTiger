import { getOctokit, getRepoInfo } from "./client";

export interface CreateIssueOptions {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

export interface IssueInfo {
  number: number;
  url: string;
  title: string;
  state: string;
}

// Plannerが生成したタスクをIssue化するためのAPIをまとめる
export async function createIssue(options: CreateIssueOptions): Promise<IssueInfo> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  const response = await octokit.issues.create({
    owner,
    repo,
    title: options.title,
    body: options.body,
    labels: options.labels,
    assignees: options.assignees,
  });

  return {
    number: response.data.number,
    url: response.data.html_url,
    title: response.data.title,
    state: response.data.state,
  };
}

// Issueに関連情報を追記する
export async function addIssueComment(issueNumber: number, body: string): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = getRepoInfo();

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}
