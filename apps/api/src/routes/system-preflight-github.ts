import { getOctokit, getRepoInfo } from "@openTiger/vcs";
import { config as configTable } from "@openTiger/db/schema";
import { parseLinkedIssueNumbersFromPr } from "./system-issue-utils.js";

export type GitHubContext = {
  token: string;
  owner: string;
  repo: string;
};

type ConfigRow = typeof configTable.$inferSelect;

export type OpenIssueSnapshot = {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
};

export type OpenPrSnapshot = {
  count: number;
  linkedIssueNumbers: Set<number>;
  openPulls: Array<{
    number: number;
    title: string;
    body: string;
    url: string;
  }>;
};

export function resolveGitHubContext(configRow: ConfigRow): GitHubContext | null {
  const token = configRow.githubToken?.trim();
  const owner = configRow.githubOwner?.trim();
  const repo = configRow.githubRepo?.trim();
  if (!token || !owner || !repo) {
    return null;
  }
  return { token, owner, repo };
}

export async function fetchOpenIssues(context: GitHubContext): Promise<OpenIssueSnapshot[]> {
  const octokit = getOctokit({ token: context.token });
  const { owner, repo } = getRepoInfo({
    owner: context.owner,
    repo: context.repo,
  });

  const rows = await octokit.paginate(octokit.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  return rows
    .filter((row) => !row.pull_request)
    .map((row) => ({
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      url: row.html_url,
      labels: row.labels
        .map((label) =>
          typeof label === "string" ? label : (label.name ?? "")
        )
        .filter((label): label is string => label.length > 0),
    }));
}

export async function fetchOpenPrCount(context: GitHubContext): Promise<OpenPrSnapshot> {
  const octokit = getOctokit({ token: context.token });
  const { owner, repo } = getRepoInfo({
    owner: context.owner,
    repo: context.repo,
  });
  const rows = await octokit.paginate(octokit.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
  });

  const linkedIssueNumbers = new Set<number>();
  for (const row of rows) {
    const title = row.title ?? "";
    const body = row.body ?? "";
    for (const issueNumber of parseLinkedIssueNumbersFromPr(title, body)) {
      linkedIssueNumbers.add(issueNumber);
    }
  }

  return {
    count: rows.length,
    linkedIssueNumbers,
    openPulls: rows.map((row) => ({
      number: row.number,
      title: row.title ?? "",
      body: row.body ?? "",
      url: row.html_url,
    })),
  };
}
